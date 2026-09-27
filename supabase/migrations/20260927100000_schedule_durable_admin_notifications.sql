-- Make service-progress notifications durable background work. Booking and
-- reschedule notifications are already created by their database transactions;
-- this scheduler covers due arrival and completion alerts when no admin is
-- signed in. Unread notifications are never automatically resolved.

DROP TRIGGER IF EXISTS appointments_resolve_service_progress_notifications ON public.appointments;

CREATE OR REPLACE FUNCTION public.enqueue_due_service_progress_notifications()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_created integer := 0;
  v_now timestamptz := now();
BEGIN
  -- Lock appointments before their notification rows so a concurrent admin
  -- action wins without producing a stale or duplicate alert.
  WITH due_appointments AS (
    SELECT appointment.id, appointment.reference_code, appointment.customer_name
    FROM public.appointments AS appointment
    JOIN LATERAL (
      SELECT sum(service.duration_minutes)::integer AS service_duration_minutes
      FROM public.appointment_services AS service
      WHERE service.appointment_id = appointment.id
    ) AS service_duration ON service_duration.service_duration_minutes > 0
    WHERE appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status = 'confirmed'
      AND appointment.service_started_at IS NULL
      AND (appointment.appointment_date + appointment.start_time) AT TIME ZONE 'Asia/Manila' <= v_now
      AND COALESCE(appointment.arrival_notification_snoozed_until, v_now) <= v_now
      AND NOT EXISTS (
        SELECT 1
        FROM public.notifications AS notification
        WHERE notification.appointment_id = appointment.id
          AND notification.type = 'service_arrival'
          AND notification.is_read = false
      )
    FOR UPDATE OF appointment SKIP LOCKED
  ),
  inserted AS (
    INSERT INTO public.notifications (type, title, message, appointment_id)
    SELECT
      'service_arrival',
      'Customer expected: ' || due.reference_code,
      due.customer_name || ' is scheduled to arrive for service now.',
      due.id
    FROM due_appointments AS due
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM inserted;

  WITH due_appointments AS (
    SELECT appointment.id, appointment.reference_code, appointment.customer_name
    FROM public.appointments AS appointment
    JOIN LATERAL (
      SELECT sum(service.duration_minutes)::integer AS service_duration_minutes
      FROM public.appointment_services AS service
      WHERE service.appointment_id = appointment.id
    ) AS service_duration ON service_duration.service_duration_minutes > 0
    WHERE appointment.is_archived = false
      AND appointment.status = 'in_progress'
      AND appointment.service_started_at IS NOT NULL
      AND appointment.service_ended_at IS NULL
      AND appointment.service_started_at
        + make_interval(mins => service_duration.service_duration_minutes) <= v_now
      AND COALESCE(appointment.completion_notification_snoozed_until, v_now) <= v_now
      AND NOT EXISTS (
        SELECT 1
        FROM public.notifications AS notification
        WHERE notification.appointment_id = appointment.id
          AND notification.type = 'service_completion'
          AND notification.is_read = false
      )
    FOR UPDATE OF appointment SKIP LOCKED
  ),
  inserted AS (
    INSERT INTO public.notifications (type, title, message, appointment_id)
    SELECT
      'service_completion',
      'Service duration ended: ' || due.reference_code,
      'The expected service duration for ' || due.customer_name || ' has ended.',
      due.id
    FROM due_appointments AS due
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT v_created + count(*) INTO v_created FROM inserted;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_due_service_progress_notifications() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_due_service_progress_notifications() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_due_service_progress_notifications() TO service_role;

-- Keep the existing admin RPC as an immediate, authenticated catch-up path;
-- the background job uses the private function above while admins are away.
CREATE OR REPLACE FUNCTION public.sync_service_progress_notifications()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can synchronize service progress notifications.';
  END IF;

  RETURN public.enqueue_due_service_progress_notifications();
END;
$$;

REVOKE ALL ON FUNCTION public.sync_service_progress_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_service_progress_notifications() TO authenticated;

-- Mark an alert read only inside the explicit workflow action that handles it.
-- Status changes from other workflows leave untouched notification records
-- intact rather than dismissing them automatically.
CREATE OR REPLACE FUNCTION public.manage_appointment_service_progress(
  p_appointment_id uuid,
  p_action text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_appointment public.appointments%ROWTYPE;
  v_action text := lower(btrim(COALESCE(p_action, '')));
  v_snooze_interval interval := interval '5 minutes';
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can update service progress.';
  END IF;

  IF v_action NOT IN (
    'start', 'snooze_arrival', 'no_show', 'complete', 'snooze_completion'
  ) THEN
    RAISE EXCEPTION 'Choose a valid service progress action.';
  END IF;

  SELECT appointment.*
    INTO v_appointment
  FROM public.appointments AS appointment
  WHERE appointment.id = p_appointment_id
    AND appointment.is_archived = false
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This appointment is no longer available.';
  END IF;

  IF v_action = 'start' THEN
    IF v_appointment.status NOT IN ('pending', 'confirmed')
       OR v_appointment.service_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'This appointment cannot be started.';
    END IF;

    UPDATE public.appointments
    SET status = 'in_progress',
        service_started_at = COALESCE(service_started_at, now()),
        service_ended_at = NULL,
        arrival_notification_snoozed_until = NULL
    WHERE id = v_appointment.id;

    UPDATE public.notifications
    SET is_read = true
    WHERE appointment_id = v_appointment.id
      AND type = 'service_arrival'
      AND is_read = false;

  ELSIF v_action = 'snooze_arrival' THEN
    IF v_appointment.status <> 'confirmed' OR v_appointment.service_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'This arrival reminder is no longer available.';
    END IF;
    IF v_appointment.arrival_notification_snooze_count >= 3 THEN
      RAISE EXCEPTION 'The maximum of three arrival snoozes has been reached.';
    END IF;

    UPDATE public.appointments
    SET arrival_notification_snooze_count = arrival_notification_snooze_count + 1,
        arrival_notification_snoozed_until = now() + v_snooze_interval
    WHERE id = v_appointment.id;

    UPDATE public.notifications
    SET is_read = true
    WHERE appointment_id = v_appointment.id
      AND type = 'service_arrival'
      AND is_read = false;

  ELSIF v_action = 'no_show' THEN
    IF v_appointment.status <> 'confirmed' OR v_appointment.service_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'This appointment cannot be marked as no-show.';
    END IF;
    IF v_appointment.arrival_notification_snooze_count < 3 THEN
      RAISE EXCEPTION 'The appointment can be marked as no-show after three arrival snoozes.';
    END IF;

    UPDATE public.appointments
    SET status = 'no_show',
        arrival_notification_snoozed_until = NULL
    WHERE id = v_appointment.id;

    UPDATE public.notifications
    SET is_read = true
    WHERE appointment_id = v_appointment.id
      AND type = 'service_arrival'
      AND is_read = false;

  ELSIF v_action = 'complete' THEN
    IF v_appointment.status <> 'in_progress'
       OR v_appointment.service_started_at IS NULL
       OR v_appointment.service_ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'This service cannot be marked as completed.';
    END IF;

    UPDATE public.appointments
    SET status = 'completed',
        service_ended_at = COALESCE(service_ended_at, now()),
        completion_notification_snoozed_until = NULL
    WHERE id = v_appointment.id;

    UPDATE public.notifications
    SET is_read = true
    WHERE appointment_id = v_appointment.id
      AND type = 'service_completion'
      AND is_read = false;

  ELSE
    IF v_appointment.status <> 'in_progress'
       OR v_appointment.service_started_at IS NULL
       OR v_appointment.service_ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'This completion reminder is no longer available.';
    END IF;

    UPDATE public.appointments
    SET completion_notification_snoozed_until = now() + v_snooze_interval
    WHERE id = v_appointment.id;

    UPDATE public.notifications
    SET is_read = true
    WHERE appointment_id = v_appointment.id
      AND type = 'service_completion'
      AND is_read = false;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.manage_appointment_service_progress(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manage_appointment_service_progress(uuid, text) TO authenticated;

-- pg_cron runs in the database, independently of browser sessions. Enable the
-- supported extension and replace any prior job so this remains idempotent.
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'enqueue-due-service-progress-notifications';

  PERFORM cron.schedule(
    'enqueue-due-service-progress-notifications',
    '* * * * *',
    'SELECT public.enqueue_due_service_progress_notifications();'
  );
END;
$$;
