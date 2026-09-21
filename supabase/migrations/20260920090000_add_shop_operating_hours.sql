-- Customer bookings must fall entirely within these administrator-managed
-- operating hours. The booking grid supports half-hour starts only.
ALTER TABLE public.shop_settings
  ADD COLUMN IF NOT EXISTS opening_time time NOT NULL DEFAULT '08:00:00',
  ADD COLUMN IF NOT EXISTS closing_time time NOT NULL DEFAULT '17:00:00';

ALTER TABLE public.shop_settings
  DROP CONSTRAINT IF EXISTS shop_settings_operating_hours_valid;

ALTER TABLE public.shop_settings
  ADD CONSTRAINT shop_settings_operating_hours_valid
  CHECK (
    opening_time < closing_time
    AND EXTRACT(MINUTE FROM opening_time) IN (0, 30)
    AND EXTRACT(MINUTE FROM closing_time) IN (0, 30)
    AND EXTRACT(SECOND FROM opening_time) = 0
    AND EXTRACT(SECOND FROM closing_time) = 0
  );
