-- Services may be created directly through PostgREST, so the required-field
-- rules enforced by the admin form must also be enforced by PostgreSQL.

-- Preserve older records while making them editable under the new requirement.
UPDATE public.services
SET description = 'Service details pending review.'
WHERE description IS NULL OR btrim(description) = '';

ALTER TABLE public.services
  ALTER COLUMN description SET NOT NULL,
  ALTER COLUMN category DROP DEFAULT,
  ALTER COLUMN price DROP DEFAULT,
  ALTER COLUMN duration_minutes DROP DEFAULT;

ALTER TABLE public.services
  DROP CONSTRAINT IF EXISTS services_name_required,
  DROP CONSTRAINT IF EXISTS services_category_required,
  DROP CONSTRAINT IF EXISTS services_description_required,
  DROP CONSTRAINT IF EXISTS services_price_valid,
  DROP CONSTRAINT IF EXISTS services_duration_valid,
  ADD CONSTRAINT services_name_required
    CHECK (char_length(btrim(name)) >= 2),
  ADD CONSTRAINT services_category_required
    CHECK (char_length(btrim(category)) >= 2),
  ADD CONSTRAINT services_description_required
    CHECK (char_length(btrim(description)) > 0),
  ADD CONSTRAINT services_price_valid
    CHECK (price >= 0),
  ADD CONSTRAINT services_duration_valid
    CHECK (duration_minutes BETWEEN 15 AND 480);
