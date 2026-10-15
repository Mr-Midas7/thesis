-- Booking rules:
-- 1. A pending reschedule request holds its requested time until it is
--    reviewed. It counts as a reservation that does not have a mechanic yet.
-- 2. A mobile number, and an email address, can each have at most 3 upcoming
--    appointments at a time.
-- 3. The mechanic with the fewest bookings that day is assigned.
-- 4. The duplicate rule compares plate numbers instead of mobile numbers, so
--    one customer can book the same service for two motorcycles on one day.

-- Scheduled jobs and the functions below must belong to postgres.
DO $$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Apply this migration as postgres (current role: %).', current_user;
  END IF;
END;
$$;

-- Helpers -------------------------------------------------------------------

-- Plate numbers compare without spaces, dashes, or letter case.
CREATE OR REPLACE FUNCTION public.normalize_plate_number(p_plate text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT upper(regexp_replace(COALESCE(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- [bookings, booked minutes] for one mechanic on one day. Arrays sort element
-- by element, so ORDER BY on this puts the least busy mechanic first.
CREATE OR REPLACE FUNCTION public.crew_daily_workload(
  p_crew_id uuid,
  p_date date,
  p_excluded_appointment_id uuid DEFAULT NULL
)
RETURNS integer[]
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT ARRAY[count(*)::integer, COALESCE(sum(work.minutes), 0)::integer]
  FROM (
    SELECT appointment.booking_duration_minutes AS minutes
    FROM public.appointments AS appointment
    WHERE appointment.assigned_crew_id = p_crew_id
      AND appointment.appointment_date = p_date
      AND appointment.id IS DISTINCT FROM p_excluded_appointment_id
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
    UNION ALL
    SELECT continuation.booking_duration_minutes
    FROM public.appointment_continuations AS continuation
    JOIN public.appointments AS appointment ON appointment.id = continuation.appointment_id
    WHERE continuation.assigned_crew_id = p_crew_id
      AND continuation.appointment_date = p_date
      AND appointment.id IS DISTINCT FROM p_excluded_appointment_id
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
  ) AS work;
$$;

REVOKE ALL ON FUNCTION public.normalize_plate_number(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_plate_number(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.crew_daily_workload(uuid, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crew_daily_workload(uuid, date, uuid) TO authenticated, service_role;

-- 1. Reschedule requests hold their time ----------------------------------

CREATE OR REPLACE FUNCTION public.enforce_active_appointment_capacity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
    UNION ALL
    -- A pending reschedule request holds its requested time until it is
    -- reviewed. The appointment's own request, and the request being approved
    -- (when this row is its replacement), do not count against it.
    SELECT hold.pending_reschedule_date, hold.pending_reschedule_start_time,
      COALESCE(hold.booking_duration_minutes, 75)
    FROM public.appointments AS hold
    WHERE hold.pending_reschedule_request_id IS NOT NULL
      AND hold.pending_reschedule_date = NEW.appointment_date
      AND hold.pending_reschedule_start_time IS NOT NULL
      AND hold.id <> NEW.id
      AND hold.id IS DISTINCT FROM NEW.rescheduled_from_appointment_id
      AND hold.is_archived = false
      AND hold.rescheduled_to_appointment_id IS NULL
      AND hold.status IN ('pending', 'confirmed')
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
$function$;

CREATE OR REPLACE FUNCTION public.enforce_active_appointment_continuation_capacity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
    UNION ALL
    -- Pending reschedule requests hold their requested times too.
    SELECT hold.pending_reschedule_date, hold.pending_reschedule_start_time,
      COALESCE(hold.booking_duration_minutes, 75)
    FROM public.appointments AS hold
    WHERE hold.pending_reschedule_request_id IS NOT NULL
      AND hold.pending_reschedule_date = NEW.appointment_date
      AND hold.pending_reschedule_start_time IS NOT NULL
      AND hold.is_archived = false
      AND hold.rescheduled_to_appointment_id IS NULL
      AND hold.status IN ('pending', 'confirmed')
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
$function$;

-- Setting or moving a request checks that its time still has room: the slot
-- limit counts every overlapping reservation, and a free mechanic must remain
-- for each reservation that has none yet (as in the booking screen).
CREATE OR REPLACE FUNCTION public.enforce_reschedule_request_capacity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_date date := NEW.pending_reschedule_date;
  v_start time := NEW.pending_reschedule_start_time;
  v_duration integer := COALESCE(NEW.booking_duration_minutes, 75);
  v_capacity integer;
  v_overlapping integer;
  v_unassigned integer;
  v_free_crew integer;
BEGIN
  IF NEW.pending_reschedule_request_id IS NULL
     OR v_date IS NULL
     OR v_start IS NULL
     OR NEW.is_archived
     OR NEW.rescheduled_to_appointment_id IS NOT NULL
     OR NEW.status NOT IN ('pending', 'confirmed') THEN
    RETURN NEW;
  END IF;
  IF OLD.pending_reschedule_request_id IS NOT DISTINCT FROM NEW.pending_reschedule_request_id
     AND OLD.pending_reschedule_date IS NOT DISTINCT FROM v_date
     AND OLD.pending_reschedule_start_time IS NOT DISTINCT FROM v_start THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('booking-capacity:' || v_date::text));

  SELECT slot.capacity
    INTO v_capacity
  FROM public.time_slots AS slot
  WHERE slot.is_active = true
    AND (
      slot.start_time = v_start
      OR slot.start_time = make_time(extract(hour FROM v_start)::integer, 0, 0)
    )
  ORDER BY (slot.start_time = v_start) DESC
  LIMIT 1;

  SELECT count(*), count(*) FILTER (WHERE reservation.crew_id IS NULL)
    INTO v_overlapping, v_unassigned
  FROM (
    SELECT appointment.start_time, appointment.booking_duration_minutes AS minutes,
      appointment.assigned_crew_id AS crew_id
    FROM public.appointments AS appointment
    WHERE appointment.id <> NEW.id
      AND appointment.appointment_date = v_date
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
    UNION ALL
    SELECT continuation.start_time, continuation.booking_duration_minutes,
      continuation.assigned_crew_id
    FROM public.appointment_continuations AS continuation
    JOIN public.appointments AS parent ON parent.id = continuation.appointment_id
    WHERE continuation.appointment_date = v_date
      AND parent.id <> NEW.id
      AND parent.is_archived = false
      AND parent.rescheduled_to_appointment_id IS NULL
      AND parent.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
    UNION ALL
    SELECT hold.pending_reschedule_start_time, COALESCE(hold.booking_duration_minutes, 75),
      NULL::uuid
    FROM public.appointments AS hold
    WHERE hold.id <> NEW.id
      AND hold.pending_reschedule_request_id IS NOT NULL
      AND hold.pending_reschedule_date = v_date
      AND hold.pending_reschedule_start_time IS NOT NULL
      AND hold.is_archived = false
      AND hold.rescheduled_to_appointment_id IS NULL
      AND hold.status IN ('pending', 'confirmed')
  ) AS reservation
  WHERE tsrange(
    v_date + reservation.start_time,
    v_date + reservation.start_time + make_interval(mins => reservation.minutes),
    '[)'
  ) && tsrange(v_date + v_start, v_date + v_start + make_interval(mins => v_duration), '[)');

  IF COALESCE(v_capacity, 0) - v_overlapping < 1 THEN
    RAISE EXCEPTION 'The requested time is no longer available. Please choose another time.'
      USING ERRCODE = '23P01';
  END IF;

  SELECT count(*)
    INTO v_free_crew
  FROM public.crew_members AS crew
  WHERE crew.is_active = true
    AND crew.is_archived = false
    AND public.is_crew_available_for_appointment(crew.id, v_date, v_start, v_duration, NEW.id);

  IF v_free_crew - v_unassigned < 1 THEN
    RAISE EXCEPTION 'No mechanic is available at the requested time. Please choose another time.'
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_enforce_reschedule_request_capacity ON public.appointments;
CREATE TRIGGER appointments_enforce_reschedule_request_capacity
  BEFORE UPDATE OF pending_reschedule_request_id, pending_reschedule_date, pending_reschedule_start_time
  ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_reschedule_request_capacity();

CREATE OR REPLACE FUNCTION public.review_reschedule_request(p_appointment_id uuid, p_decision text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  v_opening_time time;
  v_closing_time time;
  v_opening_minutes integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can review reschedule requests.';
  END IF;
  IF lower(btrim(COALESCE(p_decision, ''))) NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'Choose either confirmed or rejected.';
  END IF;

  SELECT appointment.*
    INTO v_appointment
  FROM public.appointments AS appointment
  WHERE appointment.id = p_appointment_id
    AND appointment.is_archived = false
  FOR UPDATE;

  IF NOT FOUND OR v_appointment.pending_reschedule_request_id IS NULL THEN
    RAISE EXCEPTION 'This reschedule request is no longer available.';
  END IF;

  v_reschedule_number := v_appointment.reschedule_count + 1;

  IF lower(btrim(p_decision)) = 'rejected' THEN
    INSERT INTO public.appointment_reschedule_history (
      appointment_id,
      new_appointment_id,
      reschedule_number,
      from_date,
      from_start_time,
      to_date,
      to_start_time,
      reason,
      decision,
      approved_by
    ) VALUES (
      v_appointment.id,
      NULL,
      v_reschedule_number,
      v_appointment.appointment_date,
      v_appointment.start_time,
      v_appointment.pending_reschedule_date,
      v_appointment.pending_reschedule_start_time,
      btrim(v_appointment.pending_reschedule_reason),
      'rejected',
      auth.uid()
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

  SELECT settings.opening_time, settings.closing_time
    INTO v_opening_time, v_closing_time
  FROM public.shop_settings AS settings
  ORDER BY settings.id
  LIMIT 1;
  v_opening_time := COALESCE(v_opening_time, '08:00'::time);
  v_closing_time := COALESCE(v_closing_time, '17:00'::time);
  v_opening_minutes := extract(hour FROM v_opening_time)::integer * 60
    + extract(minute FROM v_opening_time)::integer;

  IF extract(dow FROM v_appointment.pending_reschedule_date) = 0
     OR v_appointment.pending_reschedule_start_time < v_opening_time
     OR v_appointment.pending_reschedule_start_time >= v_closing_time
     OR mod(v_start_minutes - v_opening_minutes, 30) <> 0
     OR v_appointment.pending_reschedule_start_time + make_interval(mins => v_duration_minutes)
        > v_closing_time THEN
    RAISE EXCEPTION 'The requested schedule is outside the shop booking hours.';
  END IF;

  SELECT public.booking_slot_capacity(v_appointment.pending_reschedule_start_time)
    INTO v_slot_capacity;
  IF COALESCE(v_slot_capacity, 0) <= 0 THEN
    RAISE EXCEPTION 'The requested time slot is no longer available.';
  END IF;

  SELECT count(*)
    INTO v_overlapping_appointments
  FROM public.appointments AS other
  WHERE other.id <> v_appointment.id
    AND other.appointment_date = v_appointment.pending_reschedule_date
    AND other.is_archived = false
    AND other.rescheduled_to_appointment_id IS NULL
    AND other.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
    AND tsrange(
      other.appointment_date + other.start_time,
      other.appointment_date + other.start_time
        + make_interval(mins => COALESCE(other.booking_duration_minutes, 75)),
      '[)'
    ) && tsrange(
      v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
      v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
        + make_interval(mins => v_duration_minutes),
      '[)'
    );
  -- Other pending reschedule requests hold their requested times too.
  v_overlapping_appointments := v_overlapping_appointments + (
    SELECT count(*)
    FROM public.appointments AS hold
    WHERE hold.id <> v_appointment.id
      AND hold.pending_reschedule_request_id IS NOT NULL
      AND hold.pending_reschedule_date = v_appointment.pending_reschedule_date
      AND hold.pending_reschedule_start_time IS NOT NULL
      AND hold.is_archived = false
      AND hold.rescheduled_to_appointment_id IS NULL
      AND hold.status IN ('pending', 'confirmed')
      AND tsrange(
        hold.pending_reschedule_date + hold.pending_reschedule_start_time,
        hold.pending_reschedule_date + hold.pending_reschedule_start_time
          + make_interval(mins => COALESCE(hold.booking_duration_minutes, 75)),
        '[)'
      ) && tsrange(
        v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
        v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time + make_interval(mins => v_duration_minutes),
        '[)'
      )
  );
  IF v_overlapping_appointments >= v_slot_capacity THEN
    RAISE EXCEPTION 'The requested time is no longer available.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.schedule_blocks AS block
    WHERE block.block_date = v_appointment.pending_reschedule_date
      AND block.is_active = true
      AND (
        block.start_time IS NULL
        OR (
          block.start_time IS NOT NULL
          AND (
            (COALESCE(block.reason, '') NOT LIKE 'RANGE:%'
              AND block.start_time = v_appointment.pending_reschedule_start_time)
            OR (COALESCE(block.reason, '') LIKE 'RANGE:%'
              AND tsrange(
                v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
                v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
                  + make_interval(mins => v_duration_minutes),
                '[)'
              ) && tsrange(
                v_appointment.pending_reschedule_date + block.start_time,
                v_appointment.pending_reschedule_date
                  + substring(block.reason FROM '^RANGE:([0-9]{2}:[0-9]{2})')::time,
                '[)'
              ))
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'The requested time is no longer available because the shop schedule is blocked.';
  END IF;

  SELECT crew.id
    INTO v_assigned_crew_id
  FROM public.crew_members AS crew
  WHERE crew.is_active = true
    AND crew.is_archived = false
    AND EXISTS (
      SELECT 1
      FROM public.crew_schedules AS schedule
      WHERE schedule.crew_id = crew.id
        AND schedule.schedule_date = v_appointment.pending_reschedule_date
        AND schedule.is_working = true
        AND schedule.start_time IS NOT NULL
        AND schedule.end_time IS NOT NULL
        AND schedule.start_time <= v_appointment.pending_reschedule_start_time
        AND schedule.end_time >= v_appointment.pending_reschedule_start_time
          + make_interval(mins => v_duration_minutes)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.crew_availability_exceptions AS exception
      WHERE exception.crew_id = crew.id
        AND exception.start_date <= v_appointment.pending_reschedule_date
        AND exception.end_date >= v_appointment.pending_reschedule_date
        AND (
          exception.is_all_day
          OR (
            exception.start_time IS NOT NULL
            AND exception.end_time IS NOT NULL
            AND tsrange(
              v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
              v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
                + make_interval(mins => v_duration_minutes),
              '[)'
            ) && tsrange(
              v_appointment.pending_reschedule_date + exception.start_time,
              v_appointment.pending_reschedule_date + exception.end_time,
              '[)'
            )
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.appointments AS other
      WHERE other.id <> v_appointment.id
        AND other.assigned_crew_id = crew.id
        AND other.appointment_date = v_appointment.pending_reschedule_date
        AND other.is_archived = false
        AND other.rescheduled_to_appointment_id IS NULL
        AND other.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
        AND tsrange(
          other.appointment_date + other.start_time,
          other.appointment_date + other.start_time
            + make_interval(mins => COALESCE(other.booking_duration_minutes, 75)),
          '[)'
        ) && tsrange(
          v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
          v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
            + make_interval(mins => v_duration_minutes),
          '[)'
        )
    )
  -- The mechanic with the fewest bookings that day takes the new schedule.
  ORDER BY public.crew_daily_workload(
    crew.id,
    v_appointment.pending_reschedule_date,
    v_appointment.id
  ), crew.name, crew.id
  LIMIT 1;

  IF v_assigned_crew_id IS NULL THEN
    RAISE EXCEPTION 'No crew member is available for the requested appointment period.';
  END IF;

  v_new_reference_code := v_appointment.pending_reschedule_reference_code;
  IF v_new_reference_code IS NULL
     OR v_new_reference_code !~ '^FRM-[A-Z0-9]{6}$' THEN
    RAISE EXCEPTION 'The reschedule request is missing its replacement reference.';
  END IF;

  v_original_shop_notes := concat_ws(
    E'\n',
    NULLIF(btrim(v_appointment.admin_notes), ''),
    'Rescheduled to ' || v_new_reference_code,
    'Reason for rescheduling: ' || v_reason
  );
  v_new_shop_notes := concat_ws(
    E'\n',
    'Rescheduled from ' || v_appointment.reference_code,
    'Reason for rescheduling: ' || v_reason
  );

  INSERT INTO public.appointments AS replacement (
    reference_code,
    booking_request_id,
    customer_name,
    first_name,
    middle_name,
    last_name,
    phone,
    moto_brand,
    moto_model,
    moto_variant,
    moto_year,
    plate_number,
    appointment_date,
    start_time,
    status,
    notes,
    admin_notes,
    total_estimate,
    booking_duration_minutes,
    terms_accepted,
    assigned_crew_id,
    reschedule_count,
    rescheduled_from_appointment_id
  ) VALUES (
    v_new_reference_code,
    gen_random_uuid(),
    v_appointment.customer_name,
    v_appointment.first_name,
    v_appointment.middle_name,
    v_appointment.last_name,
    v_appointment.phone,
    v_appointment.moto_brand,
    v_appointment.moto_model,
    v_appointment.moto_variant,
    v_appointment.moto_year,
    v_appointment.plate_number,
    v_appointment.pending_reschedule_date,
    v_appointment.pending_reschedule_start_time,
    'confirmed',
    v_appointment.notes,
    v_new_shop_notes,
    v_appointment.total_estimate,
    v_duration_minutes,
    v_appointment.terms_accepted,
    v_assigned_crew_id,
    v_appointment.reschedule_count + 1,
    v_appointment.id
  )
  RETURNING replacement.id INTO v_new_appointment_id;

  INSERT INTO public.appointment_services (
    appointment_id,
    service_id,
    service_name,
    price,
    duration_minutes
  )
  SELECT
    v_new_appointment_id,
    service.service_id,
    service.service_name,
    service.price,
    service.duration_minutes
  FROM public.appointment_services AS service
  WHERE service.appointment_id = v_appointment.id;

  UPDATE public.appointments
  SET status = 'rescheduled',
      admin_notes = v_original_shop_notes,
      reschedule_count = v_appointment.reschedule_count + 1,
      rescheduled_to_appointment_id = v_new_appointment_id,
      pending_reschedule_request_id = NULL,
      pending_reschedule_date = NULL,
      pending_reschedule_start_time = NULL,
      pending_reschedule_reference_code = NULL,
      pending_reschedule_reason = NULL
  WHERE id = v_appointment.id;

  INSERT INTO public.notifications (type, title, message, appointment_id)
  VALUES (
    'rescheduled_appointment',
    'Rescheduled booking ' || v_new_reference_code,
    v_appointment.customer_name || ' rescheduled from ' || v_appointment.reference_code
      || ' to ' || v_new_reference_code || '. Reason: ' || v_reason,
    v_new_appointment_id
  );

  INSERT INTO public.appointment_reschedule_history (
    appointment_id,
    new_appointment_id,
    reschedule_number,
    from_date,
    from_start_time,
    to_date,
    to_start_time,
    reason,
    decision,
    approved_by
  ) VALUES (
    v_appointment.id,
    v_new_appointment_id,
    v_reschedule_number,
    v_appointment.appointment_date,
    v_appointment.start_time,
    v_appointment.pending_reschedule_date,
    v_appointment.pending_reschedule_start_time,
    v_reason,
    'confirmed',
    auth.uid()
  );
END;
$function$;

-- 2. At most 3 upcoming appointments per mobile number and per email --------

CREATE OR REPLACE FUNCTION public.enforce_customer_upcoming_appointment_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_limit constant integer := 3;
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_phone text := COALESCE(public.normalize_philippine_mobile(NEW.phone), btrim(NEW.phone));
  v_email text := NULLIF(lower(btrim(COALESCE(NEW.email, ''))), '');
BEGIN
  -- A replacement created by an approved reschedule takes over an existing
  -- appointment, so it is not limited.
  IF NEW.rescheduled_from_appointment_id IS NOT NULL
     OR NEW.is_archived
     OR NEW.status NOT IN ('pending', 'confirmed', 'in_progress')
     OR NEW.appointment_date < v_today THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('customer-upcoming-appointments:' || v_phone));
  IF (
    SELECT count(*)
    FROM public.appointments AS appointment
    WHERE appointment.phone = v_phone
      AND appointment.id <> NEW.id
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress')
      AND appointment.appointment_date >= v_today
  ) >= v_limit THEN
    RAISE EXCEPTION 'This mobile number already has % upcoming appointments, the most allowed at one time. Please cancel one or wait until one is done before booking another.', v_limit
      USING ERRCODE = '23514';
  END IF;

  IF v_email IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('customer-upcoming-appointments:' || v_email));
    IF (
      SELECT count(*)
      FROM public.appointments AS appointment
      WHERE lower(btrim(appointment.email)) = v_email
        AND appointment.id <> NEW.id
        AND appointment.is_archived = false
        AND appointment.rescheduled_to_appointment_id IS NULL
        AND appointment.status IN ('pending', 'confirmed', 'in_progress')
        AND appointment.appointment_date >= v_today
    ) >= v_limit THEN
      RAISE EXCEPTION 'This email address already has % upcoming appointments, the most allowed at one time. Please cancel one or wait until one is done before booking another.', v_limit
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_enforce_customer_upcoming_limit ON public.appointments;
CREATE TRIGGER appointments_enforce_customer_upcoming_limit
  BEFORE INSERT ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_customer_upcoming_appointment_limit();

-- 3. The least busy mechanic ----------------------------------------------

CREATE OR REPLACE FUNCTION public.review_pending_appointment(p_appointment_id uuid, p_decision text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_appointment public.appointments%ROWTYPE;
  v_assigned_crew_id uuid;
  v_duration_minutes integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can review appointments.';
  END IF;

  IF p_decision IS NULL OR lower(btrim(p_decision)) NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'Choose either confirmed or rejected.';
  END IF;

  -- Lock the row so two notification actions cannot review the same booking.
  SELECT appointment.*
    INTO v_appointment
  FROM public.appointments AS appointment
  WHERE appointment.id = p_appointment_id
    AND appointment.is_archived = false
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This appointment is no longer available.';
  END IF;

  IF v_appointment.status <> 'pending' THEN
    RAISE EXCEPTION 'This appointment has already been reviewed.';
  END IF;

  IF lower(btrim(p_decision)) = 'rejected' THEN
    UPDATE public.appointments
    SET status = 'rejected',
        assigned_crew_id = NULL
    WHERE id = v_appointment.id;
    RETURN;
  END IF;

  v_duration_minutes := COALESCE(v_appointment.booking_duration_minutes, 75);

  -- Prefer the crew member reserved during booking, but fall back to another
  -- currently available member when schedules or availability have changed.
  SELECT crew.id
    INTO v_assigned_crew_id
  FROM public.crew_members AS crew
  WHERE crew.is_active = true
    AND crew.is_archived = false
    AND EXISTS (
      SELECT 1
      FROM public.crew_schedules AS schedule
      WHERE schedule.crew_id = crew.id
        AND schedule.schedule_date = v_appointment.appointment_date
        AND schedule.is_working = true
        AND schedule.start_time IS NOT NULL
        AND schedule.end_time IS NOT NULL
        AND schedule.start_time <= v_appointment.start_time
        AND schedule.end_time >= v_appointment.start_time + make_interval(mins => v_duration_minutes)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.crew_availability_exceptions AS exception
      WHERE exception.crew_id = crew.id
        AND exception.start_date <= v_appointment.appointment_date
        AND exception.end_date >= v_appointment.appointment_date
        AND (
          exception.is_all_day = true
          OR (
            exception.start_time IS NOT NULL
            AND exception.end_time IS NOT NULL
            AND tsrange(
              v_appointment.appointment_date + v_appointment.start_time,
              v_appointment.appointment_date + v_appointment.start_time
                + make_interval(mins => v_duration_minutes),
              '[)'
            ) && tsrange(
              v_appointment.appointment_date + exception.start_time,
              v_appointment.appointment_date + exception.end_time,
              '[)'
            )
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.appointments AS other
      WHERE other.id <> v_appointment.id
        AND other.assigned_crew_id = crew.id
        AND other.appointment_date = v_appointment.appointment_date
        AND other.is_archived = false
        AND other.rescheduled_to_appointment_id IS NULL
        AND other.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
        AND tsrange(
          other.appointment_date + other.start_time,
          other.appointment_date + other.start_time
            + make_interval(mins => COALESCE(other.booking_duration_minutes, 75)),
          '[)'
        ) && tsrange(
          v_appointment.appointment_date + v_appointment.start_time,
          v_appointment.appointment_date + v_appointment.start_time
            + make_interval(mins => v_duration_minutes),
          '[)'
        )
    )
  ORDER BY (crew.id = v_appointment.assigned_crew_id) DESC,
    public.crew_daily_workload(crew.id, v_appointment.appointment_date, v_appointment.id),
    crew.name,
    crew.id
  LIMIT 1;

  IF v_assigned_crew_id IS NULL THEN
    RAISE EXCEPTION 'No crew member is available for the selected appointment period.';
  END IF;

  UPDATE public.appointments
  SET status = 'confirmed',
      assigned_crew_id = v_assigned_crew_id
  WHERE id = v_appointment.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_appointment_details_atomic(p_appointment_id uuid, p_service_ids uuid[], p_appointment_date date, p_start_time time without time zone, p_assigned_crew_id uuid, p_crew_assignment_manual boolean, p_status text, p_admin_notes text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_service_count integer;
  v_total_estimate numeric(10,2);
  v_duration_minutes integer;
  v_assigned_crew_id uuid := p_assigned_crew_id;
  v_appointment_id uuid;
  v_motorcycle_category text;
BEGIN
  IF COALESCE(cardinality(p_service_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one service.';
  END IF;

  IF p_status NOT IN (
    'pending', 'confirmed', 'in_progress', 'completed', 'rescheduled', 'cancelled', 'rejected', 'no_show'
  ) THEN
    RAISE EXCEPTION 'Choose a valid appointment status.';
  END IF;

  SELECT appointment.id, catalog.cc_category
    INTO v_appointment_id, v_motorcycle_category
  FROM public.appointments AS appointment
  LEFT JOIN public.motorcycle_catalog AS catalog
    ON lower(btrim(catalog.brand)) = lower(btrim(appointment.moto_brand))
   AND lower(btrim(catalog.model)) = lower(btrim(appointment.moto_model))
   AND catalog.is_archived = false
  WHERE appointment.id = p_appointment_id
    AND appointment.is_archived = false
  LIMIT 1;

  IF v_appointment_id IS NULL THEN
    RAISE EXCEPTION 'This appointment is no longer available.';
  END IF;
  IF v_motorcycle_category IS NULL
     OR v_motorcycle_category NOT IN ('small_bike', 'big_bike') THEN
    RAISE EXCEPTION 'The appointment motorcycle needs an engine CC classification before its services can be updated.';
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

  IF v_motorcycle_category = 'big_bike' AND EXISTS (
    SELECT 1
    FROM public.services
    WHERE id = ANY(p_service_ids)
      AND (large_bike_price IS NULL OR large_bike_duration_minutes IS NULL)
  ) THEN
    RAISE EXCEPTION 'Every selected service needs a Large Bike price and duration.';
  END IF;

  SELECT
    COALESCE(sum(CASE WHEN v_motorcycle_category = 'big_bike' THEN large_bike_price ELSE price END), 0),
    COALESCE(sum(CASE WHEN v_motorcycle_category = 'big_bike' THEN large_bike_duration_minutes ELSE duration_minutes END), 0)
  INTO v_total_estimate, v_duration_minutes
  FROM public.services
  WHERE id = ANY(p_service_ids);

  PERFORM pg_advisory_xact_lock(hashtext('booking-capacity:' || p_appointment_date::text));

  IF p_status = 'confirmed' AND v_assigned_crew_id IS NULL AND NOT p_crew_assignment_manual THEN
    SELECT crew.id
      INTO v_assigned_crew_id
    FROM public.crew_members AS crew
    WHERE crew.is_active = true
      AND crew.is_archived = false
      AND public.is_crew_available_for_appointment(
        crew.id, p_appointment_date, p_start_time, v_duration_minutes, p_appointment_id
      )
    ORDER BY public.crew_daily_workload(crew.id, p_appointment_date, p_appointment_id),
      crew.name,
      crew.id
    LIMIT 1;

    IF v_assigned_crew_id IS NULL THEN
      RAISE EXCEPTION 'No crew member is available for the selected appointment period.';
    END IF;
  END IF;

  IF v_assigned_crew_id IS NOT NULL
     AND NOT public.is_crew_available_for_appointment(
       v_assigned_crew_id, p_appointment_date, p_start_time, v_duration_minutes, p_appointment_id
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

  DELETE FROM public.appointment_services
  WHERE appointment_id = p_appointment_id;

  INSERT INTO public.appointment_services (
    appointment_id, service_id, service_name, price, duration_minutes
  )
  SELECT
    p_appointment_id,
    service.id,
    service.name,
    CASE WHEN v_motorcycle_category = 'big_bike' THEN service.large_bike_price ELSE service.price END,
    CASE WHEN v_motorcycle_category = 'big_bike' THEN service.large_bike_duration_minutes ELSE service.duration_minutes END
  FROM public.services AS service
  WHERE service.id = ANY(p_service_ids);
END;
$function$;

-- 4. Duplicate rule by plate number --------------------------------------

CREATE OR REPLACE FUNCTION public.assert_no_duplicate_active_customer_service_appointment(p_appointment_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_plate text;
  v_plate_label text;
  v_appointment_date date;
  v_service_name text;
  v_start_time time;
BEGIN
  SELECT public.normalize_plate_number(appointment.plate_number),
    btrim(appointment.plate_number),
    appointment.appointment_date
  INTO v_plate, v_plate_label, v_appointment_date
  FROM public.appointments AS appointment
  WHERE appointment.id = p_appointment_id
    AND appointment.is_archived = false
    AND appointment.rescheduled_to_appointment_id IS NULL
    AND appointment.status NOT IN ('completed', 'cancelled', 'rejected');

  IF NOT FOUND OR v_plate = '' THEN
    RETURN;
  END IF;

  SELECT current_service.service_name, other_appointment.start_time
  INTO v_service_name, v_start_time
  FROM public.appointment_services AS current_service
  JOIN public.appointments AS other_appointment
    ON public.normalize_plate_number(other_appointment.plate_number) = v_plate
   AND other_appointment.appointment_date = v_appointment_date
   AND other_appointment.id <> p_appointment_id
   AND other_appointment.is_archived = false
   AND other_appointment.rescheduled_to_appointment_id IS NULL
   AND other_appointment.status NOT IN ('completed', 'cancelled', 'rejected')
  JOIN public.appointment_services AS other_service
    ON other_service.appointment_id = other_appointment.id
   AND (
     other_service.service_id = current_service.service_id
     OR (
       other_service.service_id IS NULL
       AND current_service.service_id IS NULL
       AND other_service.service_name = current_service.service_name
     )
   )
  WHERE current_service.appointment_id = p_appointment_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'The motorcycle with plate number % already has an appointment for "%" on % at %.',
      v_plate_label,
      v_service_name,
      to_char(v_appointment_date, 'FMDay, FMMonth FMDD, YYYY'),
      to_char(v_start_time, 'FMHH12:MI AM')
      USING ERRCODE = '23505';
  END IF;
END;
$function$;

NOTIFY pgrst, 'reload schema';
