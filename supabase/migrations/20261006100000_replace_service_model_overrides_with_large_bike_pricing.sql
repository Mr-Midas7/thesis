-- Services.price and services.duration_minutes are the Small Bike (<=125cc)
-- defaults. A service can optionally define one Large Bike (>125cc) price and
-- duration; model-specific exceptions are intentionally retired.
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS large_bike_price numeric(10, 2),
  ADD COLUMN IF NOT EXISTS large_bike_duration_minutes integer;

ALTER TABLE public.services
  DROP CONSTRAINT IF EXISTS services_large_bike_configuration_complete;

ALTER TABLE public.services
  ADD CONSTRAINT services_large_bike_configuration_complete
  CHECK (
    (large_bike_price IS NULL AND large_bike_duration_minutes IS NULL)
    OR (
      large_bike_price > price
      AND large_bike_duration_minutes BETWEEN 15 AND 480
      AND large_bike_duration_minutes >= duration_minutes
    )
  );

COMMENT ON COLUMN public.services.price IS
  'Small Bike service price for motorcycles at 125cc and below.';
COMMENT ON COLUMN public.services.duration_minutes IS
  'Small Bike service duration for motorcycles at 125cc and below.';
COMMENT ON COLUMN public.services.large_bike_price IS
  'Large Bike service price for motorcycles above 125cc; must exceed the Small Bike price.';
COMMENT ON COLUMN public.services.large_bike_duration_minutes IS
  'Large Bike service duration for motorcycles above 125cc.';

DROP TABLE IF EXISTS public.service_model_overrides;

-- The authenticated admin RPC has an overload that supplies the customer
-- name and phone, but it delegates the schedule and price calculation to this
-- eight-argument implementation. Keep that shared calculation category-aware
-- so customer booking and admin editing always snapshot the same values.
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
    ORDER BY crew.name, crew.id
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
$$;

REVOKE ALL ON FUNCTION public.update_appointment_details_atomic(
  uuid, uuid[], date, time, uuid, boolean, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_appointment_details_atomic(
  uuid, uuid[], date, time, uuid, boolean, text, text
) TO authenticated;

NOTIFY pgrst, 'reload schema';
