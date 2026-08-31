-- Migration 046: Fix referral code generation — pure PostgreSQL, no extensions
-- Neither pg_random_bytes() (PG16+) nor gen_random_bytes() (pgcrypto) are available
-- Use md5(random() + clock_timestamp()) which is built into all PostgreSQL versions

CREATE OR REPLACE FUNCTION public._generate_referral_code_internal()
RETURNS VARCHAR(8)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hash TEXT;
    v_code VARCHAR(8);
    v_chars VARCHAR(36) := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    v_i INTEGER;
    v_hex_val INTEGER;
    v_hex_char TEXT;
BEGIN
    -- Generate a random hash using built-in PostgreSQL functions
    -- md5() produces 32 hex chars; we use multiple rounds for entropy
    v_hash := md5(random()::text || clock_timestamp()::text || gen_random_uuid()::text);
    v_code := '';
    
    -- Take first 8 hex char pairs from the hash and map to our 36-char alphabet
    FOR v_i IN 1..8 LOOP
        v_hex_char := substr(v_hash, v_i * 2 - 1, 2);
        -- Convert hex pair (00-ff = 0-255) to integer
        v_hex_val := ('x' || v_hex_char)::bit(8)::integer;
        -- Map to our 36-character alphabet
        v_code := v_code || substr(v_chars, (v_hex_val % 36) + 1, 1);
    END LOOP;
    
    RETURN v_code;
END;
$$;

-- Revoke all access from this internal function (re-apply after OR REPLACE)
REVOKE ALL ON FUNCTION public._generate_referral_code_internal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._generate_referral_code_internal() FROM authenticated;
REVOKE ALL ON FUNCTION public._generate_referral_code_internal() FROM anon;
