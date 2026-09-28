-- Allow one active Supabase Auth session per administrator. The database lease
-- is bound to the signed JWT session_id claim, so copying requests, refreshing
-- the page, or bypassing the UI cannot grant a second session admin access.

CREATE TABLE IF NOT EXISTS public.admin_session_leases (
  admin_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_session_handover_tokens (
  token uuid PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_session_handover_tokens_expiry_idx
  ON public.admin_session_handover_tokens (expires_at);

ALTER TABLE public.admin_session_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_session_handover_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_session_leases FROM anon, authenticated;
REVOKE ALL ON TABLE public.admin_session_handover_tokens FROM anon, authenticated;
GRANT ALL ON TABLE public.admin_session_leases TO service_role;
GRANT ALL ON TABLE public.admin_session_handover_tokens TO service_role;

CREATE OR REPLACE FUNCTION public.current_admin_auth_session_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT NULLIF(auth.jwt() ->> 'session_id', '')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.is_current_admin_session(p_admin_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    p_admin_id IS NOT NULL
    AND p_admin_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.user_roles AS role
      WHERE role.user_id = p_admin_id
        AND role.role::text = 'admin'
    )
    AND EXISTS (
      SELECT 1
      FROM public.admin_session_leases AS lease
      JOIN auth.sessions AS session
        ON session.id = lease.session_id
       AND session.user_id = lease.admin_id
      WHERE lease.admin_id = p_admin_id
        AND lease.session_id = public.current_admin_auth_session_id()
        AND lease.expires_at > now()
    );
$$;

-- Existing RLS policies created before the role enum migration still point to
-- has_role_legacy. Update both role helpers so every protected admin path uses
-- the same server-side session restriction.
CREATE OR REPLACE FUNCTION public.has_role_legacy(
  _user_id uuid,
  _role public.app_role_legacy
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role::text = _role::text
  )
  AND public.is_current_admin_session(_user_id);
$$;

CREATE OR REPLACE FUNCTION public.has_role(
  _user_id uuid,
  _role public.app_role
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
  AND public.is_current_admin_session(_user_id);
$$;

CREATE OR REPLACE FUNCTION public.claim_admin_session(
  p_handover_token uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_session_id uuid := public.current_admin_auth_session_id();
  v_existing_lease public.admin_session_leases%ROWTYPE;
  v_has_valid_handover boolean := false;
BEGIN
  IF v_admin_id IS NULL
     OR v_session_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_roles AS role
       WHERE role.user_id = v_admin_id
         AND role.role::text = 'admin'
     ) THEN
    RAISE EXCEPTION 'Only administrators can start an admin session.';
  END IF;

  -- Serialize all claim, renewal, and release decisions for one account.
  PERFORM pg_advisory_xact_lock(hashtext('admin-session-lease:' || v_admin_id::text));
  DELETE FROM public.admin_session_handover_tokens WHERE expires_at <= now();

  SELECT lease.*
  INTO v_existing_lease
  FROM public.admin_session_leases AS lease
  WHERE lease.admin_id = v_admin_id
  FOR UPDATE;

  IF FOUND
     AND v_existing_lease.session_id <> v_session_id
     AND v_existing_lease.expires_at > now()
     AND EXISTS (
       SELECT 1
       FROM auth.sessions AS session
       WHERE session.id = v_existing_lease.session_id
         AND session.user_id = v_admin_id
     ) THEN
    IF p_handover_token IS NOT NULL THEN
      SELECT true
      INTO v_has_valid_handover
      FROM public.admin_session_handover_tokens AS handover
      WHERE handover.token = p_handover_token
        AND handover.admin_id = v_admin_id
        AND handover.session_id = v_existing_lease.session_id
        AND handover.expires_at > now()
      FOR UPDATE;
    END IF;

    IF NOT COALESCE(v_has_valid_handover, false) THEN
      RAISE EXCEPTION
        'An administrator session is already active. Sign out from the active device or wait for it to expire before signing in here.';
    END IF;

    DELETE FROM public.admin_session_handover_tokens
    WHERE token = p_handover_token;
  END IF;

  INSERT INTO public.admin_session_leases (
    admin_id,
    session_id,
    expires_at,
    last_seen_at
  )
  VALUES (
    v_admin_id,
    v_session_id,
    now() + interval '3 minutes',
    now()
  )
  ON CONFLICT (admin_id) DO UPDATE
  SET session_id = EXCLUDED.session_id,
      expires_at = EXCLUDED.expires_at,
      last_seen_at = EXCLUDED.last_seen_at;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_admin_session()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_session_id uuid := public.current_admin_auth_session_id();
BEGIN
  IF v_admin_id IS NULL OR v_session_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.admin_session_leases AS lease
  SET expires_at = now() + interval '3 minutes',
      last_seen_at = now()
  WHERE lease.admin_id = v_admin_id
    AND lease.session_id = v_session_id
    AND lease.expires_at > now()
    AND EXISTS (
      SELECT 1
      FROM auth.sessions AS session
      WHERE session.id = v_session_id
        AND session.user_id = v_admin_id
    );

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_admin_session()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_session_id uuid := public.current_admin_auth_session_id();
BEGIN
  IF v_admin_id IS NULL OR v_session_id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM public.admin_session_handover_tokens
  WHERE admin_id = v_admin_id
    AND session_id = v_session_id;

  DELETE FROM public.admin_session_leases
  WHERE admin_id = v_admin_id
    AND session_id = v_session_id;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_admin_session_handover()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_session_id uuid := public.current_admin_auth_session_id();
  v_token uuid := gen_random_uuid();
BEGIN
  IF NOT public.is_current_admin_session(v_admin_id) THEN
    RAISE EXCEPTION 'Your administrator session is no longer active. Please sign in again.';
  END IF;

  DELETE FROM public.admin_session_handover_tokens
  WHERE expires_at <= now()
     OR (admin_id = v_admin_id AND session_id = v_session_id);

  INSERT INTO public.admin_session_handover_tokens (token, admin_id, session_id, expires_at)
  VALUES (v_token, v_admin_id, v_session_id, now() + interval '2 minutes');

  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_admin_session()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_current_admin_session(auth.uid());
$$;

REVOKE ALL ON FUNCTION public.current_admin_auth_session_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_current_admin_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_admin_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renew_admin_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_admin_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_admin_session_handover() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_admin_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_role_legacy(uuid, public.app_role_legacy) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.claim_admin_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.renew_admin_session() TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_admin_session() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_admin_session_handover() TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_admin_session() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_role_legacy(uuid, public.app_role_legacy) TO authenticated, service_role;
