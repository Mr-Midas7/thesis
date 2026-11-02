-- Appointment reminders, and a scheduled run that sends them and retries
-- customer texts and emails that failed.
--
-- Every 5 minutes pg_cron asks the site to do this work by posting to the
-- address in the Vault secret scheduled_notifications_url, with the Vault
-- secret scheduled_notifications_secret as a bearer token. The site compares
-- it with its SCHEDULED_NOTIFICATIONS_SECRET. Until both secrets are saved,
-- nothing is posted and the admin is told the run is not set up.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- One row per appointment and channel, like appointment_completion_notifications.
CREATE TABLE IF NOT EXISTS public.appointment_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'skipped')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, channel)
);

-- Only the server, with the service role, reads and writes reminders.
ALTER TABLE public.appointment_reminders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.appointment_reminders FROM anon, authenticated;

-- When the scheduled run last started and finished, so a stopped run is noticed.
CREATE TABLE IF NOT EXISTS public.scheduled_notification_runs (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_error text
);

ALTER TABLE public.scheduled_notification_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.scheduled_notification_runs FROM anon, authenticated;

-- Counting from now gives a newly set up run 30 minutes before it is reported
-- as stopped.
INSERT INTO public.scheduled_notification_runs (id, last_finished_at)
VALUES (true, now())
ON CONFLICT (id) DO NOTHING;

-- Queues a reminder for each confirmed appointment that starts within the
-- reminder window set in Settings. Appointments confirmed in the last 12 hours
-- are left out: their confirmation message has the same details.
CREATE OR REPLACE FUNCTION public.queue_due_appointment_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_hours integer;
  v_queued integer;
BEGIN
  SELECT notify_reminder, reminder_hours_before
    INTO v_enabled, v_hours
  FROM public.shop_settings
  WHERE id;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN 0;
  END IF;

  WITH due AS (
    SELECT a.id, a.email, a.phone
    FROM public.appointments a
    WHERE a.status = 'confirmed'
      AND NOT a.is_archived
      AND (a.appointment_date + a.start_time) AT TIME ZONE 'Asia/Manila' > now()
      AND (a.appointment_date + a.start_time) AT TIME ZONE 'Asia/Manila'
        <= now() + make_interval(hours => v_hours)
      AND NOT EXISTS (
        SELECT 1
        FROM public.appointment_confirmation_emails c
        WHERE c.appointment_id = a.id
          AND c.created_at > now() - interval '12 hours'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.appointment_confirmation_sms c
        WHERE c.appointment_id = a.id
          AND c.created_at > now() - interval '12 hours'
      )
  )
  INSERT INTO public.appointment_reminders (appointment_id, channel, recipient)
  SELECT id, 'email', lower(btrim(email)) FROM due WHERE NULLIF(btrim(email), '') IS NOT NULL
  UNION ALL
  SELECT id, 'sms', phone FROM due WHERE NULLIF(btrim(phone), '') IS NOT NULL
  ON CONFLICT (appointment_id, channel) DO NOTHING;

  GET DIAGNOSTICS v_queued = ROW_COUNT;
  RETURN v_queued;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_due_appointment_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_due_appointment_reminders() TO service_role;

-- Asks the site to send due reminders and retry failed customer messages.
CREATE OR REPLACE FUNCTION public.request_scheduled_notifications()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets
  WHERE name = 'scheduled_notifications_url';
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'scheduled_notifications_secret';
  IF NULLIF(v_url, '') IS NULL OR NULLIF(v_secret, '') IS NULL THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_scheduled_notifications() FROM PUBLIC, anon, authenticated;

-- Tells the admin when the scheduled run is not set up or has stopped, with at
-- most one unread alert at a time.
CREATE OR REPLACE FUNCTION public.alert_if_scheduled_notifications_stopped()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_configured boolean;
  v_last_finished timestamptz;
BEGIN
  SELECT last_finished_at INTO v_last_finished
  FROM public.scheduled_notification_runs
  WHERE id;
  IF v_last_finished > now() - interval '30 minutes' THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.notifications
    WHERE type = 'scheduled_notifications_stopped'
      AND NOT is_read
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) = 2 INTO v_configured
  FROM vault.decrypted_secrets
  WHERE name IN ('scheduled_notifications_url', 'scheduled_notifications_secret')
    AND NULLIF(decrypted_secret, '') IS NOT NULL;

  INSERT INTO public.notifications (type, title, message)
  VALUES (
    'scheduled_notifications_stopped',
    CASE
      WHEN v_configured THEN 'Automatic reminders and retries have stopped'
      ELSE 'Automatic reminders and retries are not set up'
    END,
    CASE
      WHEN v_configured THEN
        'They last finished '
          || COALESCE(
            to_char(v_last_finished AT TIME ZONE 'Asia/Manila', 'Mon FMDD, YYYY FMHH12:MI AM'),
            'never'
          )
          || '. Appointment reminders are not being sent and failed customer texts and emails '
          || 'are not being retried. Check that the site is online and that its '
          || 'SCHEDULED_NOTIFICATIONS_SECRET matches the one saved in the database.'
      ELSE
        'Appointment reminders are not being sent and failed customer texts and emails are not '
          || 'being retried until the site address and secret for scheduled notifications are '
          || 'saved in the database.'
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.alert_if_scheduled_notifications_stopped() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname IN ('request-scheduled-notifications', 'alert-stopped-scheduled-notifications');

  PERFORM cron.schedule(
    'request-scheduled-notifications',
    '*/5 * * * *',
    'SELECT public.request_scheduled_notifications();'
  );
  PERFORM cron.schedule(
    'alert-stopped-scheduled-notifications',
    '*/15 * * * *',
    'SELECT public.alert_if_scheduled_notifications_stopped();'
  );
END;
$$;
