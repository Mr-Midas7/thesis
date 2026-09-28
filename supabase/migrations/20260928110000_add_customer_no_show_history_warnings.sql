-- Record the customer's no-show history when a booking is created, then use
-- that immutable snapshot to show administrators a warning on the booking.
-- The history count intentionally includes archived appointments: archiving a
-- record must not erase a customer's recorded no-shows.

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS no_show_count_at_booking integer NOT NULL DEFAULT 0
  CHECK (no_show_count_at_booking >= 0);

CREATE OR REPLACE FUNCTION public.capture_customer_no_show_count_at_booking()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT count(*)::integer
  INTO NEW.no_show_count_at_booking
  FROM public.appointments AS appointment
  WHERE appointment.phone = NEW.phone
    -- A row can have only one status, so cancelled and completed appointments
    -- are never included in this recorded no-show history.
    AND appointment.status = 'no_show';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_capture_customer_no_show_count ON public.appointments;
CREATE TRIGGER appointments_capture_customer_no_show_count
  BEFORE INSERT ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.capture_customer_no_show_count_at_booking();

CREATE OR REPLACE FUNCTION public.notify_customer_no_show_threshold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_no_show_count integer;
BEGIN
  -- This supports both the normal admin workflow and any trusted import that
  -- creates an already-recorded no-show. Repeated updates to a no-show row do
  -- not create duplicate alerts.
  IF NEW.status <> 'no_show'
     OR (TG_OP = 'UPDATE' AND OLD.status = 'no_show') THEN
    RETURN NEW;
  END IF;

  -- Concurrent status changes for the same customer must see one another
  -- before deciding whether this is the threshold-crossing no-show.
  PERFORM pg_advisory_xact_lock(
    hashtext('customer-no-show-threshold:' || COALESCE(NEW.phone, ''))
  );

  SELECT count(*)::integer
  INTO v_no_show_count
  FROM public.appointments AS appointment
  WHERE appointment.phone = NEW.phone
    AND appointment.status = 'no_show';

  -- Notify once when the customer exceeds two recorded no-shows. If the count
  -- later falls below the threshold and reaches it again, the new crossing is
  -- correctly reported again.
  IF v_no_show_count = 3 THEN
    INSERT INTO public.notifications (type, title, message, appointment_id)
    VALUES (
      'customer_no_show_threshold',
      'Customer no-show threshold reached',
      COALESCE(NULLIF(btrim(NEW.customer_name), ''), NEW.phone)
        || ' (' || NEW.phone || ') now has ' || v_no_show_count
        || ' recorded no-shows. Review the customer''s booking history before accepting future work.',
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_notify_customer_no_show_threshold ON public.appointments;
CREATE TRIGGER appointments_notify_customer_no_show_threshold
  AFTER INSERT OR UPDATE OF status ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_customer_no_show_threshold();

REVOKE ALL ON FUNCTION public.capture_customer_no_show_count_at_booking() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_customer_no_show_threshold() FROM PUBLIC;
