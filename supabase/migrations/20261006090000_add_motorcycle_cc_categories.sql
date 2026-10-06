-- Keep a model's engine displacement in the catalog and derive its category
-- in the database so clients cannot save an inconsistent classification.
ALTER TABLE public.motorcycle_catalog
  ADD COLUMN IF NOT EXISTS engine_cc numeric(6, 1);

ALTER TABLE public.motorcycle_catalog
  DROP CONSTRAINT IF EXISTS motorcycle_catalog_engine_cc_positive;

ALTER TABLE public.motorcycle_catalog
  ADD CONSTRAINT motorcycle_catalog_engine_cc_positive
  CHECK (engine_cc IS NULL OR engine_cc > 0);

ALTER TABLE public.motorcycle_catalog
  ADD COLUMN IF NOT EXISTS cc_category text GENERATED ALWAYS AS (
    CASE
      WHEN engine_cc IS NULL THEN NULL
      WHEN engine_cc <= 125 THEN 'small_bike'
      ELSE 'big_bike'
    END
  ) STORED;

COMMENT ON COLUMN public.motorcycle_catalog.cc_category IS
  'Derived from engine_cc: small_bike for 125cc and below; big_bike above 125cc.';

NOTIFY pgrst, 'reload schema';
