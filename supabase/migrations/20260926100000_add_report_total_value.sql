-- Keep report totals aligned with the visible rows for every status and
-- service filter. Completed value remains a separate completed-only metric.
CREATE OR REPLACE FUNCTION public.get_admin_report_page(
  p_report_kind text,
  p_from date,
  p_to date,
  p_status text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_service_name text DEFAULT NULL,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, auth
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 250);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_report_kind NOT IN ('bookings', 'services') THEN
    RAISE EXCEPTION 'Unknown report type';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'A valid report date range is required';
  END IF;

  IF p_report_kind = 'bookings' THEN
    RETURN (
      WITH filtered AS (
        SELECT
          a.id,
          a.reference_code,
          a.customer_name,
          a.appointment_date,
          a.status,
          a.total_estimate,
          COALESCE(
            (
              SELECT string_agg(aps.service_name, ', ' ORDER BY aps.service_name)
              FROM public.appointment_services aps
              WHERE aps.appointment_id = a.id
            ),
            '—'
          ) AS service
        FROM public.appointments a
        WHERE a.is_archived = false
          AND a.appointment_date BETWEEN p_from AND p_to
          AND (p_status IS NULL OR a.status = p_status)
          AND (
            (p_category IS NULL AND p_service_name IS NULL)
            OR EXISTS (
              SELECT 1
              FROM public.appointment_services aps
              LEFT JOIN public.services s ON s.id = aps.service_id
              WHERE aps.appointment_id = a.id
                AND (p_category IS NULL OR COALESCE(s.category, 'Uncategorized') = p_category)
                AND (p_service_name IS NULL OR aps.service_name = p_service_name)
            )
          )
      ),
      grouped_status AS (
        SELECT status, COUNT(*)::integer AS total FROM filtered GROUP BY status
      ),
      paged AS (
        SELECT * FROM filtered
        ORDER BY appointment_date DESC, reference_code ASC
        LIMIT v_limit OFFSET v_offset
      )
      SELECT jsonb_build_object(
        'total', (SELECT COUNT(*) FROM filtered),
        'rows', COALESCE((SELECT jsonb_agg(TO_JSONB(paged)) FROM paged), '[]'::jsonb),
        'metrics', jsonb_build_object(
          'total_bookings', (SELECT COUNT(*) FROM filtered),
          'completed_bookings', (SELECT COUNT(*) FROM filtered WHERE status = 'completed'),
          'completed_value',
            (SELECT COALESCE(SUM(total_estimate) FILTER (WHERE status = 'completed'), 0) FROM filtered),
          'total_value', (SELECT COALESCE(SUM(total_estimate), 0) FROM filtered),
          'status_counts',
            COALESCE((SELECT jsonb_object_agg(status, total) FROM grouped_status), '{}'::jsonb)
        )
      )
    );
  END IF;

  RETURN (
    WITH filtered AS (
      SELECT
        aps.appointment_id,
        aps.service_id,
        aps.service_name,
        aps.price,
        a.reference_code,
        a.customer_name,
        a.appointment_date,
        a.status,
        COALESCE(s.category, 'Uncategorized') AS category
      FROM public.appointment_services aps
      JOIN public.appointments a ON a.id = aps.appointment_id
      LEFT JOIN public.services s ON s.id = aps.service_id
      WHERE a.is_archived = false
        AND a.appointment_date BETWEEN p_from AND p_to
        AND (p_status IS NULL OR a.status = p_status)
        AND (p_category IS NULL OR COALESCE(s.category, 'Uncategorized') = p_category)
        AND (p_service_name IS NULL OR aps.service_name = p_service_name)
    ),
    grouped_status AS (
      SELECT status, COUNT(*)::integer AS total FROM filtered GROUP BY status
    ),
    paged AS (
      SELECT * FROM filtered
      ORDER BY appointment_date DESC, reference_code ASC, service_name ASC
      LIMIT v_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'total', (SELECT COUNT(*) FROM filtered),
      'rows', COALESCE((SELECT jsonb_agg(TO_JSONB(paged)) FROM paged), '[]'::jsonb),
      'metrics', jsonb_build_object(
        'total_bookings', (SELECT COUNT(DISTINCT appointment_id) FROM filtered),
        'completed_rows', (SELECT COUNT(*) FROM filtered WHERE status = 'completed'),
        'completed_value',
          (SELECT COALESCE(SUM(price) FILTER (WHERE status = 'completed'), 0) FROM filtered),
        'total_value', (SELECT COALESCE(SUM(price), 0) FROM filtered),
        'status_counts',
          COALESCE((SELECT jsonb_object_agg(status, total) FROM grouped_status), '{}'::jsonb)
      )
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_report_page(text, date, date, text, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_report_page(text, date, date, text, text, text, integer, integer) TO authenticated;
