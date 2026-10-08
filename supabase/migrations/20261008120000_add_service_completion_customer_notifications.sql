-- Completion notifications are separate from booking-confirmation notices so
-- each channel is delivered at most once after a service is actually completed.
CREATE TABLE IF NOT EXISTS public.appointment_completion_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, channel)
);

REVOKE ALL ON TABLE public.appointment_completion_notifications FROM anon, authenticated;
GRANT ALL ON TABLE public.appointment_completion_notifications TO service_role;
ALTER TABLE public.appointment_completion_notifications ENABLE ROW LEVEL SECURITY;

-- Completion is valid only from an active service. This protects the editor
-- and API paths alike, and records a durable completion timestamp for notices.
CREATE OR REPLACE FUNCTION public.validate_appointment_completion_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    IF OLD.status <> 'in_progress' OR OLD.service_started_at IS NULL OR OLD.service_ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'Start the service before marking the appointment completed.';
    END IF;
    NEW.service_ended_at := COALESCE(NEW.service_ended_at, now());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_validate_completion_transition ON public.appointments;
CREATE TRIGGER appointments_validate_completion_transition
  BEFORE UPDATE OF status ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_appointment_completion_transition();

CREATE OR REPLACE FUNCTION public.queue_appointment_completion_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'completed' OR OLD.status IS NOT DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;

  IF NULLIF(btrim(NEW.email), '') IS NOT NULL THEN
    INSERT INTO public.appointment_completion_notifications (appointment_id, channel, recipient)
    VALUES (NEW.id, 'email', lower(btrim(NEW.email)))
    ON CONFLICT (appointment_id, channel) DO NOTHING;
  END IF;

  IF NULLIF(btrim(NEW.phone), '') IS NOT NULL THEN
    INSERT INTO public.appointment_completion_notifications (appointment_id, channel, recipient)
    VALUES (NEW.id, 'sms', btrim(NEW.phone))
    ON CONFLICT (appointment_id, channel) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_queue_completion_notifications ON public.appointments;
CREATE TRIGGER appointments_queue_completion_notifications
  AFTER UPDATE OF status ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_appointment_completion_notifications();
