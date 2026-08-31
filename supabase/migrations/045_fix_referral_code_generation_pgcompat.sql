-- Migration 045: Fix referral code generation for PostgreSQL < 16
-- pg_random_bytes() is PG16+ only; use gen_random_bytes() from pgcrypto instead

-- Ensure pgcrypto extension is available (usually enabled by default in Supabase)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Replace the internal code generation function to use gen_random_bytes()
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
    -- Generate 8 random bytes using pgcrypto (compatible with all PG versions)
    v_bytes := gen_random_bytes(8);
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

-- Revoke all access from this internal function (re-apply after OR REPLACE)
REVOKE ALL ON FUNCTION public._generate_referral_code_internal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._generate_referral_code_internal() FROM authenticated;
REVOKE ALL ON FUNCTION public._generate_referral_code_internal() FROM anon;
