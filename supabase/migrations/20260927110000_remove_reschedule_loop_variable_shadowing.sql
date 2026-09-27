-- The loop variables are declared by PL/pgSQL's FOR statements. Declaring
-- them again makes db lint report shadowed, unused locals without changing the
-- rescheduling workflow.
CREATE OR REPLACE FUNCTION public.submit_reschedule_request(
  p_appointment_id uuid,
  p_request_id uuid,
  p_appointment_date date,
  p_start_time time,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_appointment public.appointments%ROWTYPE;
  v_reference_code text;
  v_reference_available boolean := false;
  v_reference_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
  IF p_request_id IS NULL OR p_appointment_date IS NULL OR p_start_time IS NULL
     OR NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'A date, time, and rescheduling reason are required.';
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
  IF v_appointment.pending_reschedule_request_id IS NOT NULL
     AND v_appointment.pending_reschedule_request_id <> p_request_id THEN
    RAISE EXCEPTION 'A reschedule request is already awaiting review.';
  END IF;
  IF v_appointment.reschedule_count >= 3 THEN
    RAISE EXCEPTION 'This appointment has reached the maximum of 3 reschedules.';
  END IF;
  IF v_appointment.status NOT IN ('pending', 'confirmed')
     OR v_appointment.rescheduled_to_appointment_id IS NOT NULL THEN
    RAISE EXCEPTION 'This appointment can no longer be rescheduled.';
  END IF;

  v_reference_code := v_appointment.pending_reschedule_reference_code;
  IF v_reference_code IS NULL THEN
    FOR v_attempt IN 1..10 LOOP
      v_reference_code := 'FRM-';
      FOR v_character IN 1..6 LOOP
        v_reference_code := v_reference_code || substr(
          v_reference_alphabet,
          1 + floor(random() * length(v_reference_alphabet))::integer,
          1
        );
      END LOOP;

      SELECT NOT EXISTS (
        SELECT 1
        FROM public.appointments
        WHERE reference_code = v_reference_code
           OR pending_reschedule_reference_code = v_reference_code
      ) INTO v_reference_available;
      EXIT WHEN v_reference_available;
    END LOOP;

    IF NOT v_reference_available THEN
      RAISE EXCEPTION 'Could not generate a unique booking reference. Please try again.';
    END IF;
  END IF;

  UPDATE public.appointments
  SET pending_reschedule_request_id = p_request_id,
      pending_reschedule_date = p_appointment_date,
      pending_reschedule_start_time = p_start_time,
      pending_reschedule_reference_code = v_reference_code,
      pending_reschedule_reason = NULLIF(btrim(p_reason), '')
  WHERE id = v_appointment.id;

  IF v_appointment.pending_reschedule_request_id IS NULL THEN
    INSERT INTO public.notifications (type, title, message, appointment_id)
    VALUES (
      'reschedule_request',
      'Reschedule request ' || v_appointment.reference_code,
      v_appointment.customer_name || ' requested ' || to_char(p_appointment_date, 'Mon FMDD, YYYY')
        || ' at ' || to_char(p_start_time, 'HH12:MI AM') || '. New reference: '
        || v_reference_code || '. Reason: ' || btrim(p_reason),
      v_appointment.id
    );
  END IF;
END;
$$;
