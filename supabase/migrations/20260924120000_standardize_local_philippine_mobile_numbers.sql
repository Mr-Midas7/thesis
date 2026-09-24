-- Application phone values are always stored and compared as local Philippine
-- mobile numbers (09XXXXXXXXX). International formatting belongs only at a
-- future Supabase Auth phone-auth boundary, never in application records.

CREATE OR REPLACE FUNCTION public.normalize_philippine_mobile(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT CASE
    WHEN value.digits ~ '^09[0-9]{9}$' THEN value.digits
    WHEN value.digits ~ '^639[0-9]{9}$' THEN '0' || substring(value.digits FROM 3)
    ELSE NULL
  END
  FROM (SELECT regexp_replace(p_phone, '[^0-9]', '', 'g') AS digits) AS value;
$$;

-- The previous constraints required +639XXXXXXXXX. Remove them before
-- migrating recognized historical values back to the application format.
ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_phone_e164_check;
ALTER TABLE public.blocked_numbers
  DROP CONSTRAINT IF EXISTS blocked_numbers_phone_e164_check;

-- NOT VALID retains access to any irrecoverable historical values while every
-- new insert or phone update is enforced in the local format.
ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_phone_local_check
  CHECK (phone ~ '^09[0-9]{9}$') NOT VALID;
ALTER TABLE public.blocked_numbers
  ADD CONSTRAINT blocked_numbers_phone_local_check
  CHECK (phone ~ '^09[0-9]{9}$') NOT VALID;
ALTER TABLE public.crew_members
  ADD CONSTRAINT crew_members_phone_local_check
  CHECK (phone IS NULL OR phone ~ '^09[0-9]{9}$') NOT VALID;

-- Keep direct database writes aligned with the application normalizer as a
-- final integrity boundary. Existing +639 values are accepted only to be
-- converted before the local-format constraints run.
CREATE OR REPLACE FUNCTION public.normalize_philippine_mobile_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.phone IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.phone := public.normalize_philippine_mobile(NEW.phone);
  IF NEW.phone IS NULL THEN
    RAISE EXCEPTION 'Enter a valid Philippine mobile number.' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_appointment_phone_before_write ON public.appointments;
CREATE TRIGGER normalize_appointment_phone_before_write
  BEFORE INSERT OR UPDATE OF phone ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.normalize_philippine_mobile_before_write();

DROP TRIGGER IF EXISTS normalize_blocked_number_phone_before_write ON public.blocked_numbers;
CREATE TRIGGER normalize_blocked_number_phone_before_write
  BEFORE INSERT OR UPDATE OF phone ON public.blocked_numbers
  FOR EACH ROW EXECUTE FUNCTION public.normalize_philippine_mobile_before_write();

DROP TRIGGER IF EXISTS normalize_crew_member_phone_before_write ON public.crew_members;
CREATE TRIGGER normalize_crew_member_phone_before_write
  BEFORE INSERT OR UPDATE OF phone ON public.crew_members
  FOR EACH ROW EXECUTE FUNCTION public.normalize_philippine_mobile_before_write();

-- The admin edit RPC receives the already-normalized client value, but keeps
-- the same database-side validation as public booking and other write paths.
CREATE OR REPLACE FUNCTION public.update_appointment_details_atomic(
  p_appointment_id uuid,
  p_service_ids uuid[],
  p_appointment_date date,
  p_start_time time,
  p_assigned_crew_id uuid,
  p_crew_assignment_manual boolean,
  p_status text,
  p_admin_notes text,
  p_first_name text,
  p_middle_name text,
  p_last_name text,
  p_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(btrim(p_first_name), '') !~ '^[[:alpha:]]+( [[:alpha:]]+)*$'
     OR COALESCE(btrim(p_last_name), '') !~ '^[[:alpha:]]+( [[:alpha:]]+)*$' THEN
    RAISE EXCEPTION 'First and last names must contain letters only.';
  END IF;

  IF COALESCE(btrim(p_middle_name), '') <> ''
     AND btrim(p_middle_name) !~ '^[[:alpha:]]+( [[:alpha:]]+)*$' THEN
    RAISE EXCEPTION 'Middle name must contain letters only.';
  END IF;

  IF COALESCE(btrim(p_phone), '') !~ '^09[0-9]{9}$' THEN
    RAISE EXCEPTION 'Enter a valid Philippine mobile number.';
  END IF;

  PERFORM public.update_appointment_details_atomic(
    p_appointment_id,
    p_service_ids,
    p_appointment_date,
    p_start_time,
    p_assigned_crew_id,
    p_crew_assignment_manual,
    p_status,
    p_admin_notes
  );

  UPDATE public.appointments
  SET first_name = btrim(p_first_name),
      middle_name = NULLIF(btrim(p_middle_name), ''),
      last_name = btrim(p_last_name),
      phone = btrim(p_phone),
      customer_name = concat_ws(
        ' ',
        btrim(p_first_name),
        NULLIF(btrim(p_middle_name), ''),
        btrim(p_last_name)
      )
  WHERE id = p_appointment_id
    AND is_archived = false;
END;
$$;

REVOKE ALL ON FUNCTION public.update_appointment_details_atomic(
  uuid, uuid[], date, time, uuid, boolean, text, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_appointment_details_atomic(
  uuid, uuid[], date, time, uuid, boolean, text, text, text, text, text, text
) TO authenticated;

-- These updates are deliberately last. Appointment updates queue existing
-- audit/updated-at trigger events, and PostgreSQL does not permit subsequent
-- table alterations while those events are pending in this transaction.
UPDATE public.appointments
SET phone = public.normalize_philippine_mobile(phone)
WHERE public.normalize_philippine_mobile(phone) IS NOT NULL
  AND phone IS DISTINCT FROM public.normalize_philippine_mobile(phone);

UPDATE public.blocked_numbers
SET phone = public.normalize_philippine_mobile(phone)
WHERE public.normalize_philippine_mobile(phone) IS NOT NULL
  AND phone IS DISTINCT FROM public.normalize_philippine_mobile(phone);

UPDATE public.crew_members
SET phone = public.normalize_philippine_mobile(phone)
WHERE phone IS NOT NULL
  AND public.normalize_philippine_mobile(phone) IS NOT NULL
  AND phone IS DISTINCT FROM public.normalize_philippine_mobile(phone);
