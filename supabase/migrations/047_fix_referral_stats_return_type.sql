-- Migration 047: Fix get_my_referral_stats to return single JSON object
-- Previous version returned TABLE() which causes Supabase RPC to return an array
-- Must DROP first because PostgreSQL doesn't allow changing return type with CREATE OR REPLACE

DROP FUNCTION IF EXISTS public.get_my_referral_stats();

CREATE FUNCTION public.get_my_referral_stats()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_count BIGINT;
    v_referrals JSONB;
BEGIN
    v_user_id := (SELECT auth.uid());
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM public.referral_redemptions
    WHERE referrer_id = v_user_id;

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
    ) INTO v_referrals
    FROM public.referral_redemptions rr
    WHERE rr.referrer_id = v_user_id;

    RETURN jsonb_build_object(
        'referral_count', v_count,
        'referrals', v_referrals
    );
END;
$$;

-- Revoke and re-grant
REVOKE ALL ON FUNCTION public.get_my_referral_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_referral_stats() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_referral_stats() TO authenticated;
