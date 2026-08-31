-- Migration 044: Referral System
-- Purpose: Secure referral code generation and attribution
-- Security: Server-authoritative, atomic, no client-side user ID trust

-- ============================================================================
-- 1. REFERRAL CODES TABLE
-- ============================================================================
-- Stores unique referral codes per user (lazy generation)
CREATE TABLE IF NOT EXISTS public.referral_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    code VARCHAR(8) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Each user can have only ONE referral code
    CONSTRAINT uq_referral_codes_user_id UNIQUE (user_id),
    -- Each code must be unique across all users
    CONSTRAINT uq_referral_codes_code UNIQUE (code),
    -- Code must be exactly 8 characters
    CONSTRAINT chk_referral_codes_length CHECK (char_length(code) = 8),
    -- Code must be alphanumeric (URL-safe)
    CONSTRAINT chk_referral_codes_format CHECK (code ~ '^[A-Z0-9]{8}$')
);

-- Index for fast code lookup during redemption
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON public.referral_codes(code);

-- RLS for referral_codes
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;

-- Users can only read their own referral code
DROP POLICY IF EXISTS "Users can read own referral code" ON public.referral_codes;
CREATE POLICY "Users can read own referral code"
    ON public.referral_codes
    FOR SELECT
    TO authenticated
    USING ((SELECT auth.uid()) = user_id);

-- No INSERT/UPDATE/DELETE for normal users (writes via SECURITY DEFINER only)
-- Service role can do anything (for admin operations if needed)

-- ============================================================================
-- 2. REFERRAL REDEMPTIONS TABLE
-- ============================================================================
-- Tracks which user was referred by which user
CREATE TABLE IF NOT EXISTS public.referral_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    referred_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    code_used VARCHAR(8) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Each user can only be referred ONCE (by one referrer)
    CONSTRAINT uq_referral_redemptions_referred_user_id UNIQUE (referred_user_id),
    -- Self-referral is forbidden at database level
    CONSTRAINT chk_referral_no_self_referral CHECK (referrer_id != referred_user_id)
);

-- Index for fast lookup of referrals by referrer
CREATE INDEX IF NOT EXISTS idx_referral_redemptions_referrer_id 
    ON public.referral_redemptions(referrer_id);

-- RLS for referral_redemptions
ALTER TABLE public.referral_redemptions ENABLE ROW LEVEL SECURITY;

-- Users can read redemptions where they are the referrer
DROP POLICY IF EXISTS "Users can read own referrals" ON public.referral_redemptions;
CREATE POLICY "Users can read own referrals"
    ON public.referral_redemptions
    FOR SELECT
    TO authenticated
    USING ((SELECT auth.uid()) = referrer_id);

-- Users can also read their own redemption (to see who referred them)
DROP POLICY IF EXISTS "Users can read own redemption" ON public.referral_redemptions;
CREATE POLICY "Users can read own redemption"
    ON public.referral_redemptions
    FOR SELECT
    TO authenticated
    USING ((SELECT auth.uid()) = referred_user_id);

-- No INSERT/UPDATE/DELETE for normal users (writes via SECURITY DEFINER only)

-- ============================================================================
-- 3. SECURE REFERRAL CODE GENERATION FUNCTION
-- ============================================================================
-- Internal function to generate a cryptographically secure 8-char alphanumeric code
-- Uses pg_random_bytes for entropy, converts to base36 (A-Z, 0-9)
CREATE OR REPLACE FUNCTION public._generate_referral_code_internal()
RETURNS VARCHAR(8)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_bytes BYTEA;
    v_code VARCHAR(8);
    v_chars VARCHAR(36) := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    v_i INTEGER;
    v_byte_val INTEGER;
BEGIN
    -- Generate 8 random bytes (64 bits of entropy)
    v_bytes := pg_random_bytes(8);
    v_code := '';
    
    -- Convert each byte to a character in our alphabet
    FOR v_i IN 1..8 LOOP
        v_byte_val := get_byte(v_bytes, v_i - 1);
        -- Map byte (0-255) to our 36-character alphabet
        v_code := v_code || substr(v_chars, (v_byte_val % 36) + 1, 1);
    END LOOP;
    
    RETURN v_code;
END;
$$;

-- Revoke all access from this internal function
REVOKE ALL ON FUNCTION public._generate_referral_code_internal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._generate_referral_code_internal() FROM authenticated;
REVOKE ALL ON FUNCTION public._generate_referral_code_internal() FROM anon;

-- ============================================================================
-- 4. GET OR CREATE MY REFERRAL CODE (Lazy Generation)
-- ============================================================================
-- Returns the authenticated user's referral code, generating one if it doesn't exist
-- This is the SAFE alternative to modifying handle_new_user()
CREATE OR REPLACE FUNCTION public.get_my_referral_code()
RETURNS VARCHAR(8)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_code VARCHAR(8);
    v_existing_code VARCHAR(8);
    v_attempts INTEGER := 0;
    v_max_attempts INTEGER := 10;
BEGIN
    -- Get authenticated user ID from session context (NOT from client)
    v_user_id := (SELECT auth.uid());
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    
    -- Check if user already has a code
    SELECT code INTO v_existing_code
    FROM public.referral_codes
    WHERE user_id = v_user_id;
    
    IF v_existing_code IS NOT NULL THEN
        RETURN v_existing_code;
    END IF;
    
    -- Generate a unique code with retry logic
    LOOP
        v_attempts := v_attempts + 1;
        IF v_attempts > v_max_attempts THEN
            RAISE EXCEPTION 'Failed to generate unique referral code after % attempts', v_max_attempts;
        END IF;
        
        v_code := public._generate_referral_code_internal();
        
        BEGIN
            INSERT INTO public.referral_codes (user_id, code)
            VALUES (v_user_id, v_code);
            
            RETURN v_code;
        EXCEPTION WHEN unique_violation THEN
            -- Code collision, try again
            CONTINUE;
        END;
    END LOOP;
END;
$$;

-- Grant to authenticated users only
REVOKE ALL ON FUNCTION public.get_my_referral_code() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_referral_code() TO authenticated;

-- ============================================================================
-- 5. REDEEM REFERRAL CODE (Atomic, Secure)
-- ============================================================================
-- Atomically redeems a referral code for the authenticated user
-- Client provides ONLY the code; server resolves referrer_id
-- Security: No client-supplied user IDs, atomic transaction, self-referral blocked
CREATE OR REPLACE FUNCTION public.redeem_referral_code(p_code VARCHAR(8))
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_referred_user_id UUID;
    v_referrer_id UUID;
    v_existing_referrer UUID;
BEGIN
    -- Get authenticated user ID from session context (NOT from client)
    v_referred_user_id := (SELECT auth.uid());
    IF v_referred_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    
    -- Validate code format
    IF p_code IS NULL OR char_length(p_code) != 8 OR p_code !~ '^[A-Z0-9]{8}$' THEN
        RAISE EXCEPTION 'Invalid referral code format';
    END IF;
    
    -- Check if user has already been referred (atomic check)
    SELECT referrer_id INTO v_existing_referrer
    FROM public.referral_redemptions
    WHERE referred_user_id = v_referred_user_id;
    
    IF v_existing_referrer IS NOT NULL THEN
        -- User already has a referrer, return false (not an error)
        RETURN FALSE;
    END IF;
    
    -- Resolve code to referrer_id (server-authoritative)
    SELECT user_id INTO v_referrer_id
    FROM public.referral_codes
    WHERE code = UPPER(p_code);
    
    IF v_referrer_id IS NULL THEN
        RAISE EXCEPTION 'Invalid referral code';
    END IF;
    
    -- Self-referral check (redundant with DB constraint, but explicit)
    IF v_referrer_id = v_referred_user_id THEN
        RAISE EXCEPTION 'Cannot use your own referral code';
    END IF;
    
    -- Atomically insert the redemption relationship
    -- The UNIQUE constraint on referred_user_id prevents double-redemption
    -- The CHECK constraint prevents self-referral
    BEGIN
        INSERT INTO public.referral_redemptions (referrer_id, referred_user_id, code_used)
        VALUES (v_referrer_id, v_referred_user_id, UPPER(p_code));
        
        RETURN TRUE;
    EXCEPTION WHEN unique_violation THEN
        -- User was already referred (race condition handled)
        RETURN FALSE;
    END;
END;
$$;

-- Grant to authenticated users only
REVOKE ALL ON FUNCTION public.redeem_referral_code(VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_referral_code(VARCHAR) TO authenticated;

-- ============================================================================
-- 6. GET MY REFERRAL STATS
-- ============================================================================
-- Returns the authenticated user's referral statistics and list
CREATE OR REPLACE FUNCTION public.get_my_referral_stats()
RETURNS TABLE (
    referral_count BIGINT,
    referrals JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    -- Get authenticated user ID from session context
    v_user_id := (SELECT auth.uid());
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    
    -- Count referrals
    SELECT COUNT(*) INTO referral_count
    FROM public.referral_redemptions
    WHERE referrer_id = v_user_id;
    
    -- Get referral details with usernames
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'referred_user_id', rr.referred_user_id,
                'referred_at', rr.created_at,
                'code_used', rr.code_used
            )
            ORDER BY rr.created_at DESC
        ),
        '[]'::jsonb
    ) INTO referrals
    FROM public.referral_redemptions rr
    WHERE rr.referrer_id = v_user_id;
    
    RETURN NEXT;
END;
$$;

-- Grant to authenticated users only
REVOKE ALL ON FUNCTION public.get_my_referral_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_referral_stats() TO authenticated;

-- ============================================================================
-- 7. BACKFILL EXISTING USERS (Optional, can be done later)
-- ============================================================================
-- For existing users, we use lazy generation (they get a code when they open Referrals)
-- If immediate backfill is needed, uncomment and run this block:
/*
DO $$
DECLARE
    v_user RECORD;
    v_code VARCHAR(8);
    v_attempts INTEGER;
BEGIN
    FOR v_user IN SELECT id FROM auth.users
    LOOP
        -- Check if user already has a code
        IF NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE user_id = v_user.id) THEN
            -- Generate unique code
            v_attempts := 0;
            LOOP
                v_attempts := v_attempts + 1;
                EXIT WHEN v_attempts > 10;
                
                v_code := public._generate_referral_code_internal();
                
                BEGIN
                    INSERT INTO public.referral_codes (user_id, code)
                    VALUES (v_user.id, v_code);
                    EXIT; -- Success
                EXCEPTION WHEN unique_violation THEN
                    CONTINUE; -- Try again
                END;
            END LOOP;
        END IF;
    END LOOP;
END;
$$;
*/

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- Referral system is ready for use
-- Lazy generation ensures handle_new_user() is not modified
-- All RPCs use auth.uid() for user identification (no client trust)
-- Atomic redemption with database constraints
