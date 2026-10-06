-- A reservation now covers only the selected service work. The old 30-minute
-- arrival/post-service buffer is no longer part of its persisted duration.
ALTER TABLE public.appointments
  ALTER COLUMN booking_duration_minutes SET DEFAULT 60;

ALTER TABLE public.shop_settings
  ALTER COLUMN default_appointment_duration_minutes SET DEFAULT 60;

-- The prior default represented a 60-minute service plus the removed buffer.
-- Leave any administrator-selected value alone.
UPDATE public.shop_settings
SET default_appointment_duration_minutes = 60
WHERE default_appointment_duration_minutes = 90;

COMMENT ON COLUMN public.appointments.booking_duration_minutes IS
  'Total duration of the selected service work, without an arrival or post-service buffer.';

-- Preserve historical records, but release the buffer from upcoming active
-- reservations. Snapshot service durations are used so later catalog edits do
-- not alter an appointment that has already been booked. These updates only
-- shrink reservations, so bypass revalidation against any subsequently changed
-- slot configuration while the persisted values are normalized.
ALTER TABLE public.appointments DISABLE TRIGGER appointments_enforce_active_capacity;
ALTER TABLE public.appointment_continuations
  DISABLE TRIGGER appointment_continuations_enforce_active_capacity;

WITH service_totals AS (
  SELECT appointment_id, SUM(duration_minutes)::integer AS duration_minutes
  FROM public.appointment_services
  GROUP BY appointment_id
)
UPDATE public.appointments AS appointment
SET booking_duration_minutes = service_totals.duration_minutes
FROM service_totals
WHERE appointment.id = service_totals.appointment_id
  AND appointment.appointment_date >= CURRENT_DATE
  AND appointment.is_archived = false
  AND appointment.rescheduled_to_appointment_id IS NULL
  AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
  AND NOT EXISTS (
    SELECT 1
    FROM public.appointment_continuations AS continuation
    WHERE continuation.appointment_id = appointment.id
  );

-- Multi-day reservations already split all service time before the trailing
-- post-service buffer. Removing the final 30 minutes preserves the first-day
-- and intermediate service segments while releasing the buffer at the end.
WITH final_continuations AS (
  SELECT DISTINCT ON (continuation.appointment_id)
    continuation.id,
    continuation.booking_duration_minutes
  FROM public.appointment_continuations AS continuation
  JOIN public.appointments AS appointment ON appointment.id = continuation.appointment_id
  WHERE appointment.appointment_date >= CURRENT_DATE
    AND appointment.is_archived = false
    AND appointment.rescheduled_to_appointment_id IS NULL
    AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
  ORDER BY continuation.appointment_id, continuation.segment_number DESC
)
UPDATE public.appointment_continuations AS continuation
SET booking_duration_minutes = final_continuations.booking_duration_minutes - 30
FROM final_continuations
WHERE continuation.id = final_continuations.id
  AND final_continuations.booking_duration_minutes > 30;

-- The normalization updates can queue deferred appointment triggers. Flush
-- them before changing trigger state; PostgreSQL otherwise rejects ALTER TABLE
-- with pending trigger events in this migration transaction.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE public.appointment_continuations
  ENABLE TRIGGER appointment_continuations_enforce_active_capacity;
ALTER TABLE public.appointments ENABLE TRIGGER appointments_enforce_active_capacity;

-- The database must perform the same final staffing checks as the application
-- so concurrent writes cannot assign one mechanic to two overlapping jobs.
-- Keep the database callers on this one predicate; the TypeScript equivalent
-- is evaluateCrewAvailability in src/lib/availability.ts.
CREATE OR REPLACE FUNCTION public.is_crew_available_for_appointment(
  p_crew_id uuid,
  p_appointment_date date,
  p_start_time time,
  p_duration_minutes integer,
  p_excluded_appointment_id uuid DEFAULT NULL,
  p_excluded_continuation_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT p_duration_minutes > 0
    AND EXISTS (
      SELECT 1
      FROM public.crew_members AS crew
      JOIN public.crew_schedules AS schedule ON schedule.crew_id = crew.id
      WHERE crew.id = p_crew_id
        AND crew.is_active = true
        AND crew.is_archived = false
        AND schedule.schedule_date = p_appointment_date
        AND schedule.is_working = true
        AND schedule.start_time IS NOT NULL
        AND schedule.end_time IS NOT NULL
        AND schedule.start_time <= p_start_time
        AND schedule.end_time >= p_start_time + make_interval(mins => p_duration_minutes)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.crew_availability_exceptions AS exception
      WHERE exception.crew_id = p_crew_id
        AND exception.start_date <= p_appointment_date
        AND exception.end_date >= p_appointment_date
        AND (
          exception.is_all_day = true
          OR (
            exception.start_time IS NOT NULL
            AND exception.end_time IS NOT NULL
            AND tsrange(
              p_appointment_date + p_start_time,
              p_appointment_date + p_start_time + make_interval(mins => p_duration_minutes),
              '[)'
            ) && tsrange(
              p_appointment_date + exception.start_time,
              p_appointment_date + exception.end_time,
              '[)'
            )
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.appointments AS appointment
      WHERE (p_excluded_appointment_id IS NULL OR appointment.id <> p_excluded_appointment_id)
        AND appointment.assigned_crew_id = p_crew_id
        AND appointment.appointment_date = p_appointment_date
        AND appointment.is_archived = false
        AND appointment.rescheduled_to_appointment_id IS NULL
        AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
        AND tsrange(
          appointment.appointment_date + appointment.start_time,
          appointment.appointment_date + appointment.start_time
            + make_interval(mins => appointment.booking_duration_minutes),
          '[)'
        ) && tsrange(
          p_appointment_date + p_start_time,
          p_appointment_date + p_start_time + make_interval(mins => p_duration_minutes),
          '[)'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.appointment_continuations AS continuation
      JOIN public.appointments AS appointment ON appointment.id = continuation.appointment_id
      WHERE (p_excluded_continuation_id IS NULL OR continuation.id <> p_excluded_continuation_id)
        AND continuation.assigned_crew_id = p_crew_id
        AND continuation.appointment_date = p_appointment_date
        AND appointment.is_archived = false
        AND appointment.rescheduled_to_appointment_id IS NULL
        AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
        AND tsrange(
          continuation.appointment_date + continuation.start_time,
          continuation.appointment_date + continuation.start_time
            + make_interval(mins => continuation.booking_duration_minutes),
          '[)'
        ) && tsrange(
          p_appointment_date + p_start_time,
          p_appointment_date + p_start_time + make_interval(mins => p_duration_minutes),
          '[)'
        )
    );
$$;

-- Continuations use the same final crew predicate as primary appointments.
-- Their capacity and shop-block checks remain specific to continuation rows.
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
     OR NEW.booking_duration_minutes <= 0
     OR v_start_minutes < v_opening_minutes
     OR v_start_minutes >= v_closing_minutes
     OR mod(v_start_minutes - v_opening_minutes, 30) <> 0
     OR v_start_minutes + NEW.booking_duration_minutes > v_closing_minutes THEN
    RAISE EXCEPTION 'The continuation must fit within the configured shop hours in 30-minute start intervals.'
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

  PERFORM pg_advisory_xact_lock(hashtext('booking-capacity:' || NEW.appointment_date::text));
  v_hour_start := make_time(extract(hour FROM NEW.start_time)::integer, 0, 0);

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
    SELECT appointment.appointment_date, appointment.start_time, appointment.booking_duration_minutes
    FROM public.appointments AS appointment
    WHERE appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
      AND appointment.appointment_date = NEW.appointment_date
    UNION ALL
    SELECT continuation.appointment_date, continuation.start_time, continuation.booking_duration_minutes
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

  IF NOT public.is_crew_available_for_appointment(
    NEW.assigned_crew_id,
    NEW.appointment_date,
    NEW.start_time,
    NEW.booking_duration_minutes,
    NULL,
    NEW.id
  ) THEN
    RAISE EXCEPTION 'The assigned mechanic is no longer available for the continuation schedule.'
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

-- Keep administrative edits in sync with customer booking: the saved duration
-- and every crew/capacity validation now use only selected service durations.
CREATE OR REPLACE FUNCTION public.update_appointment_details_atomic(
  p_appointment_id uuid,
  p_service_ids uuid[],
  p_appointment_date date,
  p_start_time time,
  p_assigned_crew_id uuid,
  p_crew_assignment_manual boolean,
  p_status text,
  p_admin_notes text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_service_count integer;
  v_total_estimate numeric(10,2);
  v_duration_minutes integer;
  v_assigned_crew_id uuid := p_assigned_crew_id;
BEGIN
  IF COALESCE(cardinality(p_service_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one service.';
  END IF;

  IF p_status NOT IN (
    'pending', 'confirmed', 'in_progress', 'completed', 'rescheduled', 'cancelled', 'rejected', 'no_show'
  ) THEN
    RAISE EXCEPTION 'Choose a valid appointment status.';
  END IF;

  SELECT count(*)
    INTO v_service_count
  FROM public.services
  WHERE id = ANY(p_service_ids)
    AND is_active = true
    AND is_archived = false;

  IF v_service_count <> cardinality(p_service_ids) THEN
    RAISE EXCEPTION 'One or more selected services are no longer available.';
  END IF;

  SELECT
    COALESCE(sum(price), 0),
    COALESCE(sum(duration_minutes), 0)
  INTO v_total_estimate, v_duration_minutes
  FROM public.services
  WHERE id = ANY(p_service_ids);

  -- Serialize selection with other schedule writes for this date. The trigger
  -- below repeats the lock as the final guard for every write path.
  PERFORM pg_advisory_xact_lock(hashtext('booking-capacity:' || p_appointment_date::text));

  -- When confirming without a manual crew choice, select the first mechanic
  -- accepted by the common final-availability predicate.
  IF p_status = 'confirmed' AND v_assigned_crew_id IS NULL AND NOT p_crew_assignment_manual THEN
    SELECT crew.id
      INTO v_assigned_crew_id
    FROM public.crew_members AS crew
    WHERE crew.is_active = true
      AND crew.is_archived = false
      AND public.is_crew_available_for_appointment(
        crew.id,
        p_appointment_date,
        p_start_time,
        v_duration_minutes,
        p_appointment_id
      )
    ORDER BY crew.name, crew.id
    LIMIT 1;

    IF v_assigned_crew_id IS NULL THEN
      RAISE EXCEPTION 'No crew member is available for the selected appointment period.';
    END IF;
  END IF;

  -- Manual crew assignments use that same predicate.
  IF v_assigned_crew_id IS NOT NULL
     AND NOT public.is_crew_available_for_appointment(
       v_assigned_crew_id,
       p_appointment_date,
       p_start_time,
       v_duration_minutes,
       p_appointment_id
     ) THEN
    RAISE EXCEPTION 'Choose a crew member who is free for the full appointment period.';
  END IF;

  UPDATE public.appointments
  SET appointment_date = p_appointment_date,
      start_time = p_start_time,
      assigned_crew_id = v_assigned_crew_id,
      status = p_status,
      admin_notes = NULLIF(btrim(p_admin_notes), ''),
      total_estimate = v_total_estimate,
      booking_duration_minutes = v_duration_minutes
  WHERE id = p_appointment_id
    AND is_archived = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This appointment is no longer available.';
  END IF;

  DELETE FROM public.appointment_services
  WHERE appointment_id = p_appointment_id;

  INSERT INTO public.appointment_services (
    appointment_id,
    service_id,
    service_name,
    price,
    duration_minutes
  )
  SELECT
    p_appointment_id,
    service.id,
    service.name,
    service.price,
    service.duration_minutes
  FROM public.services AS service
  WHERE service.id = ANY(p_service_ids);
END;
$$;

-- The browser and server make an optimistic availability decision. This
-- trigger is the transaction-safe final guard: it serializes schedule writes
-- for a date and prevents one crew member from being assigned to overlapping
-- appointment or continuation work, even when slot capacity is greater than
-- one or two requests arrive at the same time.
CREATE OR REPLACE FUNCTION public.enforce_active_appointment_crew_conflict()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.is_archived = true
     OR NEW.rescheduled_to_appointment_id IS NOT NULL
     OR NEW.assigned_crew_id IS NULL
     OR NEW.status NOT IN ('pending', 'confirmed', 'in_progress', 'rescheduled') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('booking-capacity:' || NEW.appointment_date::text));

  IF NOT public.is_crew_available_for_appointment(
    NEW.assigned_crew_id,
    NEW.appointment_date,
    NEW.start_time,
    NEW.booking_duration_minutes,
    NEW.id
  ) THEN
    RAISE EXCEPTION 'The assigned mechanic is no longer available for the requested schedule.'
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_enforce_active_crew_conflict ON public.appointments;
CREATE TRIGGER appointments_enforce_active_crew_conflict
  BEFORE INSERT OR UPDATE OF
    appointment_date,
    start_time,
    booking_duration_minutes,
    assigned_crew_id,
    status,
    is_archived,
    rescheduled_to_appointment_id
  ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_active_appointment_crew_conflict();

NOTIFY pgrst, 'reload schema';
