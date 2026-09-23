-- Serialize due-notification creation with manual service-progress actions.
-- SKIP LOCKED lets the next poll retry a row currently being started or
-- completed without creating an alert from stale appointment state.
CREATE OR REPLACE FUNCTION public.sync_service_progress_notifications()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_created integer := 0;
  v_now timestamptz := now();
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can synchronize service progress notifications.';
  END IF;

  WITH due_appointments AS (
    SELECT appointment.id, appointment.reference_code, appointment.customer_name
    FROM public.appointments AS appointment
    WHERE appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status = 'confirmed'
      AND appointment.service_started_at IS NULL
      AND (appointment.appointment_date + appointment.start_time) AT TIME ZONE 'Asia/Manila' <= v_now
      AND COALESCE(appointment.arrival_notification_snoozed_until, v_now) <= v_now
      AND NOT EXISTS (
        SELECT 1
        FROM public.notifications AS notification
        WHERE notification.appointment_id = appointment.id
          AND notification.type = 'service_arrival'
          AND notification.is_read = false
      )
    FOR UPDATE OF appointment SKIP LOCKED
  ),
  inserted AS (
    INSERT INTO public.notifications (type, title, message, appointment_id)
    SELECT
      'service_arrival',
      'Customer expected: ' || due.reference_code,
      due.customer_name || ' is scheduled to arrive for service now.',
      due.id
    FROM due_appointments AS due
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM inserted;

  WITH due_appointments AS (
    SELECT
      appointment.id,
      appointment.reference_code,
      appointment.customer_name,
      appointment.service_started_at,
      service_duration.service_duration_minutes
    FROM public.appointments AS appointment
    JOIN LATERAL (
      SELECT sum(appointment_service.duration_minutes)::integer AS service_duration_minutes
      FROM public.appointment_services AS appointment_service
      WHERE appointment_service.appointment_id = appointment.id
    ) AS service_duration ON service_duration.service_duration_minutes > 0
    WHERE appointment.is_archived = false
      AND appointment.status = 'in_progress'
      AND appointment.service_started_at IS NOT NULL
      AND appointment.service_ended_at IS NULL
      AND appointment.service_started_at
        + make_interval(mins => service_duration.service_duration_minutes) <= v_now
      AND COALESCE(appointment.completion_notification_snoozed_until, v_now) <= v_now
      AND NOT EXISTS (
        SELECT 1
        FROM public.notifications AS notification
        WHERE notification.appointment_id = appointment.id
          AND notification.type = 'service_completion'
          AND notification.is_read = false
      )
    FOR UPDATE OF appointment SKIP LOCKED
  ),
  inserted AS (
    INSERT INTO public.notifications (type, title, message, appointment_id)
    SELECT
      'service_completion',
      'Service duration ended: ' || due.reference_code,
      'The expected service duration for ' || due.customer_name || ' has ended.',
      due.id
    FROM due_appointments AS due
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT v_created + count(*) INTO v_created FROM inserted;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_service_progress_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_service_progress_notifications() TO authenticated;
