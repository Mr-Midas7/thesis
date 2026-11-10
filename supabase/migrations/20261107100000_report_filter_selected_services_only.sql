-- A financial report filtered by service or category counts only the matching
-- services. A booking with Change Oil and Brake Service, filtered by Change Oil,
-- shows Change Oil and its charge alone, and every total, breakdown and row
-- amount follows. Products sold are not tied to a service, so they are left out
-- of a filtered report. The response says so in filtered_services_only.
-- Without a filter the report is unchanged (the dashboard relies on that).

CREATE OR REPLACE FUNCTION public.get_completed_financial_report_page(
  p_from date,
  p_to date,
  p_category text DEFAULT NULL,
  p_service_names text[] DEFAULT NULL,
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
  v_filtered boolean := p_category IS NOT NULL OR COALESCE(cardinality(p_service_names), 0) > 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'A valid report date range is required';
  END IF;

  RETURN (
    WITH completed_appointments AS (
      SELECT
        appointment.id,
        appointment.reference_code,
        COALESCE(
          (appointment.service_ended_at AT TIME ZONE 'Asia/Manila')::date,
          appointment.appointment_date
        ) AS transaction_date,
        -- The time that goes with transaction_date: when the service was
        -- completed, or the booked start time for older records without one.
        to_char(
          COALESCE(
            (appointment.service_ended_at AT TIME ZONE 'Asia/Manila')::time,
            appointment.start_time
          ),
          'HH24:MI'
        ) AS transaction_time
      FROM public.appointments AS appointment
      WHERE appointment.status = 'completed'
    ),
    in_period AS (
      SELECT *
      FROM completed_appointments
      WHERE transaction_date BETWEEN p_from AND p_to
    ),
    -- The service lines the report counts: all of them without a filter,
    -- otherwise only those matching the category and the chosen services.
    counted_services AS (
      SELECT
        service.appointment_id,
        service.service_name,
        service.price
      FROM in_period AS appointment
      JOIN public.appointment_services AS service ON service.appointment_id = appointment.id
      LEFT JOIN public.services AS catalog_service ON catalog_service.id = service.service_id
      WHERE (p_category IS NULL OR COALESCE(catalog_service.category, 'Uncategorized') = p_category)
        AND (
          COALESCE(cardinality(p_service_names), 0) = 0
          OR service.service_name = ANY(p_service_names)
        )
    ),
    counted_products AS (
      SELECT product.appointment_id, product.product_name, product.quantity, product.unit_price
      FROM in_period AS appointment
      JOIN public.appointment_products AS product ON product.appointment_id = appointment.id
      WHERE NOT v_filtered
    ),
    filtered AS (
      SELECT
        appointment.id,
        appointment.reference_code,
        appointment.transaction_date,
        appointment.transaction_time,
        service_totals.services,
        service_totals.service_amount,
        product_totals.products,
        product_totals.product_amount,
        service_totals.service_amount + product_totals.product_amount AS total_amount
      FROM in_period AS appointment
      CROSS JOIN LATERAL (
        SELECT
          COALESCE(string_agg(service.service_name, ', ' ORDER BY service.service_name), '-') AS services,
          COALESCE(sum(service.price), 0)::numeric AS service_amount,
          count(*) AS matching_services
        FROM counted_services AS service
        WHERE service.appointment_id = appointment.id
      ) AS service_totals
      CROSS JOIN LATERAL (
        SELECT
          COALESCE(
            string_agg(product.product_name || ' x ' || product.quantity, ', ' ORDER BY product.product_name),
            '-'
          ) AS products,
          COALESCE(sum(product.quantity * product.unit_price), 0)::numeric AS product_amount
        FROM counted_products AS product
        WHERE product.appointment_id = appointment.id
      ) AS product_totals
      WHERE NOT v_filtered OR service_totals.matching_services > 0
    ),
    paged AS (
      SELECT id, reference_code, transaction_date, transaction_time, services, service_amount,
        products, product_amount, total_amount
      FROM filtered
      ORDER BY transaction_date DESC, transaction_time DESC, reference_code ASC
      LIMIT v_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM filtered),
      'filtered_services_only', v_filtered,
      'rows', COALESCE((SELECT jsonb_agg(to_jsonb(paged)) FROM paged), '[]'::jsonb),
      'metrics', jsonb_build_object(
        'total_revenue', (SELECT COALESCE(sum(total_amount), 0) FROM filtered),
        'service_revenue', (SELECT COALESCE(sum(service_amount), 0) FROM filtered),
        'product_revenue', (SELECT COALESCE(sum(product_amount), 0) FROM filtered),
        'completed_transactions', (SELECT count(*) FROM filtered),
        'total_completed_services', (SELECT count(*) FROM counted_services),
        'total_products_sold', (SELECT COALESCE(sum(quantity), 0) FROM counted_products),
        'average_transaction_amount', (
          SELECT COALESCE(avg(total_amount), 0) FROM filtered
        )
      ),
      'service_performance', COALESCE((
        SELECT jsonb_agg(to_jsonb(performance) ORDER BY performance.revenue DESC, performance.service_name)
        FROM (
          SELECT
            service_name,
            count(*)::integer AS completed_count,
            COALESCE(sum(price), 0)::numeric AS revenue
          FROM counted_services
          GROUP BY service_name
        ) AS performance
      ), '[]'::jsonb),
      'product_sales', COALESCE((
        SELECT jsonb_agg(to_jsonb(sales) ORDER BY sales.total_sales DESC, sales.product_name, sales.unit_price)
        FROM (
          SELECT
            product_name,
            sum(quantity)::integer AS quantity_sold,
            unit_price,
            COALESCE(sum(quantity * unit_price), 0)::numeric AS total_sales
          FROM counted_products
          GROUP BY product_name, unit_price
        ) AS sales
      ), '[]'::jsonb),
      'daily_revenue', COALESCE((
        SELECT jsonb_agg(to_jsonb(day_revenue) ORDER BY day_revenue.period)
        FROM (
          SELECT
            transaction_date::text AS period,
            count(*)::integer AS completed_transactions,
            COALESCE(sum(service_amount), 0)::numeric AS service_revenue,
            COALESCE(sum(product_amount), 0)::numeric AS product_revenue,
            COALESCE(sum(total_amount), 0)::numeric AS total_revenue
          FROM filtered
          GROUP BY transaction_date
        ) AS day_revenue
      ), '[]'::jsonb),
      'monthly_revenue', COALESCE((
        SELECT jsonb_agg(to_jsonb(month_revenue) ORDER BY month_revenue.period)
        FROM (
          SELECT
            date_trunc('month', transaction_date::timestamp)::date::text AS period,
            count(*)::integer AS completed_transactions,
            COALESCE(sum(service_amount), 0)::numeric AS service_revenue,
            COALESCE(sum(product_amount), 0)::numeric AS product_revenue,
            COALESCE(sum(total_amount), 0)::numeric AS total_revenue
          FROM filtered
          GROUP BY date_trunc('month', transaction_date::timestamp)::date
        ) AS month_revenue
      ), '[]'::jsonb)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_completed_financial_report_page(date, date, text, text[], integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_completed_financial_report_page(date, date, text, text[], integer, integer)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
