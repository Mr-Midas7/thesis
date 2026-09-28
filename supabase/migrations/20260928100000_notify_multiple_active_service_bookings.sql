-- Notify administrators when a customer has two or more active bookings for
-- the same service on different dates. The alert is generated at commit time
-- so public bookings, reschedules, and admin edits all use the final state of
-- the transaction.

CREATE TABLE IF NOT EXISTS public.customer_service_booking_alert_state (
  customer_phone text NOT NULL,
  service_key text NOT NULL,
  is_threshold_active boolean NOT NULL DEFAULT false,
  alert_cycle integer NOT NULL DEFAULT 0 CHECK (alert_cycle >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_phone, service_key)
);

CREATE TABLE IF NOT EXISTS public.customer_service_booking_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_phone text NOT NULL,
  service_key text NOT NULL,
  alert_cycle integer NOT NULL CHECK (alert_cycle > 0),
  active_appointment_ids uuid[] NOT NULL CHECK (cardinality(active_appointment_ids) >= 2),
  notification_id uuid REFERENCES public.notifications(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_phone, service_key, alert_cycle, active_appointment_ids)
);

-- These tables are an internal deduplication ledger. Only the trigger function
-- writes them; administrators continue to use the existing notifications UI.
REVOKE ALL ON TABLE public.customer_service_booking_alert_state FROM anon, authenticated;
REVOKE ALL ON TABLE public.customer_service_booking_alerts FROM anon, authenticated;
GRANT ALL ON TABLE public.customer_service_booking_alert_state TO service_role;
GRANT ALL ON TABLE public.customer_service_booking_alerts TO service_role;
ALTER TABLE public.customer_service_booking_alert_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_service_booking_alerts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.refresh_customer_service_booking_alert(
  p_customer_phone text,
  p_service_id uuid,
  p_service_name text,
  p_preferred_appointment_id uuid,
  p_customer_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_service_key text;
  v_service_label text;
  v_customer_label text;
  v_active_appointment_ids uuid[];
  v_active_booking_count integer;
  v_distinct_booking_date_count integer;
  v_schedule_details text;
  v_notification_appointment_id uuid;
  v_alert_cycle integer;
  v_threshold_was_active boolean;
  v_notification_id uuid;
BEGIN
  IF NULLIF(btrim(p_customer_phone), '') IS NULL
     OR (p_service_id IS NULL AND NULLIF(btrim(p_service_name), '') IS NULL) THEN
    RETURN;
  END IF;

  -- A service ID is the canonical identity. The name fallback supports legacy
  -- appointment-service rows that do not have a service ID.
  v_service_key := COALESCE(
    'id:' || p_service_id::text,
    'name:' || lower(btrim(p_service_name))
  );
  v_service_label := COALESCE(
    NULLIF(btrim(p_service_name), ''),
    (SELECT service.name FROM public.services AS service WHERE service.id = p_service_id),
    'this service'
  );

  -- Serializing per customer lets concurrent bookings see the committed
  -- booking that reached the threshold, while avoiding duplicate alerts.
  PERFORM pg_advisory_xact_lock(
    hashtext('customer-service-booking-alert:' || btrim(p_customer_phone))
  );

  WITH active_bookings AS (
    SELECT DISTINCT
      appointment.id,
      appointment.appointment_date,
      appointment.start_time,
      appointment.customer_name
    FROM public.appointments AS appointment
    JOIN public.appointment_services AS appointment_service
      ON appointment_service.appointment_id = appointment.id
    WHERE appointment.phone = btrim(p_customer_phone)
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status NOT IN ('completed', 'cancelled', 'rejected')
      AND (
        appointment_service.service_id = p_service_id
        OR (
          p_service_id IS NULL
          AND appointment_service.service_id IS NULL
          AND appointment_service.service_name = p_service_name
        )
      )
  )
  SELECT
    COALESCE(array_agg(appointment.id ORDER BY appointment.id), ARRAY[]::uuid[]),
    count(*)::integer,
    count(DISTINCT appointment.appointment_date)::integer,
    string_agg(
      to_char(appointment.appointment_date, 'Mon FMDD, YYYY')
        || ' at ' || to_char(appointment.start_time, 'FMHH12:MI AM'),
      '; ' ORDER BY appointment.appointment_date, appointment.start_time, appointment.id
    ),
    COALESCE(
      max(appointment.customer_name) FILTER (WHERE appointment.id = p_preferred_appointment_id),
      max(appointment.customer_name),
      NULLIF(btrim(p_customer_name), ''),
      btrim(p_customer_phone)
    ),
    COALESCE(
      min(appointment.id) FILTER (WHERE appointment.id = p_preferred_appointment_id),
      (array_agg(
        appointment.id
        ORDER BY appointment.appointment_date, appointment.start_time, appointment.id
      ))[1]
    )
  INTO
    v_active_appointment_ids,
    v_active_booking_count,
    v_distinct_booking_date_count,
    v_schedule_details,
    v_customer_label,
    v_notification_appointment_id
  FROM active_bookings AS appointment;

  INSERT INTO public.customer_service_booking_alert_state (
    customer_phone,
    service_key
  )
  VALUES (btrim(p_customer_phone), v_service_key)
  ON CONFLICT (customer_phone, service_key) DO NOTHING;

  SELECT state.is_threshold_active, state.alert_cycle
  INTO v_threshold_was_active, v_alert_cycle
  FROM public.customer_service_booking_alert_state AS state
  WHERE state.customer_phone = btrim(p_customer_phone)
    AND state.service_key = v_service_key
  FOR UPDATE;

  IF v_active_booking_count < 2 OR v_distinct_booking_date_count < 2 THEN
    UPDATE public.customer_service_booking_alert_state
    SET is_threshold_active = false,
        updated_at = now()
    WHERE customer_phone = btrim(p_customer_phone)
      AND service_key = v_service_key;
    RETURN;
  END IF;

  -- A new cycle begins only after the customer has dropped below two active
  -- bookings. Within a cycle, each distinct set of booking IDs is alerted once.
  IF NOT v_threshold_was_active THEN
    v_alert_cycle := v_alert_cycle + 1;

    UPDATE public.customer_service_booking_alert_state
    SET is_threshold_active = true,
        alert_cycle = v_alert_cycle,
        updated_at = now()
    WHERE customer_phone = btrim(p_customer_phone)
      AND service_key = v_service_key;
  END IF;

  INSERT INTO public.customer_service_booking_alerts (
    customer_phone,
    service_key,
    alert_cycle,
    active_appointment_ids
  )
  VALUES (
    btrim(p_customer_phone),
    v_service_key,
    v_alert_cycle,
    v_active_appointment_ids
  )
  ON CONFLICT (customer_phone, service_key, alert_cycle, active_appointment_ids) DO NOTHING
  RETURNING id INTO v_notification_id;

  -- A NULL returned ID means this exact active-booking set has already been
  -- reported during the current threshold cycle.
  IF v_notification_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.notifications (type, title, message, appointment_id)
  VALUES (
    'multiple_active_service_bookings',
    v_active_booking_count || ' active ' || v_service_label || ' bookings for ' || v_customer_label,
    v_customer_label || ' (' || btrim(p_customer_phone) || ') has '
      || v_active_booking_count || ' active bookings for ' || v_service_label || ': '
      || v_schedule_details || '.',
    v_notification_appointment_id
  )
  RETURNING id INTO v_notification_id;

  UPDATE public.customer_service_booking_alerts
  SET notification_id = v_notification_id
  WHERE customer_phone = btrim(p_customer_phone)
    AND service_key = v_service_key
    AND alert_cycle = v_alert_cycle
    AND active_appointment_ids = v_active_appointment_ids;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_customer_service_booking_alert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_appointment_id uuid;
  v_customer_phone text;
  v_customer_name text;
  v_previous_customer_phone text;
  v_previous_customer_name text;
  v_service record;
BEGIN
  IF TG_TABLE_NAME = 'appointments' THEN
    IF TG_OP = 'DELETE' THEN
      v_appointment_id := OLD.id;
      v_customer_phone := OLD.phone;
      v_customer_name := OLD.customer_name;
    ELSE
      v_appointment_id := NEW.id;
      v_customer_phone := NEW.phone;
      v_customer_name := NEW.customer_name;
      IF TG_OP = 'UPDATE' AND OLD.phone IS DISTINCT FROM NEW.phone THEN
        v_previous_customer_phone := OLD.phone;
        v_previous_customer_name := OLD.customer_name;
      END IF;
    END IF;

    FOR v_service IN
      SELECT DISTINCT appointment_service.service_id, appointment_service.service_name
      FROM public.appointment_services AS appointment_service
      WHERE appointment_service.appointment_id = v_appointment_id
    LOOP
      -- Refresh both customer scopes if an administrator corrects a phone
      -- number. The lexical order prevents two concurrent corrections from
      -- taking the customer advisory locks in opposite directions.
      IF v_previous_customer_phone IS NOT NULL
         AND COALESCE(v_previous_customer_phone, '') < COALESCE(v_customer_phone, '') THEN
        PERFORM public.refresh_customer_service_booking_alert(
          v_previous_customer_phone,
          v_service.service_id,
          v_service.service_name,
          v_appointment_id,
          v_previous_customer_name
        );
      END IF;

      PERFORM public.refresh_customer_service_booking_alert(
        v_customer_phone,
        v_service.service_id,
        v_service.service_name,
        v_appointment_id,
        v_customer_name
      );

      IF v_previous_customer_phone IS NOT NULL
         AND COALESCE(v_previous_customer_phone, '') >= COALESCE(v_customer_phone, '') THEN
        PERFORM public.refresh_customer_service_booking_alert(
          v_previous_customer_phone,
          v_service.service_id,
          v_service.service_name,
          v_appointment_id,
          v_previous_customer_name
        );
      END IF;
    END LOOP;
  ELSE
    IF TG_OP = 'DELETE' THEN
      v_appointment_id := OLD.appointment_id;
    ELSE
      v_appointment_id := NEW.appointment_id;
    END IF;

    SELECT appointment.phone, appointment.customer_name
    INTO v_customer_phone, v_customer_name
    FROM public.appointments AS appointment
    WHERE appointment.id = v_appointment_id;

    -- Cascading deletion can remove the parent before this deferred trigger
    -- executes. It does not occur in the normal soft-archive workflow; if it
    -- does, there is no remaining active booking to alert for this row.
    IF NOT FOUND THEN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END IF;

    IF TG_OP <> 'DELETE' THEN
      PERFORM public.refresh_customer_service_booking_alert(
        v_customer_phone,
        NEW.service_id,
        NEW.service_name,
        v_appointment_id,
        v_customer_name
      );
    END IF;

    IF TG_OP <> 'INSERT' THEN
      PERFORM public.refresh_customer_service_booking_alert(
        v_customer_phone,
        OLD.service_id,
        OLD.service_name,
        v_appointment_id,
        v_customer_name
      );
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_customer_service_booking_alert(text, uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_customer_service_booking_alert() FROM PUBLIC;

DROP TRIGGER IF EXISTS appointments_sync_customer_service_booking_alert ON public.appointments;
CREATE CONSTRAINT TRIGGER appointments_sync_customer_service_booking_alert
  AFTER INSERT OR UPDATE OR DELETE ON public.appointments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_customer_service_booking_alert();

DROP TRIGGER IF EXISTS appointment_services_sync_customer_service_booking_alert ON public.appointment_services;
CREATE CONSTRAINT TRIGGER appointment_services_sync_customer_service_booking_alert
  AFTER INSERT OR UPDATE OR DELETE ON public.appointment_services
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_customer_service_booking_alert();
