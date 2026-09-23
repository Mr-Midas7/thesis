-- Keep administrative appointment edits consistent with public booking:
-- middle names are optional and mobile numbers are stored in canonical E.164 form.

DROP FUNCTION IF EXISTS public.update_appointment_details_atomic(
  uuid, uuid[], date, time, uuid, boolean, text, text, text, text, text
);

CREATE FUNCTION public.update_appointment_details_atomic(
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

  IF COALESCE(btrim(p_phone), '') !~ '^\+639[0-9]{9}$' THEN
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
