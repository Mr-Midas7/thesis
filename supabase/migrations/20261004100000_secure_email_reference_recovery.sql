-- Reference recovery is email-only. Verification codes are stored only as
-- hashes and are consumed atomically before reference codes are emailed.
-- Normalize pre-existing addresses so exact email lookups work consistently.
UPDATE public.appointments
SET email = lower(btrim(email))
WHERE email IS NOT NULL
  AND email IS DISTINCT FROM lower(btrim(email));

CREATE INDEX IF NOT EXISTS appointments_active_email_created_idx
  ON public.appointments (email, created_at DESC)
  WHERE is_archived = false AND email IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.appointment_reference_recovery_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 5),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_reference_recovery_challenges_email_created_idx
  ON public.appointment_reference_recovery_challenges (email, created_at DESC);

REVOKE ALL ON TABLE public.appointment_reference_recovery_challenges FROM anon, authenticated;
GRANT ALL ON TABLE public.appointment_reference_recovery_challenges TO service_role;
ALTER TABLE public.appointment_reference_recovery_challenges ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_reference_recovery_challenge(
  p_email text,
  p_code_hash text
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_challenge public.appointment_reference_recovery_challenges%ROWTYPE;
BEGIN
  SELECT challenge.*
    INTO v_challenge
  FROM public.appointment_reference_recovery_challenges AS challenge
  WHERE challenge.email = lower(btrim(p_email))
    AND challenge.verified_at IS NULL
  ORDER BY challenge.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND OR v_challenge.expires_at <= now() OR v_challenge.attempt_count >= 5 THEN
    RETURN 'expired';
  END IF;

  IF v_challenge.code_hash <> p_code_hash THEN
    UPDATE public.appointment_reference_recovery_challenges
    SET attempt_count = attempt_count + 1,
        expires_at = CASE WHEN attempt_count + 1 >= 5 THEN now() ELSE expires_at END
    WHERE id = v_challenge.id;
    RETURN 'invalid';
  END IF;

  UPDATE public.appointment_reference_recovery_challenges
  SET verified_at = now()
  WHERE id = v_challenge.id;

  RETURN 'verified';
END;
$$;

REVOKE ALL ON FUNCTION public.consume_reference_recovery_challenge(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_reference_recovery_challenge(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
