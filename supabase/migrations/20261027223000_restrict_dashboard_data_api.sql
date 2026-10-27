-- The dashboard authenticates with Clerk on the server and accesses Supabase
-- with service_role. Public API roles must not bypass that authorization.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE obj record;
BEGIN
  IF current_user <> 'postgres'
     OR to_regclass('public.user_profiles') IS NULL
     OR to_regclass('public.bloom_stock_completions') IS NULL THEN
    RAISE EXCEPTION 'Unexpected dashboard database or migration role';
  END IF;
  FOR obj IN SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',obj.relname);
  END LOOP;
  REVOKE USAGE ON SCHEMA public FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

  -- Respect the caller's permissions instead of executing as the view owner.
  ALTER VIEW public.rtf_by_location SET (security_invoker=true);
  ALTER VIEW public.hr_payout_view SET (security_invoker=true);
  ALTER VIEW public.scorecard_detail_view SET (security_invoker=true);
  -- Existing functions reference public objects without schema qualification.
  -- pg_catalog remains implicitly first; temporary objects must resolve last.
  FOR obj IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp',obj.signature);
  END LOOP;
END $$;
COMMIT;
