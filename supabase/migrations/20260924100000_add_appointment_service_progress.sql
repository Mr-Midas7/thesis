-- Persist actual service timing and the small amount of state needed to make
-- service-progress notifications durable across refreshes and admin sessions.
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS service_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS service_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_notification_snooze_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arrival_notification_snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS completion_notification_snoozed_until timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'appointments_arrival_notification_snooze_count_check'
      AND conrelid = 'public.appointments'::regclass
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_arrival_notification_snooze_count_check
      CHECK (arrival_notification_snooze_count BETWEEN 0 AND 3);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'appointments_service_progress_timestamp_check'
      AND conrelid = 'public.appointments'::regclass
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_service_progress_timestamp_check
      CHECK (
        service_ended_at IS NULL
        OR (service_started_at IS NOT NULL AND service_ended_at >= service_started_at)
      );
  END IF;
END;
$$;

COMMENT ON COLUMN public.appointments.service_started_at IS
  'Actual server-recorded start time of the appointment service.';
COMMENT ON COLUMN public.appointments.service_ended_at IS
  'Actual server-recorded completion time of the appointment service.';

CREATE INDEX IF NOT EXISTS appointments_service_progress_arrival_idx
  ON public.appointments (appointment_date, start_time)
  WHERE is_archived = false AND status = 'confirmed' AND service_started_at IS NULL;

CREATE INDEX IF NOT EXISTS appointments_service_progress_completion_idx
  ON public.appointments (service_started_at)
  WHERE is_archived = false
    AND status = 'in_progress'
    AND service_started_at IS NOT NULL
    AND service_ended_at IS NULL;

-- Only one currently actionable alert of each progress type may exist for an
-- appointment. This is the final guard against concurrent admin sessions or
-- overlapping client polling intervals creating duplicate notifications.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_active_service_progress_unique
  ON public.notifications (appointment_id, type)
  WHERE is_read = false
    AND type IN ('service_arrival', 'service_completion');

-- A manual status edit must have the same timestamp behavior as an action
-- selected from the notification inbox.
CREATE OR REPLACE FUNCTION public.track_appointment_service_progress()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'in_progress' THEN
    IF OLD.service_ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'A completed service cannot be restarted.';
    END IF;

    NEW.service_started_at := COALESCE(NEW.service_started_at, now());
    NEW.service_ended_at := NULL;
  ELSIF NEW.status = 'completed' THEN
    IF NEW.service_started_at IS NULL THEN
      RAISE EXCEPTION 'Start the service before marking the appointment completed.';
    END IF;

    NEW.service_ended_at := COALESCE(NEW.service_ended_at, now());
  ELSIF NEW.status = 'no_show' THEN
    IF NEW.service_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'An appointment with a recorded service start cannot be marked as no-show.';
    END IF;
    IF NEW.arrival_notification_snooze_count < 3 THEN
      RAISE EXCEPTION 'An appointment can be marked as no-show after three arrival snoozes.';
    END IF;
  ELSIF OLD.service_started_at IS NOT NULL
    AND NEW.status IN ('pending', 'confirmed', 'rescheduled', 'cancelled', 'rejected') THEN
    RAISE EXCEPTION 'A started service cannot return to a pre-service appointment status.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_track_service_progress ON public.appointments;
CREATE TRIGGER appointments_track_service_progress
  BEFORE UPDATE OF status ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.track_appointment_service_progress();

-- Resolve outstanding workflow alerts when an appointment is changed outside
-- the dedicated progress RPC (for example, from Edit Appointment).
CREATE OR REPLACE FUNCTION public.resolve_appointment_service_progress_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_archived = true
     OR NEW.status NOT IN ('confirmed', 'in_progress') THEN
    UPDATE public.notifications
    SET is_read = true
    WHERE appointment_id = NEW.id
      AND is_read = false
      AND type IN ('service_arrival', 'service_completion');
  ELSIF NEW.status = 'in_progress' THEN
    UPDATE public.notifications
    SET is_read = true
    WHERE appointment_id = NEW.id
      AND is_read = false
      AND type = 'service_arrival';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_resolve_service_progress_notifications ON public.appointments;
CREATE TRIGGER appointments_resolve_service_progress_notifications
  AFTER UPDATE OF status, is_archived ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.resolve_appointment_service_progress_notifications();

-- Keep activity logs focused on the administrator's decisions. The appointment
-- update trigger still records starts, snoozes, no-shows, and completions;
-- this only suppresses automatic inbox rows created by the scheduler.
DROP TRIGGER IF EXISTS admin_activity_notifications ON public.notifications;
CREATE TRIGGER admin_activity_notifications
  AFTER INSERT OR UPDATE ON public.notifications
  FOR EACH ROW
  WHEN (NEW.type NOT IN ('service_arrival', 'service_completion'))
  EXECUTE FUNCTION public.record_admin_activity();

DROP TRIGGER IF EXISTS admin_activity_notifications_delete ON public.notifications;
CREATE TRIGGER admin_activity_notifications_delete
  AFTER DELETE ON public.notifications
  FOR EACH ROW
  WHEN (OLD.type NOT IN ('service_arrival', 'service_completion'))
  EXECUTE FUNCTION public.record_admin_activity();

-- Insert alerts only once they are due. This function is intentionally
-- idempotent and uses server time, so browser clocks and repeated polls cannot
-- change the workflow's timing.
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

  WITH inserted AS (
    INSERT INTO public.notifications (type, title, message, appointment_id)
    SELECT
      'service_arrival',
      'Customer expected: ' || appointment.reference_code,
      appointment.customer_name || ' is scheduled to arrive for service now.',
      appointment.id
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
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM inserted;

  WITH inserted AS (
    INSERT INTO public.notifications (type, title, message, appointment_id)
    SELECT
      'service_completion',
      'Service duration ended: ' || appointment.reference_code,
      'The expected service duration for ' || appointment.customer_name || ' has ended.',
      appointment.id
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
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT v_created + count(*) INTO v_created FROM inserted;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_service_progress_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_service_progress_notifications() TO authenticated;

-- Keep every operator decision and its notification state update in one row
-- lock-protected transaction. The five-minute value is the requested snooze
-- period; all service duration calculations come from persisted services.
CREATE OR REPLACE FUNCTION public.manage_appointment_service_progress(
  p_appointment_id uuid,
  p_action text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_appointment public.appointments%ROWTYPE;
  v_action text := lower(btrim(COALESCE(p_action, '')));
  v_snooze_interval interval := interval '5 minutes';
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can update service progress.';
  END IF;

  IF v_action NOT IN (
    'start', 'snooze_arrival', 'no_show', 'complete', 'snooze_completion'
  ) THEN
    RAISE EXCEPTION 'Choose a valid service progress action.';
  END IF;

  SELECT appointment.*
    INTO v_appointment
  FROM public.appointments AS appointment
  WHERE appointment.id = p_appointment_id
    AND appointment.is_archived = false
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This appointment is no longer available.';
  END IF;

  IF v_action = 'start' THEN
    IF v_appointment.status NOT IN ('pending', 'confirmed')
       OR v_appointment.service_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'This appointment cannot be started.';
    END IF;

    UPDATE public.appointments
    SET status = 'in_progress',
        service_started_at = COALESCE(service_started_at, now()),
        service_ended_at = NULL,
        arrival_notification_snoozed_until = NULL
    WHERE id = v_appointment.id;

  ELSIF v_action = 'snooze_arrival' THEN
    IF v_appointment.status <> 'confirmed' OR v_appointment.service_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'This arrival reminder is no longer available.';
    END IF;
    IF v_appointment.arrival_notification_snooze_count >= 3 THEN
      RAISE EXCEPTION 'The maximum of three arrival snoozes has been reached.';
    END IF;

    UPDATE public.appointments
    SET arrival_notification_snooze_count = arrival_notification_snooze_count + 1,
        arrival_notification_snoozed_until = now() + v_snooze_interval
    WHERE id = v_appointment.id;

    UPDATE public.notifications
    SET is_read = true
    WHERE appointment_id = v_appointment.id
      AND type = 'service_arrival'
      AND is_read = false;

  ELSIF v_action = 'no_show' THEN
    IF v_appointment.status <> 'confirmed' OR v_appointment.service_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'This appointment cannot be marked as no-show.';
    END IF;
    IF v_appointment.arrival_notification_snooze_count < 3 THEN
      RAISE EXCEPTION 'The appointment can be marked as no-show after three arrival snoozes.';
    END IF;

    UPDATE public.appointments
    SET status = 'no_show',
        arrival_notification_snoozed_until = NULL
    WHERE id = v_appointment.id;

  ELSIF v_action = 'complete' THEN
    IF v_appointment.status <> 'in_progress'
       OR v_appointment.service_started_at IS NULL
       OR v_appointment.service_ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'This service cannot be marked as completed.';
    END IF;

    UPDATE public.appointments
    SET status = 'completed',
        service_ended_at = COALESCE(service_ended_at, now()),
        completion_notification_snoozed_until = NULL
    WHERE id = v_appointment.id;

  ELSE
    IF v_appointment.status <> 'in_progress'
       OR v_appointment.service_started_at IS NULL
       OR v_appointment.service_ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'This completion reminder is no longer available.';
    END IF;

    UPDATE public.appointments
    SET completion_notification_snoozed_until = now() + v_snooze_interval
    WHERE id = v_appointment.id;

    UPDATE public.notifications
    SET is_read = true
    WHERE appointment_id = v_appointment.id
      AND type = 'service_completion'
      AND is_read = false;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.manage_appointment_service_progress(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manage_appointment_service_progress(uuid, text) TO authenticated;
