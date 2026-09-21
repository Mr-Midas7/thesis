-- Alert administrators when a customer reaches three customer-initiated
-- cancellations in one Manila calendar month. This is an alert only: it does
-- not block the customer or alter any booking permissions.

CREATE INDEX IF NOT EXISTS appointments_cancelled_phone_month_idx
  ON public.appointments (phone, cancelled_at)
  WHERE status = 'cancelled' AND cancelled_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.cancel_public_appointment(
  p_appointment_id uuid,
  p_cancellation_notice_hours integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_appointment public.appointments%ROWTYPE;
  v_month_start timestamptz;
  v_month_end timestamptz;
  v_month_label text;
  v_monthly_cancellation_count integer;
BEGIN
  IF p_appointment_id IS NULL
     OR p_cancellation_notice_hours IS NULL
     OR p_cancellation_notice_hours < 0
     OR p_cancellation_notice_hours > 168 THEN
    RAISE EXCEPTION 'Invalid cancellation request.';
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
  IF v_appointment.rescheduled_to_appointment_id IS NOT NULL THEN
    RAISE EXCEPTION 'This appointment has already been rescheduled. Please use the new reference.';
  END IF;
  IF v_appointment.pending_reschedule_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'A reschedule request is already awaiting the shop''s review.';
  END IF;
  IF v_appointment.status NOT IN ('pending', 'confirmed', 'rescheduled') THEN
    RAISE EXCEPTION 'This appointment can no longer be cancelled online. Please call the shop.';
  END IF;
  IF (v_appointment.appointment_date + v_appointment.start_time)
       - (now() AT TIME ZONE 'Asia/Manila')
       < make_interval(hours => p_cancellation_notice_hours) THEN
    RAISE EXCEPTION 'Cancellations need % hours notice. Please call the shop instead.',
      p_cancellation_notice_hours;
  END IF;

  -- Serialize same-customer cancellations for the month so concurrent requests
  -- cannot produce duplicate third-cancellation alerts.
  v_month_start := date_trunc('month', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila';
  v_month_end := v_month_start + interval '1 month';
  v_month_label := to_char(now() AT TIME ZONE 'Asia/Manila', 'FMMonth YYYY');
  PERFORM pg_advisory_xact_lock(
    hashtext(
      'customer-cancellation-threshold:'
      || COALESCE(v_appointment.phone, '')
      || ':'
      || to_char(v_month_start AT TIME ZONE 'Asia/Manila', 'YYYY-MM')
    )
  );

  UPDATE public.appointments
  SET status = 'cancelled',
      cancelled_at = now()
  WHERE id = v_appointment.id;

  INSERT INTO public.notifications (type, title, message, appointment_id)
  VALUES (
    'cancelled_appointment',
    'Cancelled ' || v_appointment.reference_code,
    v_appointment.customer_name || ' cancelled their '
      || to_char(v_appointment.appointment_date, 'Mon FMDD, YYYY') || ' appointment.',
    v_appointment.id
  );

  SELECT count(*)
    INTO v_monthly_cancellation_count
  FROM public.appointments AS appointment
  WHERE appointment.phone = v_appointment.phone
    AND appointment.status = 'cancelled'
    AND appointment.cancelled_at >= v_month_start
    AND appointment.cancelled_at < v_month_end;

  -- Alert exactly once when the threshold is reached; later cancellations in
  -- the same month retain normal cancellation notifications without flooding
  -- the admin queue.
  IF v_monthly_cancellation_count = 3 THEN
    INSERT INTO public.notifications (type, title, message, appointment_id)
    VALUES (
      'customer_cancellation_threshold',
      'Customer cancellation threshold reached',
      COALESCE(NULLIF(btrim(v_appointment.customer_name), ''), v_appointment.phone)
        || ' (' || v_appointment.phone || ') has cancelled 3 appointments in '
        || v_month_label
        || '. Review the customer''s cancellation history and decide whether to block the customer or take no action.',
      v_appointment.id
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_public_appointment(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_public_appointment(uuid, integer) TO service_role;
