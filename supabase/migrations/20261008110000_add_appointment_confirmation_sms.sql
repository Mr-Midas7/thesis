-- SMS notifications are queued only after an appointment has actually been
-- confirmed. The server claims and delivers them with the TextBee API key;
-- browser clients cannot read or modify this queue.
CREATE TABLE IF NOT EXISTS public.appointment_confirmation_sms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL UNIQUE REFERENCES public.appointments(id) ON DELETE CASCADE,
  recipient_phone text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE public.appointment_confirmation_sms FROM anon, authenticated;
GRANT ALL ON TABLE public.appointment_confirmation_sms TO service_role;
ALTER TABLE public.appointment_confirmation_sms ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.queue_appointment_confirmation_sms()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A pending or rejected booking must never notify the customer. For a
  -- reschedule, the replacement appointment is inserted as confirmed, which
  -- queues its own notification after the approval transaction succeeds.
  IF NEW.status <> 'confirmed' OR NULLIF(btrim(NEW.phone), '') IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'confirmed' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.appointment_confirmation_sms (appointment_id, recipient_phone)
  VALUES (NEW.id, btrim(NEW.phone))
  ON CONFLICT (appointment_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_queue_confirmation_sms ON public.appointments;
DROP TRIGGER IF EXISTS appointments_queue_confirmation_sms_on_insert ON public.appointments;
CREATE TRIGGER appointments_queue_confirmation_sms
  AFTER UPDATE OF status ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_appointment_confirmation_sms();

CREATE TRIGGER appointments_queue_confirmation_sms_on_insert
  AFTER INSERT ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_appointment_confirmation_sms();
