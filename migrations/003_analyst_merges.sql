-- =============================================================================
-- Migration 003: Reversible Analyst Merges
-- Adds support for linking/merging duplicate analyst profiles reversibly
-- =============================================================================

-- 1. Add merged_into_id to analysts table
ALTER TABLE public.analysts
ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES public.analysts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_analysts_merged_into ON public.analysts(merged_into_id);

-- 2. Audit table for tracking merge events and reversibility
CREATE TABLE IF NOT EXISTS public.analyst_merges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    source_analyst_id UUID NOT NULL REFERENCES public.analysts(id) ON DELETE CASCADE,
    target_analyst_id UUID NOT NULL REFERENCES public.analysts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reversed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_analyst_merges_user ON public.analyst_merges(user_id);
CREATE INDEX IF NOT EXISTS idx_analyst_merges_source ON public.analyst_merges(source_analyst_id);

-- 3. Security & RLS
ALTER TABLE public.analyst_merges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analyst_merges FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.analyst_merges TO postgres, service_role;

