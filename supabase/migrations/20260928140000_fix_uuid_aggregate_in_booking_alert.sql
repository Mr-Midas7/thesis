-- PostgreSQL has no built-in min(uuid) aggregate. The original alert trigger
-- executed it for every appointment-service insert, which rolled back normal
-- booking creation before the reference code could be returned.

CREATE OR REPLACE FUNCTION public.refresh_customer_service_booking_alert(
  p_customer_phone text,
  p_service_id uuid,
  p_service_name text,
  p_preferred_appointment_id uuid,
  p_customer_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_service_key text;
  v_service_label text;
  v_customer_label text;
  v_active_appointment_ids uuid[];
  v_active_booking_count integer;
  v_distinct_booking_date_count integer;
  v_schedule_details text;
  v_notification_appointment_id uuid;
  v_alert_cycle integer;
  v_threshold_was_active boolean;
  v_notification_id uuid;
BEGIN
  IF NULLIF(btrim(p_customer_phone), '') IS NULL
     OR (p_service_id IS NULL AND NULLIF(btrim(p_service_name), '') IS NULL) THEN
    RETURN;
  END IF;

  v_service_key := COALESCE(
    'id:' || p_service_id::text,
    'name:' || lower(btrim(p_service_name))
  );
  v_service_label := COALESCE(
    NULLIF(btrim(p_service_name), ''),
    (SELECT service.name FROM public.services AS service WHERE service.id = p_service_id),
    'this service'
  );

  PERFORM pg_advisory_xact_lock(
    hashtext('customer-service-booking-alert:' || btrim(p_customer_phone))
  );

  WITH active_bookings AS (
    SELECT DISTINCT
      appointment.id,
      appointment.appointment_date,
      appointment.start_time,
      appointment.customer_name
    FROM public.appointments AS appointment
    JOIN public.appointment_services AS appointment_service
      ON appointment_service.appointment_id = appointment.id
    WHERE appointment.phone = btrim(p_customer_phone)
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status NOT IN ('completed', 'cancelled', 'rejected')
      AND (
        appointment_service.service_id = p_service_id
        OR (
          p_service_id IS NULL
          AND appointment_service.service_id IS NULL
          AND appointment_service.service_name = p_service_name
        )
      )
  )
  SELECT
    COALESCE(array_agg(appointment.id ORDER BY appointment.id), ARRAY[]::uuid[]),
    count(*)::integer,
    count(DISTINCT appointment.appointment_date)::integer,
    string_agg(
      to_char(appointment.appointment_date, 'Mon FMDD, YYYY')
        || ' at ' || to_char(appointment.start_time, 'FMHH12:MI AM'),
      '; ' ORDER BY appointment.appointment_date, appointment.start_time, appointment.id
    ),
    COALESCE(
      max(appointment.customer_name) FILTER (WHERE appointment.id = p_preferred_appointment_id),
      max(appointment.customer_name),
      NULLIF(btrim(p_customer_name), ''),
      btrim(p_customer_phone)
    ),
    COALESCE(
      (
        array_agg(appointment.id ORDER BY appointment.appointment_date, appointment.start_time, appointment.id)
          FILTER (WHERE appointment.id = p_preferred_appointment_id)
      )[1],
      (
        array_agg(appointment.id ORDER BY appointment.appointment_date, appointment.start_time, appointment.id)
      )[1]
    )
  INTO
    v_active_appointment_ids,
    v_active_booking_count,
    v_distinct_booking_date_count,
    v_schedule_details,
    v_customer_label,
    v_notification_appointment_id
  FROM active_bookings AS appointment;

  INSERT INTO public.customer_service_booking_alert_state (customer_phone, service_key)
  VALUES (btrim(p_customer_phone), v_service_key)
  ON CONFLICT (customer_phone, service_key) DO NOTHING;

  SELECT state.is_threshold_active, state.alert_cycle
  INTO v_threshold_was_active, v_alert_cycle
  FROM public.customer_service_booking_alert_state AS state
  WHERE state.customer_phone = btrim(p_customer_phone)
    AND state.service_key = v_service_key
  FOR UPDATE;

  IF v_active_booking_count < 2 OR v_distinct_booking_date_count < 2 THEN
    UPDATE public.customer_service_booking_alert_state
    SET is_threshold_active = false,
        updated_at = now()
    WHERE customer_phone = btrim(p_customer_phone)
      AND service_key = v_service_key;
    RETURN;
  END IF;

  IF NOT v_threshold_was_active THEN
    v_alert_cycle := v_alert_cycle + 1;

    UPDATE public.customer_service_booking_alert_state
    SET is_threshold_active = true,
        alert_cycle = v_alert_cycle,
        updated_at = now()
    WHERE customer_phone = btrim(p_customer_phone)
      AND service_key = v_service_key;
  END IF;

  INSERT INTO public.customer_service_booking_alerts (
    customer_phone,
    service_key,
    alert_cycle,
    active_appointment_ids
  )
  VALUES (
    btrim(p_customer_phone),
    v_service_key,
    v_alert_cycle,
    v_active_appointment_ids
  )
  ON CONFLICT (customer_phone, service_key, alert_cycle, active_appointment_ids) DO NOTHING
  RETURNING id INTO v_notification_id;

  IF v_notification_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.notifications (type, title, message, appointment_id)
  VALUES (
    'multiple_active_service_bookings',
    v_active_booking_count || ' active ' || v_service_label || ' bookings for ' || v_customer_label,
    v_customer_label || ' (' || btrim(p_customer_phone) || ') has '
      || v_active_booking_count || ' active bookings for ' || v_service_label || ': '
      || v_schedule_details || '.',
    v_notification_appointment_id
  )
  RETURNING id INTO v_notification_id;

  UPDATE public.customer_service_booking_alerts
  SET notification_id = v_notification_id
  WHERE customer_phone = btrim(p_customer_phone)
    AND service_key = v_service_key
    AND alert_cycle = v_alert_cycle
    AND active_appointment_ids = v_active_appointment_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_customer_service_booking_alert(text, uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_customer_service_booking_alert(text, uuid, text, uuid, text) TO service_role;
