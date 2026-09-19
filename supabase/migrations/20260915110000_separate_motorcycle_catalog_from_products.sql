-- Keep the service motorcycle catalog independent from shop inventory.
-- Appointment snapshots intentionally remain untouched: they preserve the
-- configuration used for an already-created booking and are required when a
-- customer reschedules that appointment.

CREATE TABLE IF NOT EXISTS public.motorcycle_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand text,
  model text NOT NULL,
  engine_cc numeric(6, 1),
  fuel_type text,
  transmission text,
  is_active boolean NOT NULL DEFAULT true,
  is_archived boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- Preserve every existing catalog row, including archived records and their
-- identifiers, before removing motorcycle rows from the shop-products table.
INSERT INTO public.motorcycle_catalog (
  id,
  brand,
  model,
  engine_cc,
  fuel_type,
  transmission,
  is_active,
  is_archived,
  sort_order,
  created_at,
  updated_at,
  archived_at
)
SELECT
  id,
  brand,
  name,
  engine_cc,
  fuel_type,
  transmission,
  is_active,
  is_archived,
  sort_order,
  created_at,
  updated_at,
  archived_at
FROM public.products
WHERE category = 'motorcycle'
ON CONFLICT (id) DO UPDATE
SET
  brand = EXCLUDED.brand,
  model = EXCLUDED.model,
  engine_cc = EXCLUDED.engine_cc,
  fuel_type = EXCLUDED.fuel_type,
  transmission = EXCLUDED.transmission,
  is_active = EXCLUDED.is_active,
  is_archived = EXCLUDED.is_archived,
  sort_order = EXCLUDED.sort_order,
  created_at = EXCLUDED.created_at,
  updated_at = EXCLUDED.updated_at,
  archived_at = EXCLUDED.archived_at;

ALTER TABLE public.motorcycle_catalog
  DROP CONSTRAINT IF EXISTS motorcycle_catalog_engine_cc_positive,
  DROP CONSTRAINT IF EXISTS motorcycle_catalog_fuel_type_valid,
  DROP CONSTRAINT IF EXISTS motorcycle_catalog_transmission_valid;

ALTER TABLE public.motorcycle_catalog
  ADD CONSTRAINT motorcycle_catalog_engine_cc_positive
    CHECK (engine_cc IS NULL OR engine_cc > 0),
  ADD CONSTRAINT motorcycle_catalog_fuel_type_valid
    CHECK (fuel_type IS NULL OR fuel_type IN ('FI', 'Carbureted', 'Electric')),
  ADD CONSTRAINT motorcycle_catalog_transmission_valid
    CHECK (transmission IS NULL OR transmission IN ('Manual', 'Semi-Automatic', 'Automatic'));

CREATE UNIQUE INDEX IF NOT EXISTS motorcycle_catalog_brand_model_unique
  ON public.motorcycle_catalog (brand, model)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS motorcycle_catalog_active_list_idx
  ON public.motorcycle_catalog (brand, model)
  WHERE is_active = true AND is_archived = false;

CREATE INDEX IF NOT EXISTS motorcycle_catalog_archive_list_idx
  ON public.motorcycle_catalog (is_archived, brand, model);

GRANT SELECT ON public.motorcycle_catalog TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.motorcycle_catalog TO authenticated;
GRANT ALL ON public.motorcycle_catalog TO service_role;

ALTER TABLE public.motorcycle_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "motorcycle catalog public read" ON public.motorcycle_catalog;
CREATE POLICY "motorcycle catalog public read" ON public.motorcycle_catalog
  FOR SELECT TO anon
  USING (is_active = true AND is_archived = false);

DROP POLICY IF EXISTS "motorcycle catalog admin write" ON public.motorcycle_catalog;
CREATE POLICY "motorcycle catalog admin write" ON public.motorcycle_catalog
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP TRIGGER IF EXISTS motorcycle_catalog_updated ON public.motorcycle_catalog;
CREATE TRIGGER motorcycle_catalog_updated
  BEFORE UPDATE ON public.motorcycle_catalog
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS motorcycle_catalog_archive_timestamp ON public.motorcycle_catalog;
CREATE TRIGGER motorcycle_catalog_archive_timestamp
  BEFORE UPDATE ON public.motorcycle_catalog
  FOR EACH ROW EXECUTE FUNCTION public.set_catalog_archive_timestamp();

DROP TRIGGER IF EXISTS admin_activity_motorcycle_catalog ON public.motorcycle_catalog;
CREATE TRIGGER admin_activity_motorcycle_catalog
  AFTER INSERT OR UPDATE OR DELETE ON public.motorcycle_catalog
  FOR EACH ROW EXECUTE FUNCTION public.record_admin_activity();

-- Motorcycle records now live exclusively in public.motorcycle_catalog.
DELETE FROM public.products WHERE category = 'motorcycle';

DROP INDEX IF EXISTS public.products_motorcycle_catalog_sort_idx;

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_engine_cc_positive,
  DROP CONSTRAINT IF EXISTS products_fuel_type_valid,
  DROP CONSTRAINT IF EXISTS products_transmission_valid,
  DROP COLUMN IF EXISTS engine_cc,
  DROP COLUMN IF EXISTS fuel_type,
  DROP COLUMN IF EXISTS transmission;

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_shop_category_check;

ALTER TABLE public.products
  ADD CONSTRAINT products_shop_category_check
  CHECK (category IN ('part', 'accessory'));
