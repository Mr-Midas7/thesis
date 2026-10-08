-- A booking records only the customer's product preference. The actual items,
-- quantities, and selling prices are captured by an administrator at service
-- time so financial reports use durable price snapshots rather than the
-- current catalog price.
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS wants_products boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.appointment_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  product_name text NOT NULL CHECK (btrim(product_name) <> ''),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  unit_price numeric(10, 2) NOT NULL CHECK (unit_price >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, product_id)
);

CREATE INDEX IF NOT EXISTS appointment_products_appointment_id_idx
  ON public.appointment_products (appointment_id);

REVOKE ALL ON TABLE public.appointment_products FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.appointment_products TO authenticated;
GRANT ALL ON TABLE public.appointment_products TO service_role;
ALTER TABLE public.appointment_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "appointment products admin all" ON public.appointment_products;
CREATE POLICY "appointment products admin all"
  ON public.appointment_products
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP TRIGGER IF EXISTS appointment_products_updated ON public.appointment_products;
CREATE TRIGGER appointment_products_updated
  BEFORE UPDATE ON public.appointment_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Preserve the current booking RPC for older clients and expose a distinct,
-- unambiguous signature for the current form's product preference.
CREATE FUNCTION public.create_booking_atomic(
  p_reference_code text, p_booking_request_id uuid, p_customer_name text,
  p_phone text, p_email text, p_moto_brand text, p_moto_model text,
  p_moto_variant text, p_moto_year integer, p_plate_number text,
  p_appointment_date date, p_start_time time, p_notes text,
  p_total_estimate numeric, p_booking_duration_minutes integer,
  p_assigned_crew_id uuid, p_services jsonb, p_continuation_segments jsonb,
  p_notification_title text, p_notification_message text, p_first_name text,
  p_middle_name text, p_last_name text, p_wants_products boolean
)
RETURNS TABLE (appointment_id uuid, reference_code text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_appointment_id uuid;
  v_reference_code text;
BEGIN
  IF p_wants_products IS NULL THEN
    RAISE EXCEPTION 'Choose whether you would like to avail shop products.';
  END IF;

  -- Preserve the original preference on a retry. The browser retries with
  -- the same request id when a response is lost, so serializing that id keeps
  -- the preference just as immutable as the appointment details.
  PERFORM pg_advisory_xact_lock(hashtext('booking-request:' || p_booking_request_id::text));
  SELECT appointment.id, appointment.reference_code
    INTO v_appointment_id, v_reference_code
  FROM public.appointments AS appointment
  WHERE appointment.booking_request_id = p_booking_request_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_appointment_id, v_reference_code;
    RETURN;
  END IF;

  SELECT created.appointment_id, created.reference_code
    INTO v_appointment_id, v_reference_code
  FROM public.create_booking_atomic(
    p_reference_code, p_booking_request_id, p_customer_name, p_phone, p_email,
    p_moto_brand, p_moto_model, p_moto_variant, p_moto_year, p_plate_number,
    p_appointment_date, p_start_time, p_notes, p_total_estimate,
    p_booking_duration_minutes, p_assigned_crew_id, p_services,
    p_continuation_segments, p_notification_title, p_notification_message,
    p_first_name, p_middle_name, p_last_name
  ) AS created;

  UPDATE public.appointments
  SET wants_products = p_wants_products
  WHERE id = v_appointment_id;

  RETURN QUERY SELECT v_appointment_id, v_reference_code;
END;
$$;

REVOKE ALL ON FUNCTION public.create_booking_atomic(
  text, uuid, text, text, text, text, text, text, integer, text, date, time,
  text, numeric, integer, uuid, jsonb, jsonb, text, text, text, text, text, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_booking_atomic(
  text, uuid, text, text, text, text, text, text, integer, text, date, time,
  text, numeric, integer, uuid, jsonb, jsonb, text, text, text, text, text, boolean
) TO service_role;

-- This admin-only transaction changes the service snapshot, appointment data,
-- product lines, and stock quantities together. It prevents stale stock from
-- being oversold and preserves the catalog name/price snapshot already used.
CREATE FUNCTION public.update_appointment_financial_details_atomic(
  p_appointment_id uuid,
  p_service_ids uuid[],
  p_appointment_date date,
  p_start_time time,
  p_assigned_crew_id uuid,
  p_crew_assignment_manual boolean,
  p_status text,
  p_admin_notes text,
  p_first_name text,
  p_middle_name text,
  p_last_name text,
  p_phone text,
  p_products jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, auth
AS $$
DECLARE
  v_wants_products boolean;
  v_requested_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can update appointment products.';
  END IF;
  IF jsonb_typeof(COALESCE(p_products, '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(COALESCE(p_products, '[]'::jsonb)) > 50 THEN
    RAISE EXCEPTION 'Products must be a list of up to 50 items.';
  END IF;

  -- Reuse the single source of truth for service pricing, appointment editing,
  -- crew availability, and status validation.
  PERFORM public.update_appointment_details_atomic(
    p_appointment_id, p_service_ids, p_appointment_date, p_start_time,
    p_assigned_crew_id, p_crew_assignment_manual, p_status, p_admin_notes,
    p_first_name, p_middle_name, p_last_name, p_phone
  );

  SELECT wants_products
    INTO v_wants_products
  FROM public.appointments
  WHERE id = p_appointment_id
    AND is_archived = false
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This appointment is no longer available.';
  END IF;

  WITH requested AS (
    SELECT product_id, quantity, unit_price
    FROM jsonb_to_recordset(COALESCE(p_products, '[]'::jsonb))
      AS item(product_id uuid, quantity integer, unit_price numeric)
  )
  SELECT count(*) INTO v_requested_count FROM requested;

  IF v_requested_count > 0 AND NOT v_wants_products THEN
    RAISE EXCEPTION 'This customer declined shop products for this appointment.';
  END IF;
  IF v_requested_count > 0 AND p_status NOT IN ('in_progress', 'completed') THEN
    RAISE EXCEPTION 'Products can only be added while service is in progress or completed.';
  END IF;

  IF EXISTS (
    WITH requested AS (
      SELECT product_id, quantity, unit_price
      FROM jsonb_to_recordset(COALESCE(p_products, '[]'::jsonb))
        AS item(product_id uuid, quantity integer, unit_price numeric)
    )
    SELECT 1
    FROM requested
    GROUP BY product_id
    HAVING count(*) > 1
       OR min(quantity) IS NULL
       OR min(quantity) < 1
       OR max(quantity) > 999
       OR min(unit_price) IS NULL
       OR min(unit_price) < 0
  ) THEN
    RAISE EXCEPTION 'Each product must be unique and have a valid quantity and price.';
  END IF;

  -- Lock both old and newly requested inventory rows before checking stock or
  -- calculating differences. This serializes concurrent appointment edits.
  PERFORM 1
  FROM public.products AS product
  WHERE product.id IN (
    SELECT item.product_id
    FROM jsonb_to_recordset(COALESCE(p_products, '[]'::jsonb))
      AS item(product_id uuid, quantity integer, unit_price numeric)
    UNION
    SELECT appointment_product.product_id
    FROM public.appointment_products AS appointment_product
    WHERE appointment_product.appointment_id = p_appointment_id
  )
  ORDER BY product.id
  FOR UPDATE;

  IF EXISTS (
    WITH requested AS (
      SELECT product_id, quantity, unit_price
      FROM jsonb_to_recordset(COALESCE(p_products, '[]'::jsonb))
        AS item(product_id uuid, quantity integer, unit_price numeric)
    )
    SELECT 1
    FROM requested
    LEFT JOIN public.products AS product ON product.id = requested.product_id
    LEFT JOIN public.appointment_products AS existing
      ON existing.appointment_id = p_appointment_id
     AND existing.product_id = requested.product_id
    WHERE product.id IS NULL
       OR (existing.id IS NULL AND (product.is_archived OR NOT product.is_active OR NOT product.in_stock))
       OR product.stock_quantity + COALESCE(existing.quantity, 0) < requested.quantity
  ) THEN
    RAISE EXCEPTION 'One or more products are unavailable or do not have enough stock.';
  END IF;

  -- Return stock for removed lines first, then reserve the requested quantity.
  UPDATE public.products AS product
  SET stock_quantity = product.stock_quantity + existing.quantity
  FROM public.appointment_products AS existing
  WHERE existing.appointment_id = p_appointment_id
    AND existing.product_id = product.id
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(COALESCE(p_products, '[]'::jsonb))
        AS item(product_id uuid, quantity integer, unit_price numeric)
      WHERE item.product_id = existing.product_id
    );

  UPDATE public.products AS product
  SET stock_quantity = product.stock_quantity + COALESCE(existing.quantity, 0) - requested.quantity
  FROM jsonb_to_recordset(COALESCE(p_products, '[]'::jsonb))
    AS requested(product_id uuid, quantity integer, unit_price numeric)
  LEFT JOIN public.appointment_products AS existing
    ON existing.appointment_id = p_appointment_id
   AND existing.product_id = requested.product_id
  WHERE product.id = requested.product_id;

  INSERT INTO public.appointment_products (
    appointment_id, product_id, product_name, quantity, unit_price
  )
  SELECT p_appointment_id, requested.product_id, product.name, requested.quantity, requested.unit_price
  FROM jsonb_to_recordset(COALESCE(p_products, '[]'::jsonb))
    AS requested(product_id uuid, quantity integer, unit_price numeric)
  JOIN public.products AS product ON product.id = requested.product_id
  ON CONFLICT (appointment_id, product_id) DO UPDATE
    SET quantity = EXCLUDED.quantity,
        unit_price = EXCLUDED.unit_price,
        updated_at = now();

  DELETE FROM public.appointment_products AS existing
  WHERE existing.appointment_id = p_appointment_id
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(COALESCE(p_products, '[]'::jsonb))
        AS item(product_id uuid, quantity integer, unit_price numeric)
      WHERE item.product_id = existing.product_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.update_appointment_financial_details_atomic(
  uuid, uuid[], date, time, uuid, boolean, text, text, text, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_appointment_financial_details_atomic(
  uuid, uuid[], date, time, uuid, boolean, text, text, text, text, text, text, jsonb
) TO authenticated;

-- The financial report includes saved service and product subtotals. The
-- `services` branch remains service-focused for compatibility with existing
-- filtering, while the booking branch is the financial summary shown in UI.
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
          appointment.id,
          appointment.reference_code,
          appointment.customer_name,
          appointment.appointment_date,
          appointment.status,
          service_totals.service,
          service_totals.service_subtotal,
          product_totals.products,
          product_totals.product_subtotal,
          service_totals.service_subtotal + product_totals.product_subtotal AS total_amount,
          service_totals.service_subtotal AS total_estimate
        FROM public.appointments AS appointment
        CROSS JOIN LATERAL (
          SELECT
            COALESCE(string_agg(service.service_name, ', ' ORDER BY service.service_name), '—') AS service,
            COALESCE(sum(service.price), 0)::numeric AS service_subtotal
          FROM public.appointment_services AS service
          WHERE service.appointment_id = appointment.id
        ) AS service_totals
        CROSS JOIN LATERAL (
          SELECT
            COALESCE(string_agg(product.product_name || ' × ' || product.quantity, ', ' ORDER BY product.product_name), '—') AS products,
            COALESCE(sum(product.quantity * product.unit_price), 0)::numeric AS product_subtotal
          FROM public.appointment_products AS product
          WHERE product.appointment_id = appointment.id
        ) AS product_totals
        WHERE appointment.is_archived = false
          AND appointment.appointment_date BETWEEN p_from AND p_to
          AND (p_status IS NULL OR appointment.status = p_status)
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
      grouped_status AS (
        SELECT status, count(*)::integer AS total FROM filtered GROUP BY status
      ),
      paged AS (
        SELECT * FROM filtered
        ORDER BY appointment_date DESC, reference_code ASC
        LIMIT v_limit OFFSET v_offset
      )
      SELECT jsonb_build_object(
        'total', (SELECT count(*) FROM filtered),
        'rows', COALESCE((SELECT jsonb_agg(to_jsonb(paged)) FROM paged), '[]'::jsonb),
        'metrics', jsonb_build_object(
          'total_bookings', (SELECT count(*) FROM filtered),
          'completed_bookings', (SELECT count(*) FROM filtered WHERE status = 'completed'),
          'completed_value', (SELECT COALESCE(sum(total_amount) FILTER (WHERE status = 'completed'), 0) FROM filtered),
          'total_value', (SELECT COALESCE(sum(total_amount), 0) FROM filtered),
          'service_total', (SELECT COALESCE(sum(service_subtotal), 0) FROM filtered),
          'product_total', (SELECT COALESCE(sum(product_subtotal), 0) FROM filtered),
          'status_counts', COALESCE((SELECT jsonb_object_agg(status, total) FROM grouped_status), '{}'::jsonb)
        )
      )
    );
  END IF;

  RETURN (
    WITH filtered AS (
      SELECT
        appointment_service.appointment_id,
        appointment_service.service_id,
        appointment_service.service_name,
        appointment_service.price,
        appointment.reference_code,
        appointment.customer_name,
        appointment.appointment_date,
        appointment.status,
        COALESCE(catalog_service.category, 'Uncategorized') AS category
      FROM public.appointment_services AS appointment_service
      JOIN public.appointments AS appointment ON appointment.id = appointment_service.appointment_id
      LEFT JOIN public.services AS catalog_service ON catalog_service.id = appointment_service.service_id
      WHERE appointment.is_archived = false
        AND appointment.appointment_date BETWEEN p_from AND p_to
        AND (p_status IS NULL OR appointment.status = p_status)
        AND (p_category IS NULL OR COALESCE(catalog_service.category, 'Uncategorized') = p_category)
        AND (p_service_name IS NULL OR appointment_service.service_name = p_service_name)
    ),
    grouped_status AS (
      SELECT status, count(*)::integer AS total FROM filtered GROUP BY status
    ),
    paged AS (
      SELECT * FROM filtered
      ORDER BY appointment_date DESC, reference_code ASC, service_name ASC
      LIMIT v_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM filtered),
      'rows', COALESCE((SELECT jsonb_agg(to_jsonb(paged)) FROM paged), '[]'::jsonb),
      'metrics', jsonb_build_object(
        'total_bookings', (SELECT count(DISTINCT appointment_id) FROM filtered),
        'completed_rows', (SELECT count(*) FROM filtered WHERE status = 'completed'),
        'completed_value', (SELECT COALESCE(sum(price) FILTER (WHERE status = 'completed'), 0) FROM filtered),
        'total_value', (SELECT COALESCE(sum(price), 0) FROM filtered),
        'status_counts', COALESCE((SELECT jsonb_object_agg(status, total) FROM grouped_status), '{}'::jsonb)
      )
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_report_page(text, date, date, text, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_report_page(text, date, date, text, text, text, integer, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
