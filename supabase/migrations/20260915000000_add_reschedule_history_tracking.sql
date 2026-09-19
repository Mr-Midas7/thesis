-- A dedicated audit trail for each reschedule decision (confirmed or rejected).
-- The admin console reads this table to show the date, time, and reason of every
-- reschedule attempt on an appointment, in chronological order.

CREATE TABLE IF NOT EXISTS public.appointment_reschedule_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  new_appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  reschedule_number integer NOT NULL CHECK (reschedule_number BETWEEN 1 AND 3),
  from_date date NOT NULL,
  from_start_time time NOT NULL,
  to_date date,
  to_start_time time,
  reason text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
  approved_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS appointment_reschedule_history_appointment_id_idx
  ON public.appointment_reschedule_history (appointment_id);

CREATE INDEX IF NOT EXISTS appointment_reschedule_history_new_appointment_id_idx
  ON public.appointment_reschedule_history (new_appointment_id);

CREATE INDEX IF NOT EXISTS appointment_reschedule_history_reschedule_number_idx
  ON public.appointment_reschedule_history (appointment_id, reschedule_number);

ALTER TABLE public.appointment_reschedule_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reschedule history admin all" ON public.appointment_reschedule_history;
CREATE POLICY "reschedule history admin all" ON public.appointment_reschedule_history
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

GRANT SELECT ON public.appointment_reschedule_history TO authenticated;
GRANT ALL ON public.appointment_reschedule_history TO service_role;

-- Re-surface the review function so every decision is audited in the history table.
-- The function body is reproduced from 20260914100000 with two INSERT statements added:
-- one in the reject branch and one at the end of the confirm branch.
CREATE OR REPLACE FUNCTION public.review_reschedule_request(
  p_appointment_id uuid,
  p_decision text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_appointment public.appointments%ROWTYPE;
  v_assigned_crew_id uuid;
  v_duration_minutes integer;
  v_new_appointment_id uuid;
  v_new_reference_code text;
  v_reason text;
  v_original_shop_notes text;
  v_new_shop_notes text;
  v_reschedule_number integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can review reschedule requests.';
  END IF;
  IF lower(btrim(COALESCE(p_decision, ''))) NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'Choose either confirmed or rejected.';
  END IF;

  -- Lock the original request so it can produce at most one replacement.
  SELECT appointment.*
    INTO v_appointment
  FROM public.appointments AS appointment
  WHERE appointment.id = p_appointment_id
    AND appointment.is_archived = false
  FOR UPDATE;

  IF NOT FOUND OR v_appointment.pending_reschedule_request_id IS NULL THEN
    RAISE EXCEPTION 'This reschedule request is no longer available.';
  END IF;

  v_reschedule_number := v_appointment.reschedule_count + 1;

  IF lower(btrim(p_decision)) = 'rejected' THEN
    INSERT INTO public.appointment_reschedule_history (
      appointment_id,
      new_appointment_id,
      reschedule_number,
      from_date,
      from_start_time,
      to_date,
      to_start_time,
      reason,
      decision,
      approved_by
    ) VALUES (
      v_appointment.id,
      NULL,
      v_reschedule_number,
      v_appointment.appointment_date,
      v_appointment.start_time,
      v_appointment.pending_reschedule_date,
      v_appointment.pending_reschedule_start_time,
      btrim(v_appointment.pending_reschedule_reason),
      'rejected',
      auth.uid()
    );

    UPDATE public.appointments
    SET pending_reschedule_request_id = NULL,
        pending_reschedule_date = NULL,
        pending_reschedule_start_time = NULL,
        pending_reschedule_reference_code = NULL,
        pending_reschedule_reason = NULL
    WHERE id = v_appointment.id;
    RETURN;
  END IF;

  IF v_appointment.reschedule_count >= 3 THEN
    RAISE EXCEPTION 'This appointment has reached the maximum of 3 reschedules.';
  END IF;
  IF v_appointment.pending_reschedule_date IS NULL
     OR v_appointment.pending_reschedule_start_time IS NULL
     OR NULLIF(btrim(v_appointment.pending_reschedule_reason), '') IS NULL THEN
    RAISE EXCEPTION 'The reschedule request is missing its requested schedule or reason.';
  END IF;

  v_duration_minutes := COALESCE(v_appointment.booking_duration_minutes, 75);
  v_reason := btrim(v_appointment.pending_reschedule_reason);

  IF EXISTS (
    SELECT 1
    FROM public.schedule_blocks AS block
    WHERE block.block_date = v_appointment.pending_reschedule_date
      AND block.is_active = true
      AND (
        block.start_time IS NULL
        OR (
          block.start_time IS NOT NULL
          AND (
            (COALESCE(block.reason, '') NOT LIKE 'RANGE:%'
             AND block.start_time = v_appointment.pending_reschedule_start_time)
            OR (COALESCE(block.reason, '') LIKE 'RANGE:%'
             AND tsrange(
               v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
               v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
                 + make_interval(mins => v_duration_minutes),
               '[)'
             ) && tsrange(
               v_appointment.pending_reschedule_date + block.start_time,
               v_appointment.pending_reschedule_date
                 + substring(block.reason FROM '^RANGE:([0-9]{2}:[0-9]{2})')::time,
               '[)'
             ))
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'The requested time is no longer available because the shop schedule is blocked.';
  END IF;

  -- Re-check capacity, crew schedules, and crew availability immediately before
  -- creating the replacement booking.
  SELECT crew.id
    INTO v_assigned_crew_id
  FROM public.crew_members AS crew
  WHERE crew.is_active = true
    AND crew.is_archived = false
    AND EXISTS (
      SELECT 1
      FROM public.time_slots AS slot
      WHERE slot.is_active = true
        AND slot.start_time = v_appointment.pending_reschedule_start_time
        AND slot.capacity > (
          SELECT count(*)
          FROM public.appointments AS other
          WHERE other.id <> v_appointment.id
            AND other.appointment_date = v_appointment.pending_reschedule_date
            AND other.is_archived = false
            AND other.rescheduled_to_appointment_id IS NULL
            AND other.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
          AND tsrange(
            other.appointment_date + other.start_time,
            other.appointment_date + other.start_time
              + make_interval(mins => COALESCE(other.booking_duration_minutes, 75)), '[)'
          ) && tsrange(
            v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
            v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
              + make_interval(mins => v_duration_minutes), '[)'
          )
        )
    )
    AND EXISTS (
      SELECT 1
      FROM public.crew_schedules AS schedule
      WHERE schedule.crew_id = crew.id
        AND schedule.schedule_date = v_appointment.pending_reschedule_date
        AND schedule.is_working = true
        AND schedule.start_time <= v_appointment.pending_reschedule_start_time
        AND schedule.end_time >= v_appointment.pending_reschedule_start_time
          + make_interval(mins => v_duration_minutes)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.crew_availability_exceptions AS exception
      WHERE exception.crew_id = crew.id
        AND exception.start_date <= v_appointment.pending_reschedule_date
        AND exception.end_date >= v_appointment.pending_reschedule_date
        AND (exception.is_all_day OR (
          exception.start_time IS NOT NULL AND exception.end_time IS NOT NULL
          AND tsrange(
            v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
            v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
              + make_interval(mins => v_duration_minutes), '[)'
          ) && tsrange(
            v_appointment.pending_reschedule_date + exception.start_time,
            v_appointment.pending_reschedule_date + exception.end_time, '[)'
          )
        ))
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.appointments AS other
      WHERE other.id <> v_appointment.id
        AND other.assigned_crew_id = crew.id
        AND other.appointment_date = v_appointment.pending_reschedule_date
        AND other.is_archived = false
        AND other.rescheduled_to_appointment_id IS NULL
        AND other.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
        AND tsrange(
          other.appointment_date + other.start_time,
          other.appointment_date + other.start_time
            + make_interval(mins => COALESCE(other.booking_duration_minutes, 75)), '[)'
        ) && tsrange(
          v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time,
          v_appointment.pending_reschedule_date + v_appointment.pending_reschedule_start_time
            + make_interval(mins => v_duration_minutes), '[)'
        )
    )
  ORDER BY (crew.id = v_appointment.assigned_crew_id) DESC, crew.name, crew.id
  LIMIT 1;

  IF v_assigned_crew_id IS NULL THEN
    RAISE EXCEPTION 'No crew member is available for the requested appointment period.';
  END IF;

  -- The customer receives this reserved code immediately after confirming the
  -- request. Approval must create the replacement with the same reference.
  v_new_reference_code := v_appointment.pending_reschedule_reference_code;
  IF v_new_reference_code IS NULL
     OR v_new_reference_code !~ '^FRM-[A-Z0-9]{6}$' THEN
    RAISE EXCEPTION 'The reschedule request is missing its replacement reference.';
  END IF;

  v_original_shop_notes := concat_ws(
    E'\n',
    NULLIF(btrim(v_appointment.admin_notes), ''),
    'Rescheduled to ' || v_new_reference_code,
    'Reason for rescheduling: ' || v_reason
  );
  v_new_shop_notes := concat_ws(
    E'\n',
    'Rescheduled from ' || v_appointment.reference_code,
    'Reason for rescheduling: ' || v_reason
  );

  INSERT INTO public.appointments AS replacement (
    reference_code,
    booking_request_id,
    customer_name,
    first_name,
    middle_name,
    last_name,
    phone,
    email,
    moto_brand,
    moto_model,
    moto_cc,
    moto_fuel_type,
    moto_transmission,
    moto_variant,
    moto_year,
    plate_number,
    appointment_date,
    start_time,
    status,
    notes,
    admin_notes,
    total_estimate,
    booking_duration_minutes,
    terms_accepted,
    assigned_crew_id,
    reschedule_count,
    rescheduled_from_appointment_id
  )
  VALUES (
    v_new_reference_code,
    gen_random_uuid(),
    v_appointment.customer_name,
    v_appointment.first_name,
    v_appointment.middle_name,
    v_appointment.last_name,
    v_appointment.phone,
    v_appointment.email,
    v_appointment.moto_brand,
    v_appointment.moto_model,
    v_appointment.moto_cc,
    v_appointment.moto_fuel_type,
    v_appointment.moto_transmission,
    v_appointment.moto_variant,
    v_appointment.moto_year,
    v_appointment.plate_number,
    v_appointment.pending_reschedule_date,
    v_appointment.pending_reschedule_start_time,
    'confirmed',
    v_appointment.notes,
    v_new_shop_notes,
    v_appointment.total_estimate,
    v_duration_minutes,
    v_appointment.terms_accepted,
    v_assigned_crew_id,
    v_appointment.reschedule_count + 1,
    v_appointment.id
  )
  RETURNING replacement.id INTO v_new_appointment_id;

  INSERT INTO public.appointment_services (
    appointment_id,
    service_id,
    service_name,
    price,
    duration_minutes
  )
  SELECT
    v_new_appointment_id,
    service.service_id,
    service.service_name,
    service.price,
    service.duration_minutes
  FROM public.appointment_services AS service
  WHERE service.appointment_id = v_appointment.id;

  UPDATE public.appointments
  SET status = 'rescheduled',
      admin_notes = v_original_shop_notes,
      reschedule_count = v_appointment.reschedule_count + 1,
      rescheduled_to_appointment_id = v_new_appointment_id,
      pending_reschedule_request_id = NULL,
      pending_reschedule_date = NULL,
      pending_reschedule_start_time = NULL,
      pending_reschedule_reference_code = NULL,
      pending_reschedule_reason = NULL
  WHERE id = v_appointment.id;

  INSERT INTO public.notifications (type, title, message, appointment_id)
  VALUES (
    'rescheduled_appointment',
    'Rescheduled booking ' || v_new_reference_code,
    v_appointment.customer_name || ' rescheduled from ' || v_appointment.reference_code
      || ' to ' || v_new_reference_code || '. Reason: ' || v_reason,
    v_new_appointment_id
  );

  INSERT INTO public.appointment_reschedule_history (
    appointment_id,
    new_appointment_id,
    reschedule_number,
    from_date,
    from_start_time,
    to_date,
    to_start_time,
    reason,
    decision,
    approved_by
  ) VALUES (
    v_appointment.id,
    v_new_appointment_id,
    v_reschedule_number,
    v_appointment.appointment_date,
    v_appointment.start_time,
    v_appointment.pending_reschedule_date,
    v_appointment.pending_reschedule_start_time,
    v_reason,
    'confirmed',
    auth.uid()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_reschedule_request(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_reschedule_request(uuid, text) TO authenticated;
