-- A successful password login could claim a lease but then fail the protected
-- route's validation because it additionally queried auth.sessions. That
-- internal catalog is not required to prove a request owns its lease: Supabase
-- has already authenticated the JWT, and its session_id claim is compared to
-- the server-side lease. Removing that dependency prevents a valid new admin
-- login from being immediately signed out while preserving the one-session
-- restriction for all direct requests and UI routes.

DELETE FROM public.admin_session_leases
WHERE expires_at <= now();

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
      WHERE lease.admin_id = p_admin_id
        AND lease.session_id = public.current_admin_auth_session_id()
        AND lease.expires_at > now()
    );
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

  PERFORM pg_advisory_xact_lock(hashtext('admin-session-lease:' || v_admin_id::text));
  DELETE FROM public.admin_session_handover_tokens WHERE expires_at <= now();

  SELECT lease.*
  INTO v_existing_lease
  FROM public.admin_session_leases AS lease
  WHERE lease.admin_id = v_admin_id
  FOR UPDATE;

  IF FOUND
     AND v_existing_lease.session_id <> v_session_id
     AND v_existing_lease.expires_at > now() THEN
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
    AND lease.expires_at > now();

  RETURN FOUND;
END;
$$;

NOTIFY pgrst, 'reload schema';
