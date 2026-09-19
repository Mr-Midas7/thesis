-- Customer contact is phone-only. Authentication/account emails remain in the
-- users/auth domain and are not touched by this migration.

-- Keep the full reschedule-review safeguards intact while removing the copied
-- customer email field from replacement appointments.
DO $$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.review_reschedule_request(uuid, text)'::regprocedure)
    INTO v_definition;
  v_definition := replace(v_definition, E'    email,\n', '');
  v_definition := replace(v_definition, E'    v_appointment.email,\n', '');
  EXECUTE v_definition;
END;
$$;

DROP FUNCTION IF EXISTS public.create_booking_atomic(
  text, uuid, text, text, text, text, text, text, integer, text, date, time,
  text, numeric, integer, uuid, jsonb, text, text, text, text, text
);

CREATE FUNCTION public.create_booking_atomic(
  p_reference_code text, p_booking_request_id uuid, p_customer_name text,
  p_phone text, p_moto_brand text, p_moto_model text, p_moto_variant text,
  p_moto_year integer, p_plate_number text, p_appointment_date date,
  p_start_time time, p_notes text, p_total_estimate numeric,
  p_booking_duration_minutes integer, p_assigned_crew_id uuid, p_services jsonb,
  p_notification_title text, p_notification_message text, p_first_name text,
  p_middle_name text, p_last_name text
)
RETURNS TABLE (appointment_id uuid, reference_code text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE v_appointment_id uuid; v_reference_code text;
BEGIN
  IF p_booking_request_id IS NULL THEN RAISE EXCEPTION 'A booking request ID is required.'; END IF;
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
    last_name, phone, moto_brand, moto_model, moto_variant, moto_year,
    plate_number, appointment_date, start_time, notes, total_estimate,
    booking_duration_minutes, terms_accepted, assigned_crew_id
  ) VALUES (
    p_reference_code, p_booking_request_id,
    concat_ws(' ', btrim(p_first_name), btrim(p_middle_name), btrim(p_last_name)),
    btrim(p_first_name), btrim(p_middle_name), btrim(p_last_name), p_phone,
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
  INSERT INTO public.notifications (type, title, message, appointment_id)
  VALUES ('new_appointment', p_notification_title, p_notification_message, v_appointment_id);
  RETURN QUERY SELECT v_appointment_id, v_reference_code;
END;
$$;

REVOKE ALL ON FUNCTION public.create_booking_atomic(
  text, uuid, text, text, text, text, text, integer, text, date, time, text,
  numeric, integer, uuid, jsonb, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_booking_atomic(
  text, uuid, text, text, text, text, text, integer, text, date, time, text,
  numeric, integer, uuid, jsonb, text, text, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.get_admin_customers_page(
  p_search text DEFAULT NULL, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, auth
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(BTRIM(p_search), '');
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN (
    WITH customers AS (
      SELECT a.phone,
        (ARRAY_AGG(a.customer_name ORDER BY a.appointment_date DESC, a.created_at DESC))[1] AS customer_name,
        COUNT(*)::integer AS visits,
        COALESCE(SUM(a.total_estimate) FILTER (WHERE a.status = 'completed'), 0) AS completed_spend,
        MAX(a.appointment_date) AS last_booking,
        ARRAY_AGG(DISTINCT CONCAT_WS(' ', a.moto_brand, a.moto_model) || ' (' || a.plate_number || ')') AS units
      FROM public.appointments a GROUP BY a.phone
    ), filtered AS (
      SELECT * FROM customers c
      WHERE v_search IS NULL OR CONCAT_WS(' ', c.customer_name, c.phone) ILIKE '%' || v_search || '%'
    ), paged AS (
      SELECT * FROM filtered ORDER BY last_booking DESC, customer_name ASC LIMIT v_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'total', (SELECT COUNT(*) FROM filtered),
      'rows', COALESCE((SELECT jsonb_agg(TO_JSONB(paged)) FROM paged), '[]'::jsonb)
    )
  );
END;
$$;

ALTER TABLE public.appointments DROP COLUMN IF EXISTS email CASCADE;

-- The unused legacy reschedule RPC depended on the removed customer email
-- column. Current rescheduling uses submit_reschedule_request instead.
DROP FUNCTION IF EXISTS public.create_rescheduled_booking_atomic(
  text, uuid, text, text, text, text, text, text, integer, text, date, time,
  text, numeric, integer, uuid, jsonb, text, text, uuid
);
