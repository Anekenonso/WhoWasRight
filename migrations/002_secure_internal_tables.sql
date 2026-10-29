-- =============================================================================
-- Migration 002: Secure Internal Tables (_migrations and fixture_cache)
-- Enables Row Level Security and revokes API-accessible privileges from
-- PUBLIC, anon, and authenticated roles to satisfy Supabase Security Advisor.
-- =============================================================================

-- 1. Enable Row Level Security on internal system tables
ALTER TABLE IF EXISTS public._migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.fixture_cache ENABLE ROW LEVEL SECURITY;

-- 2. Revoke all privileges from untrusted API roles (PUBLIC, anon, authenticated)
REVOKE ALL ON TABLE public._migrations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fixture_cache FROM PUBLIC, anon, authenticated;

-- 3. Explicitly ensure backend roles (postgres, service_role) retain needed privileges
GRANT ALL ON TABLE public._migrations TO postgres, service_role;
GRANT ALL ON TABLE public.fixture_cache TO postgres, service_role;

-- 4. No permissive public RLS policies are created on either table.
-- Default-deny applies to any non-bypassing role.

