-- Motorcycle identity is limited to brand and model. Service price and duration
-- come from an exact model override when present, otherwise the service default.

DROP FUNCTION IF EXISTS public.create_booking_atomic(
  text, uuid, text, text, text, text, text, integer, text, text, text, integer,
  text, date, time, text, numeric, integer, uuid, jsonb, text, text, text, text, text
);

CREATE FUNCTION public.create_booking_atomic(
  p_reference_code text,
  p_booking_request_id uuid,
  p_customer_name text,
  p_phone text,
  p_email text,
  p_moto_brand text,
  p_moto_model text,
  p_moto_variant text,
  p_moto_year integer,
  p_plate_number text,
  p_appointment_date date,
  p_start_time time,
  p_notes text,
  p_total_estimate numeric,
  p_booking_duration_minutes integer,
  p_assigned_crew_id uuid,
  p_services jsonb,
  p_notification_title text,
  p_notification_message text,
  p_first_name text,
  p_middle_name text,
  p_last_name text
)
RETURNS TABLE (appointment_id uuid, reference_code text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_appointment_id uuid;
  v_reference_code text;
BEGIN
  IF p_booking_request_id IS NULL THEN
    RAISE EXCEPTION 'A booking request ID is required.';
  END IF;
  IF COALESCE(btrim(p_first_name), '') !~ '^[[:alpha:]]+( [[:alpha:]]+)*$'
     OR COALESCE(btrim(p_middle_name), '') !~ '^[[:alpha:]]+( [[:alpha:]]+)*$'
     OR COALESCE(btrim(p_last_name), '') !~ '^[[:alpha:]]+( [[:alpha:]]+)*$' THEN
    RAISE EXCEPTION 'First name, middle name, and last name must contain letters only.';
  END IF;
  IF jsonb_typeof(p_services) <> 'array' OR jsonb_array_length(p_services) = 0 THEN
    RAISE EXCEPTION 'A booking must include at least one service.';
  END IF;

  INSERT INTO public.appointments (
    reference_code, booking_request_id, customer_name, first_name, middle_name,
    last_name, phone, email, moto_brand, moto_model, moto_variant, moto_year,
    plate_number, appointment_date, start_time, notes, total_estimate,
    booking_duration_minutes, terms_accepted, assigned_crew_id
  ) VALUES (
    p_reference_code, p_booking_request_id,
    concat_ws(' ', btrim(p_first_name), btrim(p_middle_name), btrim(p_last_name)),
    btrim(p_first_name), btrim(p_middle_name), btrim(p_last_name), p_phone, p_email,
    p_moto_brand, p_moto_model, p_moto_variant, p_moto_year, p_plate_number,
    p_appointment_date, p_start_time, p_notes, p_total_estimate,
    p_booking_duration_minutes, true, p_assigned_crew_id
  )
  ON CONFLICT DO NOTHING
  RETURNING appointments.id, appointments.reference_code INTO v_appointment_id, v_reference_code;

  IF v_appointment_id IS NULL THEN
    SELECT appointments.id, appointments.reference_code
      INTO v_appointment_id, v_reference_code
    FROM public.appointments
    WHERE appointments.booking_request_id = p_booking_request_id;
    IF FOUND THEN
      RETURN QUERY SELECT v_appointment_id, v_reference_code;
      RETURN;
    END IF;
    RAISE EXCEPTION 'The requested schedule is no longer available.' USING ERRCODE = '23P01';
  END IF;

  INSERT INTO public.appointment_services (
    appointment_id, service_id, service_name, price, duration_minutes
  )
  SELECT v_appointment_id, service.service_id, service.service_name,
    service.price, service.duration_minutes
  FROM jsonb_to_recordset(p_services) AS service(
    service_id uuid, service_name text, price numeric, duration_minutes integer
  );

  INSERT INTO public.notifications (type, title, message, appointment_id)
  VALUES ('new_appointment', p_notification_title, p_notification_message, v_appointment_id);

  RETURN QUERY SELECT v_appointment_id, v_reference_code;
END;
$$;

REVOKE ALL ON FUNCTION public.create_booking_atomic(
  text, uuid, text, text, text, text, text, text, integer, text, date, time,
  text, numeric, integer, uuid, jsonb, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_booking_atomic(
  text, uuid, text, text, text, text, text, text, integer, text, date, time,
  text, numeric, integer, uuid, jsonb, text, text, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.review_reschedule_request(
  p_appointment_id uuid,
  p_decision text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_appointment public.appointments%ROWTYPE;
  v_assigned_crew_id uuid;
  v_duration_minutes integer;
  v_new_appointment_id uuid;
  v_new_reference_code text;
  v_reason text;
  v_original_shop_notes text;
  v_new_shop_notes text;
  v_reschedule_number integer;
  v_slot_capacity integer;
  v_overlapping_appointments integer;
  v_start_minutes integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can review reschedule requests.';
  END IF;
  IF lower(btrim(COALESCE(p_decision, ''))) NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'Choose either confirmed or rejected.';
  END IF;

  SELECT appointment.* INTO v_appointment
  FROM public.appointments AS appointment
  WHERE appointment.id = p_appointment_id AND appointment.is_archived = false
  FOR UPDATE;
  IF NOT FOUND OR v_appointment.pending_reschedule_request_id IS NULL THEN
    RAISE EXCEPTION 'This reschedule request is no longer available.';
  END IF;

  v_reschedule_number := v_appointment.reschedule_count + 1;
  IF lower(btrim(p_decision)) = 'rejected' THEN
    INSERT INTO public.appointment_reschedule_history (
      appointment_id, new_appointment_id, reschedule_number, from_date,
      from_start_time, to_date, to_start_time, reason, decision, approved_by
    ) VALUES (
      v_appointment.id, NULL, v_reschedule_number, v_appointment.appointment_date,
      v_appointment.start_time, v_appointment.pending_reschedule_date,
      v_appointment.pending_reschedule_start_time, btrim(v_appointment.pending_reschedule_reason),
      'rejected', auth.uid()
    );
    UPDATE public.appointments
    SET pending_reschedule_request_id = NULL,
        pending_reschedule_date = NULL,
        pending_reschedule_start_time = NULL,
        pending_reschedule_reference_code = NULL,
        pending_reschedule_reason = NULL
    WHERE id = v_appointment.id;
    RETURN;
  END IF;

  IF v_appointment.reschedule_count >= 3 THEN
    RAISE EXCEPTION 'This appointment has reached the maximum of 3 reschedules.';
  END IF;
  IF v_appointment.pending_reschedule_date IS NULL
     OR v_appointment.pending_reschedule_start_time IS NULL
     OR NULLIF(btrim(v_appointment.pending_reschedule_reason), '') IS NULL THEN
    RAISE EXCEPTION 'The reschedule request is missing its requested schedule or reason.';
  END IF;

  v_duration_minutes := COALESCE(v_appointment.booking_duration_minutes, 75);
  v_reason := btrim(v_appointment.pending_reschedule_reason);
  v_start_minutes := extract(hour FROM v_appointment.pending_reschedule_start_time)::integer * 60
    + extract(minute FROM v_appointment.pending_reschedule_start_time)::integer;
  IF extract(dow FROM v_appointment.pending_reschedule_date) = 0
     OR v_start_minutes < 480 OR v_start_minutes >= 1020
     OR mod(v_start_minutes - 480, 30) <> 0
     OR v_start_minutes + v_duration_minutes > 1020 THEN
    RAISE EXCEPTION 'The requested schedule is outside the shop booking hours.';
  END IF;

  SELECT public.booking_slot_capacity(v_appointment.pending_reschedule_start_time)
    INTO v_slot_capacity;
  IF COALESCE(v_slot_capacity, 0) <= 0 THEN
    RAISE EXCEPTION 'The requested time slot is no longer available.';
  END IF;

  SELECT count(*) INTO v_overlapping_appointments
  FROM public.appointments AS other
  WHERE other.id <> v_appointment.id
    AND other.appointment_date = v_appointment.pending_reschedule_date
    AND other.is_archived = false
    AND other.rescheduled_to_appointment_id IS NULL
    AND other.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
    AND tsrange(
      other.appointment_date + other.start_time,
      other.appointment_date + other.start_time
        + make_interval(mins => COALESCE(other.booking_duration_minutes, 75)), '[)'
    ) && tsrange(
      v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
      v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
        + make_interval(mins => v_duration_minutes), '[)'
    );
  IF v_overlapping_appointments >= v_slot_capacity THEN
    RAISE EXCEPTION 'The requested time is no longer available.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.schedule_blocks AS block
    WHERE block.block_date = v_appointment.pending_reschedule_date
      AND block.is_active = true
      AND (
        block.start_time IS NULL
        OR (COALESCE(block.reason, '') NOT LIKE 'RANGE:%'
          AND block.start_time = v_appointment.pending_reschedule_start_time)
        OR (COALESCE(block.reason, '') LIKE 'RANGE:%'
          AND tsrange(
            v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
            v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
              + make_interval(mins => v_duration_minutes), '[)'
          ) && tsrange(
            v_appointment.pending_reschedule_date + block.start_time,
            v_appointment.pending_reschedule_date
              + substring(block.reason FROM '^RANGE:([0-9]{2}:[0-9]{2})')::time, '[)'
          ))
      )
  ) THEN
    RAISE EXCEPTION 'The requested time is no longer available because the shop schedule is blocked.';
  END IF;

  SELECT crew.id INTO v_assigned_crew_id
  FROM public.crew_members AS crew
  WHERE crew.is_active = true AND crew.is_archived = false
    AND EXISTS (
      SELECT 1 FROM public.crew_schedules AS schedule
      WHERE schedule.crew_id = crew.id
        AND schedule.schedule_date = v_appointment.pending_reschedule_date
        AND schedule.is_working = true
        AND schedule.start_time IS NOT NULL AND schedule.end_time IS NOT NULL
        AND schedule.start_time <= v_appointment.pending_reschedule_start_time
        AND schedule.end_time >= v_appointment.pending_reschedule_start_time
          + make_interval(mins => v_duration_minutes)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.crew_availability_exceptions AS exception
      WHERE exception.crew_id = crew.id
        AND exception.start_date <= v_appointment.pending_reschedule_date
        AND exception.end_date >= v_appointment.pending_reschedule_date
        AND (
          exception.is_all_day
          OR (exception.start_time IS NOT NULL AND exception.end_time IS NOT NULL
            AND tsrange(
              v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
              v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
                + make_interval(mins => v_duration_minutes), '[)'
            ) && tsrange(
              v_appointment.pending_reschedule_date + exception.start_time,
              v_appointment.pending_reschedule_date + exception.end_time, '[)'
            ))
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.appointments AS other
      WHERE other.id <> v_appointment.id
        AND other.assigned_crew_id = crew.id
        AND other.appointment_date = v_appointment.pending_reschedule_date
        AND other.is_archived = false
        AND other.rescheduled_to_appointment_id IS NULL
        AND other.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
        AND tsrange(
          other.appointment_date + other.start_time,
          other.appointment_date + other.start_time
            + make_interval(mins => COALESCE(other.booking_duration_minutes, 75)), '[)'
        ) && tsrange(
          v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
          v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
            + make_interval(mins => v_duration_minutes), '[)'
        )
    )
  ORDER BY (crew.id = v_appointment.assigned_crew_id) DESC, crew.name, crew.id
  LIMIT 1;
  IF v_assigned_crew_id IS NULL THEN
    RAISE EXCEPTION 'No crew member is available for the requested appointment period.';
  END IF;

  v_new_reference_code := v_appointment.pending_reschedule_reference_code;
  IF v_new_reference_code IS NULL OR v_new_reference_code !~ '^FRM-[A-Z0-9]{6}$' THEN
    RAISE EXCEPTION 'The reschedule request is missing its replacement reference.';
  END IF;

  v_original_shop_notes := concat_ws(E'\n', NULLIF(btrim(v_appointment.admin_notes), ''),
    'Rescheduled to ' || v_new_reference_code, 'Reason for rescheduling: ' || v_reason);
  v_new_shop_notes := concat_ws(E'\n', 'Rescheduled from ' || v_appointment.reference_code,
    'Reason for rescheduling: ' || v_reason);

  INSERT INTO public.appointments AS replacement (
    reference_code, booking_request_id, customer_name, first_name, middle_name,
    last_name, phone, email, moto_brand, moto_model, moto_variant, moto_year,
    plate_number, appointment_date, start_time, status, notes, admin_notes,
    total_estimate, booking_duration_minutes, terms_accepted, assigned_crew_id,
    reschedule_count, rescheduled_from_appointment_id
  ) VALUES (
    v_new_reference_code, gen_random_uuid(), v_appointment.customer_name,
    v_appointment.first_name, v_appointment.middle_name, v_appointment.last_name,
    v_appointment.phone, v_appointment.email, v_appointment.moto_brand,
    v_appointment.moto_model, v_appointment.moto_variant, v_appointment.moto_year,
    v_appointment.plate_number, v_appointment.pending_reschedule_date,
    v_appointment.pending_reschedule_start_time, 'confirmed', v_appointment.notes,
    v_new_shop_notes, v_appointment.total_estimate, v_duration_minutes,
    v_appointment.terms_accepted, v_assigned_crew_id,
    v_appointment.reschedule_count + 1, v_appointment.id
  ) RETURNING replacement.id INTO v_new_appointment_id;

  INSERT INTO public.appointment_services (
    appointment_id, service_id, service_name, price, duration_minutes
  )
  SELECT v_new_appointment_id, service.service_id, service.service_name,
    service.price, service.duration_minutes
  FROM public.appointment_services AS service
  WHERE service.appointment_id = v_appointment.id;

  UPDATE public.appointments
  SET status = 'rescheduled', admin_notes = v_original_shop_notes,
      reschedule_count = v_appointment.reschedule_count + 1,
      rescheduled_to_appointment_id = v_new_appointment_id,
      pending_reschedule_request_id = NULL, pending_reschedule_date = NULL,
      pending_reschedule_start_time = NULL, pending_reschedule_reference_code = NULL,
      pending_reschedule_reason = NULL
  WHERE id = v_appointment.id;

  INSERT INTO public.notifications (type, title, message, appointment_id)
  VALUES (
    'rescheduled_appointment', 'Rescheduled booking ' || v_new_reference_code,
    v_appointment.customer_name || ' rescheduled from ' || v_appointment.reference_code
      || ' to ' || v_new_reference_code || '. Reason: ' || v_reason,
    v_new_appointment_id
  );
  INSERT INTO public.appointment_reschedule_history (
    appointment_id, new_appointment_id, reschedule_number, from_date,
    from_start_time, to_date, to_start_time, reason, decision, approved_by
  ) VALUES (
    v_appointment.id, v_new_appointment_id, v_reschedule_number,
    v_appointment.appointment_date, v_appointment.start_time,
    v_appointment.pending_reschedule_date, v_appointment.pending_reschedule_start_time,
    v_reason, 'confirmed', auth.uid()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_reschedule_request(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_reschedule_request(uuid, text) TO authenticated;

ALTER TABLE public.motorcycle_catalog
  DROP CONSTRAINT IF EXISTS motorcycle_catalog_engine_cc_positive,
  DROP CONSTRAINT IF EXISTS motorcycle_catalog_fuel_type_valid,
  DROP CONSTRAINT IF EXISTS motorcycle_catalog_transmission_valid,
  DROP COLUMN IF EXISTS engine_cc,
  DROP COLUMN IF EXISTS fuel_type,
  DROP COLUMN IF EXISTS transmission;

ALTER TABLE public.appointments
  DROP COLUMN IF EXISTS moto_cc,
  DROP COLUMN IF EXISTS moto_fuel_type,
  DROP COLUMN IF EXISTS moto_transmission;
