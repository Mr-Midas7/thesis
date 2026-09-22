-- Restore the established tracker behavior after the approval-RPC correction.
-- A confirmed reschedule clears its request while linking a replacement; that
-- is not a rejected request.
CREATE OR REPLACE FUNCTION public.track_appointment_reschedule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.appointment_date IS DISTINCT FROM OLD.appointment_date
     OR NEW.start_time IS DISTINCT FROM OLD.start_time THEN
    IF OLD.reschedule_count >= 3 THEN
      RAISE EXCEPTION 'This appointment has reached the maximum of 3 reschedules.';
    END IF;

    NEW.reschedule_count := OLD.reschedule_count + 1;
    NEW.last_reschedule_rejected_at := NULL;
    NEW.last_reschedule_rejection_message := NULL;
  ELSIF OLD.pending_reschedule_request_id IS NULL
     AND NEW.pending_reschedule_request_id IS NOT NULL THEN
    NEW.last_reschedule_rejected_at := NULL;
    NEW.last_reschedule_rejection_message := NULL;
  ELSIF OLD.pending_reschedule_request_id IS NOT NULL
     AND NEW.pending_reschedule_request_id IS NULL THEN
    IF NEW.status = 'rescheduled' AND NEW.rescheduled_to_appointment_id IS NOT NULL THEN
      NEW.last_reschedule_rejected_at := NULL;
      NEW.last_reschedule_rejection_message := NULL;
    ELSE
      NEW.last_reschedule_rejected_at := now();
      NEW.last_reschedule_rejection_message :=
        'Reschedule Request Rejected. Your requested reschedule was not approved. Your original appointment remains unchanged and reserved.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
