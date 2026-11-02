-- Run after loading the live data into the offline copy. Adds what a data copy
-- leaves out: the image buckets with the live rules (migrations 20260821161200
-- and 20260906120000), the scheduled jobs (20260927100000, 20261015100000 and
-- 20261026110000), where the scheduled notifications run calls, and the
-- offline-only tables and job that send offline bookings to the live site.
-- Safe to run again.

INSERT INTO storage.buckets (id, name, public)
VALUES ('products', 'products', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('shop-assets', 'shop-assets', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "products admin upload" ON storage.objects;
CREATE POLICY "products admin upload" ON storage.objects
FOR INSERT TO authenticated WITH CHECK (bucket_id = 'products' AND public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "products admin update" ON storage.objects;
CREATE POLICY "products admin update" ON storage.objects
FOR UPDATE TO authenticated USING (bucket_id = 'products' AND public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "products admin delete" ON storage.objects;
CREATE POLICY "products admin delete" ON storage.objects
FOR DELETE TO authenticated USING (bucket_id = 'products' AND public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "products public read" ON storage.objects;
CREATE POLICY "products public read" ON storage.objects
FOR SELECT TO anon, authenticated USING (bucket_id = 'products');

DROP POLICY IF EXISTS "shop assets public read" ON storage.objects;
CREATE POLICY "shop assets public read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'shop-assets');

DROP POLICY IF EXISTS "shop assets admin insert" ON storage.objects;
CREATE POLICY "shop assets admin insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'shop-assets' AND public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "shop assets admin update" ON storage.objects;
CREATE POLICY "shop assets admin update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'shop-assets' AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (bucket_id = 'shop-assets' AND public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "shop assets admin delete" ON storage.objects;
CREATE POLICY "shop assets admin delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'shop-assets' AND public.has_role(auth.uid(), 'admin'));

-- Scheduled jobs. pg_cron runs in UTC: 16:15 and 16:30 UTC are 12:15 AM and
-- 12:30 AM Philippine time.
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname IN (
    'enqueue-due-service-progress-notifications',
    'purge-admin-activity-logs',
    'purge-expired-archives',
    'request-scheduled-notifications',
    'alert-stopped-scheduled-notifications'
  );

  PERFORM cron.schedule(
    'enqueue-due-service-progress-notifications',
    '* * * * *',
    'SELECT public.enqueue_due_service_progress_notifications();'
  );
  PERFORM cron.schedule(
    'purge-admin-activity-logs',
    '15 16 * * *',
    'SELECT public.purge_expired_admin_activity_logs();'
  );
  PERFORM cron.schedule(
    'purge-expired-archives',
    '30 16 * * *',
    'SELECT public.purge_expired_archived_records();'
  );
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

-- Where the scheduled notifications run calls: the offline app on this laptop,
-- which Docker reaches as host.docker.internal. The secret must match
-- SCHEDULED_NOTIFICATIONS_SECRET in .env.offline. It only guards the offline
-- copy, so a fixed value is fine here; the live site uses its own secret.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
DECLARE
  v_secret record;
  v_id uuid;
BEGIN
  FOR v_secret IN
    SELECT *
    FROM (
      VALUES
        ('scheduled_notifications_url', 'http://host.docker.internal:4000/api/scheduled-notifications'),
        ('scheduled_notifications_secret', 'offline-copy-scheduled-notifications')
    ) AS secrets (name, value)
  LOOP
    SELECT id INTO v_id FROM vault.secrets WHERE name = v_secret.name;
    IF v_id IS NULL THEN
      PERFORM vault.create_secret(v_secret.value, v_secret.name);
    ELSE
      PERFORM vault.update_secret(v_id, v_secret.value);
    END IF;
  END LOOP;
END;
$$;

-- Sending offline bookings to the live site (src/lib/offline-sync.server.ts).
-- These tables exist only in the offline copy, never on the live site.

-- Which offline bookings were handled: added on the live site, or reported to
-- the admin because they no longer fit there.
CREATE TABLE IF NOT EXISTS public.offline_booking_uploads (
  appointment_id uuid PRIMARY KEY REFERENCES public.appointments(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('uploaded', 'conflict')),
  live_appointment_id uuid,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The latest internet check, which every page shows.
CREATE TABLE IF NOT EXISTS public.offline_sync_status (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  online boolean NOT NULL DEFAULT false,
  checked_at timestamptz,
  online_since timestamptz,
  waiting integer NOT NULL DEFAULT 0,
  last_error text
);

ALTER TABLE public.offline_booking_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offline_sync_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.offline_booking_uploads FROM anon, authenticated;
REVOKE ALL ON TABLE public.offline_sync_status FROM anon, authenticated;
INSERT INTO public.offline_sync_status (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Every minute, ask the offline app to check the internet and send offline
-- bookings. The app ignores it unless OFFLINE_SYNC_TO_LIVE=1.
CREATE OR REPLACE FUNCTION public.request_offline_sync()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT replace(decrypted_secret, '/api/scheduled-notifications', '/api/offline-sync')
    INTO v_url
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

REVOKE ALL ON FUNCTION public.request_offline_sync() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'request-offline-sync';
  PERFORM cron.schedule('request-offline-sync', '* * * * *', 'SELECT public.request_offline_sync();');
END;
$$;
