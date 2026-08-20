import { supabase } from '@/lib/supabase';
import QRCode from 'qrcode';

// --- Edge Function helpers ---

async function callEdgeFunction(name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// --- 2FA Status (RPC — simple DB read, no TOTP logic) ---

export async function get2FAStatus() {
  const { data, error } = await supabase.rpc('get_2fa_status');
  if (error) throw error;
  return data?.[0] || { enabled: false, created_at: null };
}

// --- 2FA Enrollment (Edge Function) ---

export async function begin2FAEnrollment() {
  return callEdgeFunction('enroll-2fa', {});
}

export async function confirm2FAEnrollment(code) {
  return callEdgeFunction('verify-2fa-setup', { code });
}

// --- Disable 2FA (Edge Function) ---

export async function disable2FA(code) {
  return callEdgeFunction('disable-2fa', { code });
}

// --- Verify TOTP code → get verification_id (Edge Function) ---

export async function verify2FACode(code, scope) {
  const data = await callEdgeFunction('verify-2fa', { code, scope: scope || undefined });
  return data.verification_id;
}

// --- QR code rendering (client-side) ---

export async function renderQRCode(container, otpauthUri) {
  try {
    const dataUrl = await QRCode.toDataURL(otpauthUri, {
      width: 200,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
    container.innerHTML = `<img src="${dataUrl}" alt="QR Code" class="mx-auto" style="width:200px;height:200px" />`;
  } catch {
    container.innerHTML = `<p class="text-[12px] text-text-secondary dark:text-text-secondary-dark text-center">QR code unavailable. Enter the secret manually in your authenticator app.</p>`;
  }
}
