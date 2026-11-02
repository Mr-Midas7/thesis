-- Drops the one booking function version nothing calls.
--
-- create_booking_atomic exists with 22, 23 and 24 parameters, and that is on
-- purpose: each newer version adds one parameter and calls the previous one
-- (24 with p_wants_products -> 23 with p_email -> 22, which does the work).
-- update_appointment_details_atomic works the same way (12 -> 8). Those stay.
--
-- The 21-parameter version was a bridge for a frontend release that did not
-- send p_continuation_segments (migration 20260928130000). Bookings now go
-- through the server with all 24 parameters, so it is no longer used.
DROP FUNCTION IF EXISTS public.create_booking_atomic(
  text, uuid, text, text, text, text, text, integer, text, date, time without time zone,
  text, numeric, integer, uuid, jsonb, text, text, text, text, text
);
