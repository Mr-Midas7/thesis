-- Keep the database's final booking guard aligned with the operating hours
-- configured in shop_settings. This protects all appointment writes, even if
-- they do not come through the customer booking page.
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
  -- Archived, replaced, or terminal appointments do not consume capacity.
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

  IF v_start_minutes < v_opening_minutes
     OR v_start_minutes >= v_closing_minutes
     OR mod(v_start_minutes - v_opening_minutes, 30) <> 0
     OR v_start_minutes + NEW.booking_duration_minutes > v_closing_minutes THEN
    RAISE EXCEPTION 'The appointment must fit within the configured shop hours in 30-minute start intervals.'
      USING ERRCODE = '23P01';
  END IF;

  v_hour_start := make_time(extract(hour FROM NEW.start_time)::integer, 0, 0);

  -- All new or changed appointments on the same day use one transaction lock.
  -- This also covers overlapping starts that belong to adjacent hourly rows.
  PERFORM pg_advisory_xact_lock(hashtext('booking-capacity:' || NEW.appointment_date::text));

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

  SELECT count(*)
    INTO v_overlapping_appointments
  FROM public.appointments AS other
  WHERE other.id <> NEW.id
    AND other.appointment_date = NEW.appointment_date
    AND other.is_archived = false
    AND other.rescheduled_to_appointment_id IS NULL
    AND other.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
    AND tsrange(
      other.appointment_date + other.start_time,
      other.appointment_date + other.start_time
        + make_interval(mins => other.booking_duration_minutes),
      '[)'
    ) && tsrange(
      NEW.appointment_date + NEW.start_time,
      NEW.appointment_date + NEW.start_time
        + make_interval(mins => NEW.booking_duration_minutes),
      '[)'
    );

  IF v_overlapping_appointments >= v_capacity THEN
    RAISE EXCEPTION 'The requested schedule is no longer available.' USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;
