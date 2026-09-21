-- Keep archived records recoverable for 30 days, then remove them permanently.
-- Catalog tables already record archive timestamps; the remaining archive types
-- need the same timestamp so the retention rule is based on the archive event.
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE public.crew_members
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE public.schedule_blocks
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE public.blocked_numbers
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Older records did not retain the moment they were archived. Start their
-- 30-day recovery period when this policy is enabled rather than deleting them
-- sooner based on an unrelated created/updated timestamp.
UPDATE public.appointments
SET archived_at = now()
WHERE is_archived = true
  AND archived_at IS NULL;

UPDATE public.crew_members
SET archived_at = now()
WHERE is_archived = true
  AND archived_at IS NULL;

UPDATE public.schedule_blocks
SET archived_at = now()
WHERE is_active = false
  AND archived_at IS NULL;

UPDATE public.blocked_numbers
SET archived_at = now()
WHERE is_archived = true
  AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS appointments_archived_retention_idx
  ON public.appointments (archived_at)
  WHERE is_archived = true;

CREATE INDEX IF NOT EXISTS services_archived_retention_idx
  ON public.services (archived_at)
  WHERE is_archived = true;

CREATE INDEX IF NOT EXISTS products_archived_retention_idx
  ON public.products (archived_at)
  WHERE is_archived = true;

CREATE INDEX IF NOT EXISTS motorcycle_catalog_archived_retention_idx
  ON public.motorcycle_catalog (archived_at)
  WHERE is_archived = true;

CREATE INDEX IF NOT EXISTS crew_members_archived_retention_idx
  ON public.crew_members (archived_at)
  WHERE is_archived = true;

CREATE INDEX IF NOT EXISTS schedule_blocks_archived_retention_idx
  ON public.schedule_blocks (archived_at)
  WHERE is_active = false;

CREATE INDEX IF NOT EXISTS blocked_numbers_archived_retention_idx
  ON public.blocked_numbers (archived_at)
  WHERE is_archived = true;

-- Reuse the catalog archive timestamp trigger for archive types that use
-- is_archived. The function also clears the timestamp when a record is
-- restored, giving a later archive a fresh 30-day retention window.
DROP TRIGGER IF EXISTS appointments_archive_timestamp ON public.appointments;
CREATE TRIGGER appointments_archive_timestamp
  BEFORE UPDATE OF is_archived ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.set_catalog_archive_timestamp();

DROP TRIGGER IF EXISTS crew_members_archive_timestamp ON public.crew_members;
CREATE TRIGGER crew_members_archive_timestamp
  BEFORE UPDATE OF is_archived ON public.crew_members
  FOR EACH ROW EXECUTE FUNCTION public.set_catalog_archive_timestamp();

DROP TRIGGER IF EXISTS blocked_numbers_archive_timestamp ON public.blocked_numbers;
CREATE TRIGGER blocked_numbers_archive_timestamp
  BEFORE UPDATE OF is_archived ON public.blocked_numbers
  FOR EACH ROW EXECUTE FUNCTION public.set_catalog_archive_timestamp();

CREATE OR REPLACE FUNCTION public.set_schedule_block_archive_timestamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active = false AND OLD.is_active = true THEN
    NEW.archived_at = now();
  ELSIF NEW.is_active = true AND OLD.is_active = false THEN
    NEW.archived_at = NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS schedule_blocks_archive_timestamp ON public.schedule_blocks;
CREATE TRIGGER schedule_blocks_archive_timestamp
  BEFORE UPDATE OF is_active ON public.schedule_blocks
  FOR EACH ROW EXECUTE FUNCTION public.set_schedule_block_archive_timestamp();

CREATE OR REPLACE FUNCTION public.purge_expired_archived_records()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.appointments
  WHERE is_archived = true
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.services
  WHERE is_archived = true
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.products
  WHERE is_archived = true
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.motorcycle_catalog
  WHERE is_archived = true
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.crew_members
  WHERE is_archived = true
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.schedule_blocks
  WHERE is_active = false
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.blocked_numbers
  WHERE is_archived = true
    AND archived_at < now() - interval '30 days';
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_archived_records() FROM PUBLIC;

-- Run the cleanup once per day. The guard retains compatibility with local
-- Supabase environments where pg_cron is not installed or not available.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'purge-expired-archives';

    PERFORM cron.schedule(
      'purge-expired-archives',
      '30 0 * * *',
      'SELECT public.purge_expired_archived_records();'
    );
  END IF;
EXCEPTION
  WHEN undefined_function OR undefined_table OR insufficient_privilege THEN
    RAISE NOTICE 'pg_cron unavailable; archive retention must be run by an external scheduler.';
END;
$$;
