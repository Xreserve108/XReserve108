import { supabase } from '@/lib/supabase';

// =============================================================================
// Global Agent Status — shared across all admin pages
// =============================================================================
// Manages the agent availability heartbeat and status lifecycle for the
// entire admin session.  The heartbeat keeps last_heartbeat_at fresh so
// that support_get_chat_availability() counts this agent correctly.
// =============================================================================

const HEARTBEAT_MS = 60_000; // 60 seconds

let heartbeatTimer = null;
let currentStatus = null;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Initialise agent status for the admin session.
 * Called once when the admin layout is created.
 *
 * - If no row exists → default to AVAILABLE (solves "0 agents" problem).
 * - If status is BUSY → preserve (admin explicitly chose busy).
 * - Otherwise → ensure AVAILABLE and start heartbeat.
 */
export async function initAgentStatus() {
  const { data: status } = await supabase.rpc('support_get_agent_status');
  currentStatus = status || 'OFFLINE';

  // Auto-activate unless admin explicitly chose BUSY
  if (currentStatus !== 'BUSY') {
    await supabase.rpc('support_set_agent_status', { p_status: 'AVAILABLE' });
    currentStatus = 'AVAILABLE';
  }

  // Heartbeat for AVAILABLE and BUSY (keeps last_heartbeat_at fresh)
  if (currentStatus === 'AVAILABLE' || currentStatus === 'BUSY') {
    startHeartbeat();
  }
}

/**
 * Stop heartbeat and reset status tracker.
 * Called when admin layout is torn down (switch to user layout or sign-out).
 */
export function stopAgentStatus() {
  stopHeartbeat();
  currentStatus = null;
}

/**
 * Return the last-known agent status (AVAILABLE / BUSY / OFFLINE / null).
 */
export function getAgentStatus() {
  return currentStatus;
}

/**
 * Render a compact status dropdown into the given container element.
 * The container should be an empty <div> already placed in the admin header.
 */
export function renderAgentStatusDropdown(container) {
  if (!container) return;

  const status = currentStatus || 'OFFLINE';
  const dotColors = {
    AVAILABLE: 'bg-green-500',
    BUSY: 'bg-yellow-500',
    OFFLINE: 'bg-text-secondary/40 dark:bg-text-secondary-dark/40',
  };

  container.innerHTML = `
    <span class="flex h-2 w-2 rounded-full ${dotColors[status] || dotColors.OFFLINE}"></span>
    <select id="global-agent-status-select" class="bg-transparent py-1 px-1 text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark border-none outline-none cursor-pointer">
      <option value="AVAILABLE" ${status === 'AVAILABLE' ? 'selected' : ''}>Available</option>
      <option value="BUSY" ${status === 'BUSY' ? 'selected' : ''}>Busy</option>
      <option value="OFFLINE" ${status === 'OFFLINE' ? 'selected' : ''}>Offline</option>
    </select>
  `;

  container.querySelector('#global-agent-status-select').addEventListener('change', async (e) => {
    const newStatus = e.target.value;
    await supabase.rpc('support_set_agent_status', { p_status: newStatus });
    currentStatus = newStatus;
    // Re-render the dropdown with updated colours
    renderAgentStatusDropdown(container);
    // Heartbeat: start for AVAILABLE/BUSY, stop for OFFLINE
    if (newStatus === 'AVAILABLE' || newStatus === 'BUSY') {
      startHeartbeat();
    } else {
      stopHeartbeat();
    }
  });
}

// -----------------------------------------------------------------------------
// Internal — heartbeat management
// -----------------------------------------------------------------------------

function startHeartbeat() {
  if (heartbeatTimer !== null) return; // already running
  supabase.rpc('support_agent_heartbeat');
  heartbeatTimer = setInterval(() => {
    supabase.rpc('support_agent_heartbeat');
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
