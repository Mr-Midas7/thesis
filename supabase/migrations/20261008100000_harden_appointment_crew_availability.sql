-- The booking page preflights availability for a fast response. This final
-- database guard keeps an appointment correct if two requests race each other
-- or a schedule is changed between the preflight and the insert.
CREATE OR REPLACE FUNCTION public.enforce_active_appointment_capacity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_capacity integer;
  v_overlapping_reservations integer;
  v_start_minutes integer;
  v_opening_minutes integer;
  v_closing_minutes integer;
  v_opening_time time;
  v_closing_time time;
  v_hour_start time;
BEGIN
  -- Archived, replaced, and terminal appointments release both their slot
  -- capacity and their crew assignment.
  IF NEW.is_archived = true
     OR NEW.rescheduled_to_appointment_id IS NOT NULL
     OR NEW.status NOT IN ('pending', 'confirmed', 'in_progress', 'rescheduled') THEN
    RETURN NEW;
  END IF;

  SELECT opening_time, closing_time
    INTO v_opening_time, v_closing_time
  FROM public.shop_settings
  WHERE id = true;
  v_opening_time := COALESCE(v_opening_time, '08:00:00'::time);
  v_closing_time := COALESCE(v_closing_time, '17:00:00'::time);
  v_opening_minutes := extract(hour FROM v_opening_time)::integer * 60
    + extract(minute FROM v_opening_time)::integer;
  v_closing_minutes := extract(hour FROM v_closing_time)::integer * 60
    + extract(minute FROM v_closing_time)::integer;
  v_start_minutes := extract(hour FROM NEW.start_time)::integer * 60
    + extract(minute FROM NEW.start_time)::integer;

  IF extract(dow FROM NEW.appointment_date) = 0
     OR NEW.booking_duration_minutes IS NULL
     OR NEW.booking_duration_minutes <= 0
     OR v_start_minutes < v_opening_minutes
     OR v_start_minutes >= v_closing_minutes
     OR mod(v_start_minutes - v_opening_minutes, 30) <> 0
     OR v_start_minutes + NEW.booking_duration_minutes > v_closing_minutes THEN
    RAISE EXCEPTION 'The appointment must fit within the configured shop hours on a Monday through Saturday.'
      USING ERRCODE = '23P01';
  END IF;

  -- Serialize every active reservation for one date. The lock is deliberately
  -- acquired before both capacity and crew-overlap checks, so a transaction
  -- that waited on it sees a previously committed reservation.
  PERFORM pg_advisory_xact_lock(hashtext('booking-capacity:' || NEW.appointment_date::text));

  v_hour_start := make_time(extract(hour FROM NEW.start_time)::integer, 0, 0);
  SELECT slot.capacity
    INTO v_capacity
  FROM public.time_slots AS slot
  WHERE slot.is_active = true
    AND (slot.start_time = NEW.start_time OR slot.start_time = v_hour_start)
  ORDER BY (slot.start_time = NEW.start_time) DESC
  LIMIT 1
  FOR UPDATE;

  IF COALESCE(v_capacity, 0) <= 0 THEN
    RAISE EXCEPTION 'The requested time slot is not available.' USING ERRCODE = '23P01';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.schedule_blocks AS block
    WHERE block.block_date = NEW.appointment_date
      AND block.is_active = true
      AND (
        block.start_time IS NULL
        OR (
          COALESCE(block.reason, '') !~ '^RANGE:[0-9]{2}:[0-9]{2}'
          AND block.start_time = NEW.start_time
        )
        OR (
          COALESCE(block.reason, '') ~ '^RANGE:[0-9]{2}:[0-9]{2}'
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
    RAISE EXCEPTION 'The shop is closed for the requested schedule.' USING ERRCODE = '23P01';
  END IF;

  IF NEW.assigned_crew_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.crew_members AS crew
      JOIN public.crew_schedules AS schedule ON schedule.crew_id = crew.id
      WHERE crew.id = NEW.assigned_crew_id
        AND crew.is_active = true
        AND crew.is_archived = false
        AND schedule.schedule_date = NEW.appointment_date
        AND schedule.is_working = true
        AND schedule.start_time IS NOT NULL
        AND schedule.end_time IS NOT NULL
        AND schedule.start_time <= NEW.start_time
        AND schedule.end_time >= NEW.start_time
          + make_interval(mins => NEW.booking_duration_minutes)
    ) THEN
      RAISE EXCEPTION 'The assigned crew member is not scheduled for the requested appointment period.'
        USING ERRCODE = '23P01';
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
      RAISE EXCEPTION 'The assigned crew member is unavailable for the requested appointment period.'
        USING ERRCODE = '23P01';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_overlapping_reservations
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

  IF v_overlapping_reservations >= v_capacity THEN
    RAISE EXCEPTION 'The requested schedule is no longer available.' USING ERRCODE = '23P01';
  END IF;

  -- Capacity alone is not enough: two slots can overlap while there is still
  -- aggregate capacity for another crew. A crew ending at exactly the new
  -- start time is allowed because all reservation ranges are [start, end).
  IF NEW.assigned_crew_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM (
      SELECT appointment.assigned_crew_id, appointment.appointment_date,
        appointment.start_time, appointment.booking_duration_minutes
      FROM public.appointments AS appointment
      WHERE appointment.id <> NEW.id
        AND appointment.assigned_crew_id = NEW.assigned_crew_id
        AND appointment.appointment_date = NEW.appointment_date
        AND appointment.is_archived = false
        AND appointment.rescheduled_to_appointment_id IS NULL
        AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
      UNION ALL
      SELECT continuation.assigned_crew_id, continuation.appointment_date,
        continuation.start_time, continuation.booking_duration_minutes
      FROM public.appointment_continuations AS continuation
      JOIN public.appointments AS appointment ON appointment.id = continuation.appointment_id
      WHERE continuation.assigned_crew_id = NEW.assigned_crew_id
        AND continuation.appointment_date = NEW.appointment_date
        AND appointment.is_archived = false
        AND appointment.rescheduled_to_appointment_id IS NULL
        AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
    ) AS crew_reservation
    WHERE tsrange(
      crew_reservation.appointment_date + crew_reservation.start_time,
      crew_reservation.appointment_date + crew_reservation.start_time
        + make_interval(mins => crew_reservation.booking_duration_minutes),
      '[)'
    ) && tsrange(
      NEW.appointment_date + NEW.start_time,
      NEW.appointment_date + NEW.start_time + make_interval(mins => NEW.booking_duration_minutes),
      '[)'
    )
  ) THEN
    RAISE EXCEPTION 'The assigned crew member is no longer available for the requested appointment period.'
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

-- A crew-only reassignment must run through the same guard. Earlier trigger
-- definitions omitted assigned_crew_id from UPDATE OF, which allowed an
-- otherwise-valid appointment to be moved onto a busy or unscheduled crew.
DROP TRIGGER IF EXISTS appointments_enforce_active_capacity ON public.appointments;
CREATE TRIGGER appointments_enforce_active_capacity
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
  EXECUTE FUNCTION public.enforce_active_appointment_capacity();
