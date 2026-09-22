-- A multi-day service remains one customer appointment, while each later work
-- period has its own reservation so it participates in capacity calculations.
CREATE TABLE IF NOT EXISTS public.appointment_continuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  segment_number integer NOT NULL CHECK (segment_number > 0),
  appointment_date date NOT NULL,
  start_time time NOT NULL,
  booking_duration_minutes integer NOT NULL CHECK (booking_duration_minutes > 0),
  assigned_crew_id uuid NOT NULL REFERENCES public.crew_members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, segment_number)
);

CREATE INDEX IF NOT EXISTS appointment_continuations_schedule_idx
  ON public.appointment_continuations (appointment_date, start_time);

CREATE INDEX IF NOT EXISTS appointment_continuations_crew_schedule_idx
  ON public.appointment_continuations (assigned_crew_id, appointment_date, start_time);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointment_continuations TO authenticated;
GRANT ALL ON public.appointment_continuations TO service_role;
ALTER TABLE public.appointment_continuations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "appointment continuations admin all" ON public.appointment_continuations;
CREATE POLICY "appointment continuations admin all"
  ON public.appointment_continuations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.enforce_active_appointment_continuation_capacity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_parent public.appointments%ROWTYPE;
  v_opening_time time;
  v_closing_time time;
  v_opening_minutes integer;
  v_closing_minutes integer;
  v_start_minutes integer;
  v_hour_start time;
  v_capacity integer;
  v_overlapping_reservations integer;
BEGIN
  SELECT * INTO v_parent FROM public.appointments WHERE id = NEW.appointment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The parent appointment no longer exists.' USING ERRCODE = '23503';
  END IF;

  -- A cancelled, archived, or replaced appointment releases every later-day
  -- reservation without destroying the audit trail.
  IF v_parent.is_archived = true
     OR v_parent.rescheduled_to_appointment_id IS NOT NULL
     OR v_parent.status NOT IN ('pending', 'confirmed', 'in_progress', 'rescheduled') THEN
    RETURN NEW;
  END IF;

  SELECT opening_time, closing_time INTO v_opening_time, v_closing_time
  FROM public.shop_settings WHERE id = true;
  v_opening_time := COALESCE(v_opening_time, '08:00:00'::time);
  v_closing_time := COALESCE(v_closing_time, '17:00:00'::time);
  v_opening_minutes := extract(hour FROM v_opening_time)::integer * 60
    + extract(minute FROM v_opening_time)::integer;
  v_closing_minutes := extract(hour FROM v_closing_time)::integer * 60
    + extract(minute FROM v_closing_time)::integer;
  v_start_minutes := extract(hour FROM NEW.start_time)::integer * 60
    + extract(minute FROM NEW.start_time)::integer;

  IF extract(dow FROM NEW.appointment_date) = 0
     OR v_start_minutes < v_opening_minutes
     OR v_start_minutes >= v_closing_minutes
     OR mod(v_start_minutes - v_opening_minutes, 30) <> 0
     OR v_start_minutes + NEW.booking_duration_minutes > v_closing_minutes THEN
    RAISE EXCEPTION 'The continuation must fit within the configured shop hours in 30-minute start intervals.'
      USING ERRCODE = '23P01';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.crew_members AS crew
    JOIN public.crew_schedules AS schedule ON schedule.crew_id = crew.id
    WHERE crew.id = NEW.assigned_crew_id
      AND crew.is_active = true
      AND crew.is_archived = false
      AND schedule.schedule_date = NEW.appointment_date
      AND schedule.is_working = true
      AND schedule.start_time <= NEW.start_time
      AND schedule.end_time >= NEW.start_time + make_interval(mins => NEW.booking_duration_minutes)
  ) THEN
    RAISE EXCEPTION 'No mechanic is available for the continuation schedule.' USING ERRCODE = '23P01';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.crew_availability_exceptions AS exception
    WHERE exception.crew_id = NEW.assigned_crew_id
      AND exception.start_date <= NEW.appointment_date
      AND exception.end_date >= NEW.appointment_date
      AND (
        exception.is_all_day
        OR (
          exception.start_time IS NOT NULL
          AND exception.end_time IS NOT NULL
          AND tsrange(
            NEW.appointment_date + NEW.start_time,
            NEW.appointment_date + NEW.start_time
              + make_interval(mins => NEW.booking_duration_minutes),
            '[)'
          ) && tsrange(
            NEW.appointment_date + exception.start_time,
            NEW.appointment_date + exception.end_time,
            '[)'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'The assigned mechanic is unavailable for the continuation schedule.'
      USING ERRCODE = '23P01';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.schedule_blocks AS block
    WHERE block.block_date = NEW.appointment_date
      AND block.is_active = true
      AND (
        block.start_time IS NULL
        OR (
          COALESCE(block.reason, '') NOT LIKE 'RANGE:%'
          AND block.start_time = NEW.start_time
        )
        OR (
          COALESCE(block.reason, '') LIKE 'RANGE:%'
          AND tsrange(
            NEW.appointment_date + NEW.start_time,
            NEW.appointment_date + NEW.start_time
              + make_interval(mins => NEW.booking_duration_minutes),
            '[)'
          ) && tsrange(
            NEW.appointment_date + block.start_time,
            NEW.appointment_date
              + substring(block.reason FROM '^RANGE:([0-9]{2}:[0-9]{2})')::time,
            '[)'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'The shop is closed for the continuation schedule.' USING ERRCODE = '23P01';
  END IF;

  v_hour_start := make_time(extract(hour FROM NEW.start_time)::integer, 0, 0);
  PERFORM pg_advisory_xact_lock(hashtext('booking-capacity:' || NEW.appointment_date::text));

  SELECT slot.capacity INTO v_capacity
  FROM public.time_slots AS slot
  WHERE slot.is_active = true
    AND (slot.start_time = NEW.start_time OR slot.start_time = v_hour_start)
  ORDER BY (slot.start_time = NEW.start_time) DESC
  LIMIT 1
  FOR UPDATE;

  IF COALESCE(v_capacity, 0) <= 0 THEN
    RAISE EXCEPTION 'The requested continuation time slot is not available.' USING ERRCODE = '23P01';
  END IF;

  SELECT count(*) INTO v_overlapping_reservations
  FROM (
    SELECT appointment.assigned_crew_id, appointment.appointment_date, appointment.start_time,
      appointment.booking_duration_minutes
    FROM public.appointments AS appointment
    WHERE appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
      AND appointment.appointment_date = NEW.appointment_date
    UNION ALL
    SELECT continuation.assigned_crew_id, continuation.appointment_date, continuation.start_time,
      continuation.booking_duration_minutes
    FROM public.appointment_continuations AS continuation
    JOIN public.appointments AS appointment ON appointment.id = continuation.appointment_id
    WHERE continuation.id <> NEW.id
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
      AND continuation.appointment_date = NEW.appointment_date
  ) AS reservation
  WHERE tsrange(
    reservation.appointment_date + reservation.start_time,
    reservation.appointment_date + reservation.start_time
      + make_interval(mins => reservation.booking_duration_minutes),
    '[)'
  ) && tsrange(
    NEW.appointment_date + NEW.start_time,
    NEW.appointment_date + NEW.start_time + make_interval(mins => NEW.booking_duration_minutes),
    '[)'
  );

  IF v_overlapping_reservations >= v_capacity THEN
    RAISE EXCEPTION 'The requested continuation schedule is no longer available.' USING ERRCODE = '23P01';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.appointments AS appointment
    WHERE appointment.assigned_crew_id = NEW.assigned_crew_id
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
      AND appointment.appointment_date = NEW.appointment_date
      AND tsrange(
        appointment.appointment_date + appointment.start_time,
        appointment.appointment_date + appointment.start_time
          + make_interval(mins => appointment.booking_duration_minutes),
        '[)'
      ) && tsrange(
        NEW.appointment_date + NEW.start_time,
        NEW.appointment_date + NEW.start_time
          + make_interval(mins => NEW.booking_duration_minutes),
        '[)'
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.appointment_continuations AS continuation
    JOIN public.appointments AS appointment ON appointment.id = continuation.appointment_id
    WHERE continuation.id <> NEW.id
      AND continuation.assigned_crew_id = NEW.assigned_crew_id
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
      AND continuation.appointment_date = NEW.appointment_date
      AND tsrange(
        continuation.appointment_date + continuation.start_time,
        continuation.appointment_date + continuation.start_time
          + make_interval(mins => continuation.booking_duration_minutes),
        '[)'
      ) && tsrange(
        NEW.appointment_date + NEW.start_time,
        NEW.appointment_date + NEW.start_time
          + make_interval(mins => NEW.booking_duration_minutes),
        '[)'
      )
  ) THEN
    RAISE EXCEPTION 'The assigned mechanic is no longer available for the continuation schedule.'
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointment_continuations_enforce_active_capacity
  ON public.appointment_continuations;
CREATE TRIGGER appointment_continuations_enforce_active_capacity
  BEFORE INSERT OR UPDATE OF appointment_date, start_time, booking_duration_minutes, assigned_crew_id
  ON public.appointment_continuations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_active_appointment_continuation_capacity();

-- Existing single-day appointments must also see continuation reservations when
-- checking capacity, otherwise a later booking could overlap a carried-forward
-- work period.
CREATE OR REPLACE FUNCTION public.enforce_active_appointment_capacity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_capacity integer;
  v_overlapping_appointments integer;
  v_start_minutes integer;
  v_opening_minutes integer;
  v_closing_minutes integer;
  v_hour_start time;
  v_opening_time time;
  v_closing_time time;
BEGIN
  IF NEW.is_archived = true
     OR NEW.rescheduled_to_appointment_id IS NOT NULL
     OR NEW.status NOT IN ('pending', 'confirmed', 'in_progress', 'rescheduled') THEN
    RETURN NEW;
  END IF;

  SELECT opening_time, closing_time INTO v_opening_time, v_closing_time
  FROM public.shop_settings WHERE id = true;
  v_opening_time := COALESCE(v_opening_time, '08:00:00'::time);
  v_closing_time := COALESCE(v_closing_time, '17:00:00'::time);
  v_opening_minutes := extract(hour FROM v_opening_time)::integer * 60
    + extract(minute FROM v_opening_time)::integer;
  v_closing_minutes := extract(hour FROM v_closing_time)::integer * 60
    + extract(minute FROM v_closing_time)::integer;
  v_start_minutes := extract(hour FROM NEW.start_time)::integer * 60
    + extract(minute FROM NEW.start_time)::integer;

  IF v_start_minutes < v_opening_minutes
     OR v_start_minutes >= v_closing_minutes
     OR mod(v_start_minutes - v_opening_minutes, 30) <> 0
     OR v_start_minutes + NEW.booking_duration_minutes > v_closing_minutes THEN
    RAISE EXCEPTION 'The appointment must fit within the configured shop hours in 30-minute start intervals.'
      USING ERRCODE = '23P01';
  END IF;

  v_hour_start := make_time(extract(hour FROM NEW.start_time)::integer, 0, 0);
  PERFORM pg_advisory_xact_lock(hashtext('booking-capacity:' || NEW.appointment_date::text));

  SELECT slot.capacity INTO v_capacity
  FROM public.time_slots AS slot
  WHERE slot.is_active = true
    AND (slot.start_time = NEW.start_time OR slot.start_time = v_hour_start)
  ORDER BY (slot.start_time = NEW.start_time) DESC
  LIMIT 1 FOR UPDATE;

  IF COALESCE(v_capacity, 0) <= 0 THEN
    RAISE EXCEPTION 'The requested time slot is not available.' USING ERRCODE = '23P01';
  END IF;

  SELECT count(*) INTO v_overlapping_appointments
  FROM (
    SELECT appointment.appointment_date, appointment.start_time, appointment.booking_duration_minutes
    FROM public.appointments AS appointment
    WHERE appointment.id <> NEW.id
      AND appointment.appointment_date = NEW.appointment_date
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
    UNION ALL
    SELECT continuation.appointment_date, continuation.start_time, continuation.booking_duration_minutes
    FROM public.appointment_continuations AS continuation
    JOIN public.appointments AS appointment ON appointment.id = continuation.appointment_id
    WHERE continuation.appointment_date = NEW.appointment_date
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
  ) AS reservation
  WHERE tsrange(
    reservation.appointment_date + reservation.start_time,
    reservation.appointment_date + reservation.start_time
      + make_interval(mins => reservation.booking_duration_minutes),
    '[)'
  ) && tsrange(
    NEW.appointment_date + NEW.start_time,
    NEW.appointment_date + NEW.start_time + make_interval(mins => NEW.booking_duration_minutes),
    '[)'
  );

  IF v_overlapping_appointments >= v_capacity THEN
    RAISE EXCEPTION 'The requested schedule is no longer available.' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.create_booking_atomic(
  text, uuid, text, text, text, text, text, integer, text, date, time, text,
  numeric, integer, uuid, jsonb, text, text, text, text, text
);

CREATE FUNCTION public.create_booking_atomic(
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
  IF COALESCE(btrim(p_first_name), '') !~ '^[[:alpha:]]+( [[:alpha:]]+)*$'
     OR COALESCE(btrim(p_last_name), '') !~ '^[[:alpha:]]+( [[:alpha:]]+)*$' THEN
    RAISE EXCEPTION 'First and last names must contain letters only.';
  END IF;
  IF COALESCE(btrim(p_middle_name), '') <> ''
     AND btrim(p_middle_name) !~ '^[[:alpha:]]+( [[:alpha:]]+)*$' THEN
    RAISE EXCEPTION 'Middle name must contain letters only.';
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

REVOKE ALL ON FUNCTION public.create_booking_atomic(
  text, uuid, text, text, text, text, text, integer, text, date, time, text,
  numeric, integer, uuid, jsonb, jsonb, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_booking_atomic(
  text, uuid, text, text, text, text, text, integer, text, date, time, text,
  numeric, integer, uuid, jsonb, jsonb, text, text, text, text, text
) TO service_role;
