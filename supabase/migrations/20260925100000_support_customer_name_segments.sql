-- Customer name parts can contain space-separated words, hyphens, and straight
-- or typographic apostrophes. Keep the same rule in public booking and admin
-- edits so a valid customer booking remains editable later.
CREATE OR REPLACE FUNCTION public.is_valid_customer_name_part(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT btrim(p_name) ~ '^[[:alpha:]]+(([[:space:]]+|[-''’])[[:alpha:]]+)*$';
$$;

CREATE OR REPLACE FUNCTION public.create_booking_atomic(
  p_reference_code text, p_booking_request_id uuid, p_customer_name text,
  p_phone text, p_moto_brand text, p_moto_model text, p_moto_variant text,
  p_moto_year integer, p_plate_number text, p_appointment_date date,
  p_start_time time, p_notes text, p_total_estimate numeric,
  p_booking_duration_minutes integer, p_assigned_crew_id uuid, p_services jsonb,
  p_continuation_segments jsonb, p_notification_title text, p_notification_message text,
  p_first_name text, p_middle_name text, p_last_name text
)
RETURNS TABLE (appointment_id uuid, reference_code text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE v_appointment_id uuid; v_reference_code text;
BEGIN
  IF p_booking_request_id IS NULL THEN RAISE EXCEPTION 'A booking request ID is required.'; END IF;
  IF NOT public.is_valid_customer_name_part(p_first_name)
     OR NOT public.is_valid_customer_name_part(p_last_name) THEN
    RAISE EXCEPTION 'First and last names must contain letters, spaces, hyphens, or apostrophes only.';
  END IF;
  IF COALESCE(btrim(p_middle_name), '') <> ''
     AND NOT public.is_valid_customer_name_part(p_middle_name) THEN
    RAISE EXCEPTION 'Middle name must contain letters, spaces, hyphens, or apostrophes only.';
  END IF;
  IF jsonb_typeof(p_services) <> 'array' OR jsonb_array_length(p_services) = 0 THEN
    RAISE EXCEPTION 'A booking must include at least one service.';
  END IF;
  IF jsonb_typeof(COALESCE(p_continuation_segments, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Continuation segments must be an array.';
  END IF;

  INSERT INTO public.appointments (
    reference_code, booking_request_id, customer_name, first_name, middle_name,
    last_name, phone, moto_brand, moto_model, moto_variant, moto_year,
    plate_number, appointment_date, start_time, notes, total_estimate,
    booking_duration_minutes, terms_accepted, assigned_crew_id
  ) VALUES (
    p_reference_code, p_booking_request_id,
    concat_ws(' ', btrim(p_first_name), NULLIF(btrim(p_middle_name), ''), btrim(p_last_name)),
    btrim(p_first_name), NULLIF(btrim(p_middle_name), ''), btrim(p_last_name), p_phone,
    p_moto_brand, p_moto_model, p_moto_variant, p_moto_year, p_plate_number,
    p_appointment_date, p_start_time, p_notes, p_total_estimate,
    p_booking_duration_minutes, true, p_assigned_crew_id
  ) ON CONFLICT DO NOTHING
  RETURNING appointments.id, appointments.reference_code INTO v_appointment_id, v_reference_code;

  IF v_appointment_id IS NULL THEN
    SELECT appointments.id, appointments.reference_code INTO v_appointment_id, v_reference_code
    FROM public.appointments WHERE appointments.booking_request_id = p_booking_request_id;
    IF FOUND THEN RETURN QUERY SELECT v_appointment_id, v_reference_code; RETURN; END IF;
    RAISE EXCEPTION 'The requested schedule is no longer available.' USING ERRCODE = '23P01';
  END IF;

  INSERT INTO public.appointment_services (appointment_id, service_id, service_name, price, duration_minutes)
  SELECT v_appointment_id, service.service_id, service.service_name, service.price, service.duration_minutes
  FROM jsonb_to_recordset(p_services) AS service(
    service_id uuid, service_name text, price numeric, duration_minutes integer
  );

  INSERT INTO public.appointment_continuations (
    appointment_id, segment_number, appointment_date, start_time,
    booking_duration_minutes, assigned_crew_id
  )
  SELECT v_appointment_id, segment.segment_number, segment.appointment_date, segment.start_time,
    segment.booking_duration_minutes, segment.assigned_crew_id
  FROM jsonb_to_recordset(COALESCE(p_continuation_segments, '[]'::jsonb)) AS segment(
    segment_number integer, appointment_date date, start_time time,
    booking_duration_minutes integer, assigned_crew_id uuid
  );

  INSERT INTO public.notifications (type, title, message, appointment_id)
  VALUES ('new_appointment', p_notification_title, p_notification_message, v_appointment_id);
  RETURN QUERY SELECT v_appointment_id, v_reference_code;
END;
$$;

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
  IF NOT public.is_valid_customer_name_part(p_first_name)
     OR NOT public.is_valid_customer_name_part(p_last_name) THEN
    RAISE EXCEPTION 'First and last names must contain letters, spaces, hyphens, or apostrophes only.';
  END IF;

  IF COALESCE(btrim(p_middle_name), '') <> ''
     AND NOT public.is_valid_customer_name_part(p_middle_name) THEN
    RAISE EXCEPTION 'Middle name must contain letters, spaces, hyphens, or apostrophes only.';
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
