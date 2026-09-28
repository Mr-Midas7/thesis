-- Keep the pre-multi-day customer client compatible while a frontend release
-- rolls out. That client does not send p_continuation_segments, so PostgREST
-- otherwise reports create_booking_atomic as missing even though the current
-- 22-argument function is present.
CREATE OR REPLACE FUNCTION public.create_booking_atomic(
  p_reference_code text,
  p_booking_request_id uuid,
  p_customer_name text,
  p_phone text,
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
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT created.appointment_id, created.reference_code
  FROM public.create_booking_atomic(
    p_reference_code,
    p_booking_request_id,
    p_customer_name,
    p_phone,
    p_moto_brand,
    p_moto_model,
    p_moto_variant,
    p_moto_year,
    p_plate_number,
    p_appointment_date,
    p_start_time,
    p_notes,
    p_total_estimate,
    p_booking_duration_minutes,
    p_assigned_crew_id,
    p_services,
    '[]'::jsonb,
    p_notification_title,
    p_notification_message,
    p_first_name,
    p_middle_name,
    p_last_name
  ) AS created;
$$;

REVOKE ALL ON FUNCTION public.create_booking_atomic(
  text, uuid, text, text, text, text, text, integer, text, date, time, text,
  numeric, integer, uuid, jsonb, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_booking_atomic(
  text, uuid, text, text, text, text, text, integer, text, date, time, text,
  numeric, integer, uuid, jsonb, text, text, text, text, text
) TO service_role;

NOTIFY pgrst, 'reload schema';
