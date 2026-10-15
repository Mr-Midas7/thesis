-- 1. Functions that bypass row-level security are no longer callable with the
--    public API key.
-- 2. Completed appointments are kept: they cannot be archived or deleted, and
--    the financial report counts every completed appointment.
-- 3. The daily archive and activity-log cleanups are scheduled.

-- Scheduled jobs run as the role that schedules them, and the functions and
-- trigger below are owned by it. Stop before changing anything unless that is
-- postgres (the SQL editor and the Supabase CLI both apply migrations as postgres).
DO $$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Apply this migration as postgres (current role: %).', current_user;
  END IF;
END;
$$;

-- 1. Function access ---------------------------------------------------------

-- Supabase grants EXECUTE on new functions to anon and authenticated directly,
-- so the earlier REVOKE ... FROM PUBLIC statements left these callable by anyone
-- holding the public key. No public page calls them: public requests go through
-- server functions that use the service role. Trigger functions are skipped
-- because they cannot be called directly.
DO $$
DECLARE
  v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure
    FROM pg_proc AS p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prosecdef
      AND p.prorettype <> 'trigger'::regtype
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', v_function);
  END LOOP;
END;
$$;

-- These run only from triggers, the scheduler, or server code using the
-- service role, so signed-in users do not need them either. The admin-session
-- and activity-log functions stay available to the signed-in admin console.
REVOKE EXECUTE ON FUNCTION public.refresh_customer_service_booking_alert(text, uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_expired_archived_records()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_appointment_action_code(uuid, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;

-- 2. Completed appointments --------------------------------------------------

CREATE OR REPLACE FUNCTION public.protect_completed_appointments()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'completed' THEN
      RAISE EXCEPTION 'Completed appointments are kept for financial records and cannot be deleted.';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.is_archived
     AND NOT OLD.is_archived
     AND (OLD.status = 'completed' OR NEW.status = 'completed') THEN
    RAISE EXCEPTION 'Completed appointments are kept for financial records and cannot be archived.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_protect_completed ON public.appointments;
CREATE TRIGGER appointments_protect_completed
  BEFORE DELETE OR UPDATE OF is_archived, status ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.protect_completed_appointments();

-- The 30-day archive cleanup leaves completed appointments in place, including
-- any archived before archiving them was blocked.
CREATE OR REPLACE FUNCTION public.purge_expired_archived_records()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.appointments
  WHERE is_archived = true
    AND status <> 'completed'
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.services
  WHERE is_archived = true
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.products
  WHERE is_archived = true
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.motorcycle_catalog
  WHERE is_archived = true
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.crew_members
  WHERE is_archived = true
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.schedule_blocks
  WHERE is_active = false
    AND archived_at < now() - interval '30 days';

  DELETE FROM public.blocked_numbers
  WHERE is_archived = true
    AND archived_at < now() - interval '30 days';
END;
$$;

-- Revenue is recognized for every completed appointment, archived or not, so
-- archiving can never change a past period's totals.
CREATE OR REPLACE FUNCTION public.get_completed_financial_report_page(
  p_from date,
  p_to date,
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
        ) AS transaction_date
      FROM public.appointments AS appointment
      WHERE appointment.status = 'completed'
    ),
    filtered AS (
      SELECT
        appointment.id,
        appointment.reference_code,
        appointment.transaction_date,
        service_totals.services,
        service_totals.service_amount,
        product_totals.products,
        product_totals.product_amount,
        service_totals.service_amount + product_totals.product_amount AS total_amount
      FROM completed_appointments AS appointment
      CROSS JOIN LATERAL (
        SELECT
          COALESCE(string_agg(service.service_name, ', ' ORDER BY service.service_name), '-') AS services,
          COALESCE(sum(service.price), 0)::numeric AS service_amount
        FROM public.appointment_services AS service
        WHERE service.appointment_id = appointment.id
      ) AS service_totals
      CROSS JOIN LATERAL (
        SELECT
          COALESCE(
            string_agg(product.product_name || ' x ' || product.quantity, ', ' ORDER BY product.product_name),
            '-'
          ) AS products,
          COALESCE(sum(product.quantity * product.unit_price), 0)::numeric AS product_amount
        FROM public.appointment_products AS product
        WHERE product.appointment_id = appointment.id
      ) AS product_totals
      WHERE appointment.transaction_date BETWEEN p_from AND p_to
        AND (
          (p_category IS NULL AND p_service_name IS NULL)
          OR EXISTS (
            SELECT 1
            FROM public.appointment_services AS selected_service
            LEFT JOIN public.services AS catalog_service ON catalog_service.id = selected_service.service_id
            WHERE selected_service.appointment_id = appointment.id
              AND (p_category IS NULL OR COALESCE(catalog_service.category, 'Uncategorized') = p_category)
              AND (p_service_name IS NULL OR selected_service.service_name = p_service_name)
          )
        )
    ),
    scoped_services AS (
      SELECT
        service.appointment_id,
        service.service_name,
        service.price,
        COALESCE(catalog_service.category, 'Uncategorized') AS category
      FROM public.appointment_services AS service
      JOIN filtered AS appointment ON appointment.id = service.appointment_id
      LEFT JOIN public.services AS catalog_service ON catalog_service.id = service.service_id
    ),
    scoped_products AS (
      SELECT product.appointment_id, product.product_name, product.quantity, product.unit_price
      FROM public.appointment_products AS product
      JOIN filtered AS appointment ON appointment.id = product.appointment_id
    ),
    paged AS (
      SELECT *
      FROM filtered
      ORDER BY transaction_date DESC, reference_code ASC
      LIMIT v_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM filtered),
      'rows', COALESCE((SELECT jsonb_agg(to_jsonb(paged)) FROM paged), '[]'::jsonb),
      'metrics', jsonb_build_object(
        'total_revenue', (SELECT COALESCE(sum(total_amount), 0) FROM filtered),
        'service_revenue', (SELECT COALESCE(sum(service_amount), 0) FROM filtered),
        'product_revenue', (SELECT COALESCE(sum(product_amount), 0) FROM filtered),
        'completed_transactions', (SELECT count(*) FROM filtered),
        'total_completed_services', (SELECT count(*) FROM scoped_services),
        'total_products_sold', (SELECT COALESCE(sum(quantity), 0) FROM scoped_products),
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
          FROM scoped_services
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
          FROM scoped_products
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

-- 3. Scheduled cleanups ------------------------------------------------------

-- The original schedules were only created when pg_cron was already enabled,
-- but pg_cron was enabled by a later migration. pg_cron runs in UTC: 16:15 and
-- 16:30 UTC are 12:15 AM and 12:30 AM Philippine time.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname IN ('purge-admin-activity-logs', 'purge-expired-archives');

  PERFORM cron.schedule(
    'purge-admin-activity-logs',
    '15 16 * * *',
    'SELECT public.purge_expired_admin_activity_logs();'
  );
  PERFORM cron.schedule(
    'purge-expired-archives',
    '30 16 * * *',
    'SELECT public.purge_expired_archived_records();'
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
