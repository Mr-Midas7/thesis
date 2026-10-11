-- Product lines may be prepared after approval, before a mechanic starts the
-- service. Keep the same atomic stock checks and price snapshots, while
-- rejecting unapproved and terminal appointments.
CREATE OR REPLACE FUNCTION public.update_appointment_financial_details_atomic(
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
  IF v_requested_count > 0 AND p_status NOT IN ('confirmed', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'Products can be added after the appointment is confirmed, before or during service.';
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

  -- Lock existing and requested inventory in a stable order. This prevents
  -- parallel appointment edits from overselling a product.
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

-- A pre-service product allocation reserves stock. If that appointment ends
-- before service begins, return the reservation and clear its unsold lines.
CREATE OR REPLACE FUNCTION public.release_pre_service_product_reservations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status IN ('pending', 'confirmed')
     AND NEW.status IN ('cancelled', 'rejected', 'rescheduled', 'no_show')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM 1
    FROM public.products AS product
    JOIN public.appointment_products AS appointment_product
      ON appointment_product.product_id = product.id
    WHERE appointment_product.appointment_id = OLD.id
    ORDER BY product.id
    FOR UPDATE;

    UPDATE public.products AS product
    SET stock_quantity = product.stock_quantity + appointment_product.quantity
    FROM public.appointment_products AS appointment_product
    WHERE appointment_product.appointment_id = OLD.id
      AND appointment_product.product_id = product.id;

    DELETE FROM public.appointment_products
    WHERE appointment_id = OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_release_pre_service_product_reservations
  ON public.appointments;

CREATE TRIGGER appointments_release_pre_service_product_reservations
  BEFORE UPDATE OF status ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.release_pre_service_product_reservations();

REVOKE ALL ON FUNCTION public.update_appointment_financial_details_atomic(
  uuid, uuid[], date, time, uuid, boolean, text, text, text, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_appointment_financial_details_atomic(
  uuid, uuid[], date, time, uuid, boolean, text, text, text, text, text, text, jsonb
) TO authenticated;

NOTIFY pgrst, 'reload schema';
