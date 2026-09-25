-- Keep service-progress alerts tied to the active service timeline. Arrival
-- alerts expire at the scheduled service end unless an admin explicitly
-- snoozed them; completion alerts remain active until the service is completed.

CREATE OR REPLACE FUNCTION public.resolve_appointment_service_progress_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_service_duration_minutes integer := 0;
  v_scheduled_start timestamptz;
  v_expected_completion timestamptz;
BEGIN
  SELECT COALESCE(sum(service.duration_minutes), 0)::integer
    INTO v_service_duration_minutes
  FROM public.appointment_services AS service
  WHERE service.appointment_id = NEW.id;

  v_scheduled_start := (NEW.appointment_date + NEW.start_time) AT TIME ZONE 'Asia/Manila';
  v_expected_completion := CASE
    WHEN NEW.service_started_at IS NOT NULL
      THEN NEW.service_started_at + make_interval(mins => v_service_duration_minutes)
    ELSE NULL
  END;

  UPDATE public.notifications AS notification
  SET is_read = true
  WHERE notification.appointment_id = NEW.id
    AND notification.is_read = false
    AND notification.type IN ('service_arrival', 'service_completion')
    AND (
      NEW.is_archived = true
      OR NEW.rescheduled_to_appointment_id IS NOT NULL
      OR (
        notification.type = 'service_arrival'
        AND (
          NEW.status <> 'confirmed'
          OR NEW.service_started_at IS NOT NULL
          OR v_scheduled_start > v_now
          OR (
            NEW.arrival_notification_snoozed_until IS NULL
            AND (
              v_service_duration_minutes <= 0
              OR v_scheduled_start + make_interval(mins => v_service_duration_minutes) <= v_now
            )
          )
        )
      )
      OR (
        notification.type = 'service_completion'
        AND (
          NEW.status <> 'in_progress'
          OR NEW.service_started_at IS NULL
          OR NEW.service_ended_at IS NOT NULL
          OR v_service_duration_minutes <= 0
          OR v_expected_completion > v_now
        )
      )
    );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_resolve_service_progress_notifications ON public.appointments;
CREATE TRIGGER appointments_resolve_service_progress_notifications
  AFTER UPDATE OF status, is_archived, appointment_date, start_time, service_started_at, service_ended_at
  ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.resolve_appointment_service_progress_notifications();

CREATE OR REPLACE FUNCTION public.sync_service_progress_notifications()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_changed integer := 0;
  v_now timestamptz := now();
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can synchronize service progress notifications.';
  END IF;

  -- Lock appointments before their related notification rows. This matches the
  -- action RPC's locking order and lets a concurrent start, snooze, no-show,
  -- or completion win without stale rows or deadlocks.
  WITH timeline AS (
    SELECT
      appointment.id,
      appointment.status,
      appointment.is_archived,
      appointment.rescheduled_to_appointment_id,
      appointment.service_started_at,
      appointment.service_ended_at,
      appointment.arrival_notification_snoozed_until,
      appointment.completion_notification_snoozed_until,
      (appointment.appointment_date + appointment.start_time) AT TIME ZONE 'Asia/Manila'
        AS scheduled_start,
      COALESCE(service_duration.service_duration_minutes, 0) AS service_duration_minutes
    FROM public.appointments AS appointment
    LEFT JOIN LATERAL (
      SELECT sum(service.duration_minutes)::integer AS service_duration_minutes
      FROM public.appointment_services AS service
      WHERE service.appointment_id = appointment.id
    ) AS service_duration ON true
    WHERE EXISTS (
      SELECT 1
      FROM public.notifications AS notification
      WHERE notification.appointment_id = appointment.id
        AND notification.is_read = false
        AND notification.type IN ('service_arrival', 'service_completion')
    )
    FOR UPDATE OF appointment SKIP LOCKED
  ),
  resolved AS (
    UPDATE public.notifications AS notification
    SET is_read = true
    FROM timeline
    WHERE notification.appointment_id = timeline.id
      AND notification.is_read = false
      AND notification.type IN ('service_arrival', 'service_completion')
      AND (
        timeline.is_archived = true
        OR timeline.rescheduled_to_appointment_id IS NOT NULL
        OR (
          notification.type = 'service_arrival'
          AND (
            timeline.status <> 'confirmed'
            OR timeline.service_started_at IS NOT NULL
            OR timeline.scheduled_start > v_now
            OR (
              timeline.arrival_notification_snoozed_until IS NULL
              AND (
                timeline.service_duration_minutes <= 0
                OR timeline.scheduled_start
                  + make_interval(mins => timeline.service_duration_minutes) <= v_now
              )
            )
          )
        )
        OR (
          notification.type = 'service_completion'
          AND (
            timeline.status <> 'in_progress'
            OR timeline.service_started_at IS NULL
            OR timeline.service_ended_at IS NOT NULL
            OR timeline.service_duration_minutes <= 0
            OR timeline.service_started_at
              + make_interval(mins => timeline.service_duration_minutes) > v_now
          )
        )
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_changed FROM resolved;

  WITH due_appointments AS (
    SELECT appointment.id, appointment.reference_code, appointment.customer_name
    FROM public.appointments AS appointment
    JOIN LATERAL (
      SELECT sum(service.duration_minutes)::integer AS service_duration_minutes
      FROM public.appointment_services AS service
      WHERE service.appointment_id = appointment.id
    ) AS service_duration ON service_duration.service_duration_minutes > 0
    WHERE appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status = 'confirmed'
      AND appointment.service_started_at IS NULL
      AND (appointment.appointment_date + appointment.start_time) AT TIME ZONE 'Asia/Manila' <= v_now
      AND COALESCE(appointment.arrival_notification_snoozed_until, v_now) <= v_now
      -- Unsnoozed arrival alerts are relevant only inside the scheduled
      -- service window. A snoozed alert intentionally outlives that window.
      AND (
        appointment.arrival_notification_snoozed_until IS NOT NULL
        OR (appointment.appointment_date + appointment.start_time) AT TIME ZONE 'Asia/Manila'
          + make_interval(mins => service_duration.service_duration_minutes) > v_now
      )
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
  SELECT v_changed + count(*) INTO v_changed FROM inserted;

  WITH due_appointments AS (
    SELECT appointment.id, appointment.reference_code, appointment.customer_name
    FROM public.appointments AS appointment
    JOIN LATERAL (
      SELECT sum(service.duration_minutes)::integer AS service_duration_minutes
      FROM public.appointment_services AS service
      WHERE service.appointment_id = appointment.id
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
  SELECT v_changed + count(*) INTO v_changed FROM inserted;

  RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_service_progress_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_service_progress_notifications() TO authenticated;
