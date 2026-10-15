-- Cancelling or rescheduling online requires a one-time code emailed to the
-- address on the booking. A correct code issues a short-lived verification
-- token for that one appointment and action. Codes and tokens are stored only
-- as SHA-256 hashes, and the table is reachable only through the service role.
CREATE TABLE IF NOT EXISTS public.appointment_action_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('cancel', 'reschedule')),
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 5),
  verified_at timestamptz,
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  token_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((verified_at IS NULL) = (token_hash IS NULL)),
  CHECK ((token_hash IS NULL) = (token_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS appointment_action_verifications_lookup_idx
  ON public.appointment_action_verifications (appointment_id, action, created_at DESC);

REVOKE ALL ON TABLE public.appointment_action_verifications FROM anon, authenticated;
GRANT ALL ON TABLE public.appointment_action_verifications TO service_role;
ALTER TABLE public.appointment_action_verifications ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.verify_appointment_action_code(
  p_appointment_id uuid,
  p_action text,
  p_code_hash text,
  p_token_hash text,
  p_token_ttl_seconds integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_challenge public.appointment_action_verifications%ROWTYPE;
BEGIN
  IF p_token_ttl_seconds < 60 OR p_token_ttl_seconds > 7200 THEN
    RAISE EXCEPTION 'Verification token lifetime must be between 1 minute and 2 hours.';
  END IF;

  -- Only the newest unverified code for this appointment and action counts.
  SELECT challenge.*
    INTO v_challenge
  FROM public.appointment_action_verifications AS challenge
  WHERE challenge.appointment_id = p_appointment_id
    AND challenge.action = p_action
    AND challenge.verified_at IS NULL
  ORDER BY challenge.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND OR v_challenge.expires_at <= now() OR v_challenge.attempt_count >= 5 THEN
    RETURN 'expired';
  END IF;

  IF v_challenge.code_hash <> p_code_hash THEN
    UPDATE public.appointment_action_verifications
    SET attempt_count = attempt_count + 1,
        expires_at = CASE WHEN attempt_count + 1 >= 5 THEN now() ELSE expires_at END
    WHERE id = v_challenge.id;
    RETURN 'invalid';
  END IF;

  UPDATE public.appointment_action_verifications
  SET verified_at = now(),
      token_hash = p_token_hash,
      token_expires_at = now() + make_interval(secs => p_token_ttl_seconds)
  WHERE id = v_challenge.id;

  RETURN 'verified';
END;
$$;

REVOKE ALL ON FUNCTION public.verify_appointment_action_code(uuid, text, text, text, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_appointment_action_code(uuid, text, text, text, integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
