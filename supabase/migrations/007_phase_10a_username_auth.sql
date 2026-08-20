-- XReserve Phase 10A — Username + Password Authentication Foundation
-- Add username column to profiles table for username/password auth

-- =============================================================================
-- 1. ADD USERNAME COLUMN TO PROFILES
-- =============================================================================

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS username TEXT;

-- Case-insensitive uniqueness: "JohnDoe" and "johndoe" are the same identity
-- Email-based auth (Supabase) is case-insensitive by RFC 5321
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_lower
  ON public.profiles (LOWER(username));

-- =============================================================================
-- 2. UPDATE AUTO-PROVISION TRIGGER
--    Extract username from metadata if present
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _wallet_id UUID;
  _username TEXT;
BEGIN
  -- Extract username from metadata if present (for username/password auth)
  _username := NEW.raw_user_meta_data->>'username';
  
  -- 1. Profile
  INSERT INTO public.profiles (id, full_name, avatar_url, email, username)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'avatar_url',
    NEW.email,
    _username
  );

  -- 2. Wallet
  INSERT INTO public.wallets (user_id)
  VALUES (NEW.id)
  RETURNING id INTO _wallet_id;

  -- 3. Balance row
  INSERT INTO public.wallet_balances (wallet_id)
  VALUES (_wallet_id);

  RETURN NEW;
END;
$$;

-- Drop and recreate to apply changes
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================================================
-- 3. USERNAME VALIDATION FUNCTION
--    Server-side validation for username format
-- =============================================================================

CREATE OR REPLACE FUNCTION public.validate_username(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Check length (3-24 characters)
  IF LENGTH(p_username) < 3 OR LENGTH(p_username) > 24 THEN
    RETURN FALSE;
  END IF;
  
  -- Check format: letters (case-sensitive), numbers, underscore, dot only
  IF p_username !~ '^[a-zA-Z0-9_.]+$' THEN
    RETURN FALSE;
  END IF;
  
  -- Check for reserved usernames (case-insensitive)
  IF LOWER(p_username) IN ('admin', 'administrator', 'root', 'system', 'support', 'help', 'api', 'null', 'undefined', 'moderator', 'staff') THEN
    RETURN FALSE;
  END IF;
  
  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 4. RPC: CHECK USERNAME AVAILABILITY
--    Allows client to check if username is taken before signup
-- =============================================================================

CREATE OR REPLACE FUNCTION public.check_username_available(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _exists BOOLEAN;
BEGIN
  -- Normalize username
  p_username := LOWER(TRIM(p_username));
  
  -- Validate format
  IF NOT public.validate_username(p_username) THEN
    RETURN FALSE;
  END IF;
  
  -- Check if username exists
  SELECT EXISTS(
    SELECT 1 FROM public.profiles
    WHERE LOWER(username) = LOWER(p_username)
  ) INTO _exists;
  
  RETURN NOT _exists;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.check_username_available(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_username_available(TEXT) TO anon;

-- =============================================================================
-- 5. PREVENT USERNAME UPDATES
--    Username is immutable after creation — it derives the synthetic identity
-- =============================================================================

CREATE OR REPLACE FUNCTION public.prevent_username_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'username cannot be changed after registration';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_username_update ON public.profiles;

CREATE TRIGGER trg_prevent_username_update
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (OLD.username IS DISTINCT FROM NEW.username)
  EXECUTE FUNCTION public.prevent_username_update();
