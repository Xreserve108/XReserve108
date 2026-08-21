import { getUser, getDisplayUsername } from '@/core/auth';
import { navigate } from '@/core/router';
import { supabase } from '@/lib/supabase';

export function renderAdminPersonalDetails() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  page.innerHTML = `
    <div class="flex items-center gap-3 mb-2">
      <button id="back-btn" class="flex h-8 w-8 items-center justify-center rounded-xl text-text-secondary transition-colors duration-150 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
        <svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
      </button>
      <h1 class="page-title">Personal Details</h1>
    </div>
    <p class="text-muted mt-1 mb-6">View and manage your admin account information</p>
    <div id="pd-content" class="flex items-center justify-center py-12">
      <div class="auth-spinner"></div>
    </div>
  `;

  page.querySelector('#back-btn').addEventListener('click', () => navigate('admin/profile'));
  loadAdminPersonalDetails(page);
  return page;
}

async function loadAdminPersonalDetails(page) {
  const container = page.querySelector('#pd-content');
  const user = getUser();
  const username = getDisplayUsername() || '—';
  const email = user?.email || '—';

  // Fetch profile data from the profiles table
  let fullName = '';
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', user.id)
      .single();
    if (!error && data) {
      fullName = data.full_name || '';
    }
  } catch {
    // Silently continue with empty name
  }

  container.className = '';
  container.innerHTML = `
    <div class="card p-6 max-w-lg w-full">
      <div class="flex items-center gap-2 mb-5">
        <span class="rounded-md bg-action/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-action dark:bg-action-dark/15 dark:text-action-dark">Admin</span>
      </div>
      <div class="space-y-4">
        <div>
          <label class="label">Username</label>
          <input type="text" class="input-field" value="${escapeAttr(username)}" readonly />
          <p class="mt-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">Username cannot be changed</p>
        </div>
        <div>
          <label class="label">Email</label>
          <input type="text" class="input-field" value="${escapeAttr(email)}" readonly />
          <p class="mt-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">Email address is managed by the system</p>
        </div>
        <div class="divider my-1"></div>
        <div>
          <label class="label" for="pd-full-name">Full Name</label>
          <input type="text" id="pd-full-name" class="input-field" value="${escapeAttr(fullName)}" placeholder="Enter your full name" maxlength="100" />
        </div>
      </div>
      <div class="flex gap-3 mt-6">
        <button id="pd-save" class="btn-primary flex-1" disabled>Save Changes</button>
      </div>
      <div id="pd-feedback" class="hidden mt-4"></div>
    </div>
  `;

  const nameInput = container.querySelector('#pd-full-name');
  const saveBtn = container.querySelector('#pd-save');
  const feedback = container.querySelector('#pd-feedback');

  nameInput.addEventListener('input', () => {
    saveBtn.disabled = nameInput.value.trim() === (fullName || '');
  });

  saveBtn.addEventListener('click', async () => {
    const newName = nameInput.value.trim();
    if (!newName || newName === fullName) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      // Update profiles table
      const { error: profileError } = await supabase
        .from('profiles')
        .update({ full_name: newName })
        .eq('id', user.id);
      if (profileError) throw profileError;

      // Update auth metadata
      await supabase.auth.updateUser({
        data: { full_name: newName },
      });

      showFeedback(feedback, 'Profile updated successfully', 'green');
      fullName = newName;
      saveBtn.textContent = 'Save Changes';
      saveBtn.disabled = true;
    } catch (err) {
      showFeedback(feedback, err.message || 'Failed to update profile', 'red');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  });
}

function showFeedback(el, message, color) {
  if (!el) return;
  el.className = `mt-4 rounded-xl px-4 py-3 text-[13px] font-medium ${
    color === 'green' ? 'bg-green-500/10 text-green-600 dark:text-green-400' :
    color === 'red' ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
    'bg-amber-500/10 text-amber-600 dark:text-amber-400'
  }`;
  el.textContent = message;
  el.classList.remove('hidden');
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
