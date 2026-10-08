-- TextBee trial delivery is intentionally restricted to the approved demo
-- recipient. Other customer numbers still receive email notifications and
-- have their SMS row recorded as skipped without an error or API request.
ALTER TABLE public.appointment_confirmation_sms
  DROP CONSTRAINT IF EXISTS appointment_confirmation_sms_status_check;
ALTER TABLE public.appointment_confirmation_sms
  ADD CONSTRAINT appointment_confirmation_sms_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'skipped'));

ALTER TABLE public.appointment_completion_notifications
  DROP CONSTRAINT IF EXISTS appointment_completion_notifications_status_check;
ALTER TABLE public.appointment_completion_notifications
  ADD CONSTRAINT appointment_completion_notifications_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'skipped'));
