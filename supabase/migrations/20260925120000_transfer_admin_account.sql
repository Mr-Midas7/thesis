-- Transfer the sole application administrator to the verified Supabase Auth
-- user. The prior account was a bootstrap account and must not retain access.
--
-- Historical audit rows intentionally keep their captured email/summary. Their
-- UUID foreign keys are cleared when the old auth user is removed, rather than
-- being reassigned to the new administrator and misattributing past actions.
DO $$
DECLARE
  v_target_admin_id constant uuid := '7a9e497f-8c3f-44a7-ab4e-c9247c50eb74';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_target_admin_id) THEN
    RAISE EXCEPTION 'The replacement administrator does not exist in Supabase Auth.';
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_target_admin_id, 'admin')
  ON CONFLICT (user_id, role) DO NOTHING;

  -- price_history.changed_by has a restrictive foreign key. It is nullable and
  -- retains changed_by_email, so clear only this blocking pointer before the
  -- old Auth account is deleted. Other dependent audit tables use ON DELETE
  -- SET NULL and retain their historical metadata automatically.
  UPDATE public.price_history
  SET changed_by = NULL
  WHERE changed_by IN (
    SELECT user_id
    FROM public.user_roles
    WHERE role = 'admin'
      AND user_id <> v_target_admin_id
  );

  -- Deleting the former Admin Auth account revokes its credentials and cascades
  -- the obsolete role row. Current RLS policies and functions resolve access
  -- through user_roles, so the replacement account is the only administrator.
  DELETE FROM auth.users AS former_admin
  WHERE former_admin.id <> v_target_admin_id
    AND EXISTS (
      SELECT 1
      FROM public.user_roles AS role_assignment
      WHERE role_assignment.user_id = former_admin.id
        AND role_assignment.role = 'admin'
    );
END;
$$;
