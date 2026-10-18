-- 1. The admin dashboard counts in the database. Loading every appointment into
--    the browser stops working past the API's 1,000-row limit, and the newest
--    appointments were the ones left out. Revenue uses the financial report's
--    calculation, so the dashboard and Reports always agree.
-- 2. Removing or editing a crew shift moves that mechanic's bookings on that day
--    to another free mechanic. If no one else is free for a booking, nothing
--    changes and the booking references are reported.

-- 1. Dashboard ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_admin_dashboard_summary(
  p_from date,
  p_to date,
  p_previous_from date,
  p_previous_to date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, auth
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to
     OR p_previous_from IS NULL OR p_previous_to IS NULL OR p_previous_from > p_previous_to THEN
    RAISE EXCEPTION 'A valid dashboard date range is required';
  END IF;

  RETURN (
    WITH scoped AS (
      SELECT
        appointment.status,
        appointment.phone,
        appointment.appointment_date BETWEEN p_from AND p_to AS in_current,
        appointment.appointment_date BETWEEN p_previous_from AND p_previous_to AS in_previous,
        -- A rescheduled booking's old record is replaced by its new appointment.
        appointment.status NOT IN ('cancelled', 'rejected', 'no_show')
          AND appointment.rescheduled_to_appointment_id IS NULL AS is_active
      FROM public.appointments AS appointment
      -- Completed appointments always count, as in the financial report.
      WHERE (appointment.is_archived = false OR appointment.status = 'completed')
        AND (
          appointment.appointment_date BETWEEN p_from AND p_to
          OR appointment.appointment_date BETWEEN p_previous_from AND p_previous_to
        )
    ),
    -- Waiting for the shop whatever their date: new bookings to approve and
    -- reschedule requests to review.
    open_requests AS (
      SELECT
        count(*) FILTER (
          WHERE appointment.status = 'pending'
            AND appointment.pending_reschedule_request_id IS NULL
        ) AS new_bookings,
        count(*) FILTER (
          WHERE appointment.pending_reschedule_request_id IS NOT NULL
        ) AS reschedule_requests
      FROM public.appointments AS appointment
      WHERE appointment.is_archived = false
        AND appointment.rescheduled_to_appointment_id IS NULL
        AND (
          appointment.status = 'pending'
          OR (
            appointment.pending_reschedule_request_id IS NOT NULL
            AND appointment.status IN ('pending', 'confirmed')
          )
        )
    )
    SELECT jsonb_build_object(
      'current', jsonb_build_object(
        'appointments', count(*) FILTER (WHERE in_current AND is_active),
        'customers', count(DISTINCT phone) FILTER (WHERE in_current AND is_active),
        'revenue', (
          public.get_completed_financial_report_page(p_from, p_to, NULL, NULL, 1, 0)
            -> 'metrics' ->> 'total_revenue'
        )::numeric,
        'statuses', jsonb_build_object(
          'pending', count(*) FILTER (WHERE in_current AND status = 'pending'),
          'confirmed', count(*) FILTER (WHERE in_current AND status = 'confirmed'),
          'in_progress', count(*) FILTER (WHERE in_current AND status = 'in_progress'),
          'completed', count(*) FILTER (WHERE in_current AND status = 'completed'),
          'rescheduled', count(*) FILTER (WHERE in_current AND status = 'rescheduled'),
          'cancelled', count(*) FILTER (WHERE in_current AND status IN ('cancelled', 'rejected')),
          'no_show', count(*) FILTER (WHERE in_current AND status = 'no_show')
        )
      ),
      'previous', jsonb_build_object(
        'appointments', count(*) FILTER (WHERE in_previous AND is_active),
        'customers', count(DISTINCT phone) FILTER (WHERE in_previous AND is_active),
        'revenue', (
          public.get_completed_financial_report_page(p_previous_from, p_previous_to, NULL, NULL, 1, 0)
            -> 'metrics' ->> 'total_revenue'
        )::numeric
      ),
      'needs_action', (
        SELECT jsonb_build_object(
          'new_bookings', open_requests.new_bookings,
          'reschedule_requests', open_requests.reschedule_requests
        )
        FROM open_requests
      )
    )
    FROM scoped
  );
END;
$$;

-- Appointment counts for the dashboard chart, per day or per month.
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_chart(
  p_from date,
  p_to date,
  p_by_month boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, auth
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'A valid dashboard date range is required';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(bucket) ORDER BY bucket.period)
    FROM (
      SELECT
        (
          CASE
            WHEN p_by_month THEN date_trunc('month', appointment.appointment_date::timestamp)::date
            ELSE appointment.appointment_date
          END
        )::text AS period,
        count(*) FILTER (WHERE appointment.status = 'completed') AS completed,
        count(*) FILTER (WHERE appointment.status = 'confirmed') AS confirmed,
        count(*) FILTER (
          WHERE appointment.status IN ('cancelled', 'rejected', 'no_show')
        ) AS cancelled,
        count(*) FILTER (WHERE appointment.status = 'in_progress') AS in_progress
      FROM public.appointments AS appointment
      WHERE (appointment.is_archived = false OR appointment.status = 'completed')
        AND appointment.appointment_date BETWEEN p_from AND p_to
      GROUP BY 1
    ) AS bucket
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_dashboard_summary(date, date, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_summary(date, date, date, date)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_admin_dashboard_chart(date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_chart(date, date, boolean)
  TO authenticated, service_role;

-- 2. Crew shift changes ------------------------------------------------------

-- Removes a date shift (p_remove) or changes its hours. Bookings, and later-day
-- parts of multi-day bookings, that the mechanic can no longer do that day go
-- to the free mechanic with the fewest bookings. Returns the bookings moved.
CREATE OR REPLACE FUNCTION public.change_crew_schedule(
  p_schedule_id uuid,
  p_remove boolean,
  p_start_time time DEFAULT NULL,
  p_end_time time DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, auth
AS $$
DECLARE
  v_schedule public.crew_schedules%ROWTYPE;
  v_work record;
  v_replacement_id uuid;
  v_replacement_name text;
  v_moved jsonb := '[]'::jsonb;
  v_stuck text[] := ARRAY[]::text[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_schedule FROM public.crew_schedules WHERE id = p_schedule_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This shift no longer exists. Refresh the list and try again.'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_schedule.schedule_date IS NULL THEN
    RAISE EXCEPTION 'Only shifts on a specific date can be changed here.';
  END IF;
  IF NOT p_remove AND (p_start_time IS NULL OR p_end_time IS NULL OR p_start_time >= p_end_time) THEN
    RAISE EXCEPTION 'The shift must end after it starts.';
  END IF;

  -- The lock every booking change on this date takes, so no booking can claim
  -- this mechanic while the shift changes.
  PERFORM pg_advisory_xact_lock(hashtext('booking-capacity:' || v_schedule.schedule_date::text));

  IF p_remove THEN
    DELETE FROM public.crew_schedules WHERE id = v_schedule.id;
  ELSE
    UPDATE public.crew_schedules
    SET start_time = p_start_time,
        end_time = p_end_time,
        is_working = true
    WHERE id = v_schedule.id;
  END IF;

  FOR v_work IN
    SELECT
      'appointment' AS kind,
      appointment.id AS appointment_id,
      NULL::uuid AS continuation_id,
      appointment.reference_code,
      appointment.customer_name,
      appointment.start_time,
      appointment.booking_duration_minutes AS duration_minutes
    FROM public.appointments AS appointment
    WHERE appointment.assigned_crew_id = v_schedule.crew_id
      AND appointment.appointment_date = v_schedule.schedule_date
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
      AND NOT public.is_crew_available_for_appointment(
        v_schedule.crew_id,
        v_schedule.schedule_date,
        appointment.start_time,
        appointment.booking_duration_minutes,
        appointment.id
      )
    UNION ALL
    SELECT
      'continuation',
      appointment.id,
      continuation.id,
      appointment.reference_code,
      appointment.customer_name,
      continuation.start_time,
      continuation.booking_duration_minutes
    FROM public.appointment_continuations AS continuation
    JOIN public.appointments AS appointment ON appointment.id = continuation.appointment_id
    WHERE continuation.assigned_crew_id = v_schedule.crew_id
      AND continuation.appointment_date = v_schedule.schedule_date
      AND appointment.is_archived = false
      AND appointment.rescheduled_to_appointment_id IS NULL
      AND appointment.status IN ('pending', 'confirmed', 'in_progress', 'rescheduled')
      AND NOT public.is_crew_available_for_appointment(
        v_schedule.crew_id,
        v_schedule.schedule_date,
        continuation.start_time,
        continuation.booking_duration_minutes,
        NULL,
        continuation.id
      )
    ORDER BY start_time, reference_code
  LOOP
    SELECT crew.id, crew.name
      INTO v_replacement_id, v_replacement_name
    FROM public.crew_members AS crew
    WHERE crew.id <> v_schedule.crew_id
      AND crew.is_active = true
      AND crew.is_archived = false
      AND public.is_crew_available_for_appointment(
        crew.id,
        v_schedule.schedule_date,
        v_work.start_time,
        v_work.duration_minutes,
        v_work.appointment_id,
        v_work.continuation_id
      )
    ORDER BY public.crew_daily_workload(crew.id, v_schedule.schedule_date, v_work.appointment_id),
      crew.name,
      crew.id
    LIMIT 1;

    IF v_replacement_id IS NULL THEN
      v_stuck := array_append(v_stuck, v_work.reference_code);
      CONTINUE;
    END IF;

    IF v_work.kind = 'appointment' THEN
      UPDATE public.appointments
      SET assigned_crew_id = v_replacement_id
      WHERE id = v_work.appointment_id;
    ELSE
      UPDATE public.appointment_continuations
      SET assigned_crew_id = v_replacement_id
      WHERE id = v_work.continuation_id;
    END IF;

    v_moved := v_moved || jsonb_build_array(jsonb_build_object(
      'reference_code', v_work.reference_code,
      'customer_name', v_work.customer_name,
      'start_time', v_work.start_time,
      'mechanic', v_replacement_name
    ));
  END LOOP;

  -- Undo everything, including the shift change, rather than leave a booking
  -- with a mechanic who is not working.
  IF cardinality(v_stuck) > 0 THEN
    RAISE EXCEPTION 'No other mechanic is free for %.', array_to_string(v_stuck, ', ')
      USING HINT = 'crew_shift_conflict';
  END IF;

  RETURN jsonb_build_object('moved', v_moved);
END;
$$;

REVOKE ALL ON FUNCTION public.change_crew_schedule(uuid, boolean, time, time) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_crew_schedule(uuid, boolean, time, time)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
