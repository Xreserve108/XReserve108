import { supabase } from '@/lib/supabase';

// =============================================================================
// Global Agent Status — shared across all admin pages
// =============================================================================
// Manages the agent availability heartbeat and status lifecycle for the
// entire admin session.  The heartbeat keeps last_heartbeat_at fresh so
// that support_get_chat_availability() counts this agent correctly.
//
// Resilience:
//   - try/catch around all RPCs so a network blip never kills the flow
//   - Watchdog timer (WATCHDOG_MS) periodically verifies the heartbeat
//     interval is alive and restarts it if it was lost (e.g. Vite HMR)
//   - HMR dispose handler stops timers so replaced modules don't leak
// =============================================================================

const HEARTBEAT_MS  = 60_000;  // 60 seconds
const WATCHDOG_MS   = 90_000;  // 90 seconds — must exceed HEARTBEAT_MS

let heartbeatTimer = null;
let watchdogTimer  = null;
let currentStatus  = null;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Initialise agent status for the admin session.
 * Called once from the auth lifecycle (main.js) when admin is detected.
 *
 * - If no row exists → default to AVAILABLE (solves "0 agents" problem).
 * - If status is BUSY → preserve (admin explicitly chose busy).
 * - Otherwise → ensure AVAILABLE and start heartbeat.
 *
 * Safe to call multiple times — guards prevent duplicate intervals.
 */
export async function initAgentStatus() {
  try {
    const { data: status, error } = await supabase.rpc('support_get_agent_status');
    if (error) {
      console.warn('[agent-status] get status failed:', error.message);
      return;
    }
    currentStatus = status || 'OFFLINE';

    // Auto-activate unless admin explicitly chose BUSY
    if (currentStatus !== 'BUSY') {
      const { error: setError } = await supabase.rpc('support_set_agent_status', { p_status: 'AVAILABLE' });
      if (setError) {
        console.warn('[agent-status] set AVAILABLE failed:', setError.message);
        return;
      }
      currentStatus = 'AVAILABLE';
    }

    // Heartbeat for AVAILABLE and BUSY (keeps last_heartbeat_at fresh)
    if (currentStatus === 'AVAILABLE' || currentStatus === 'BUSY') {
      startHeartbeat();
      startWatchdog();
    }
  } catch (err) {
    console.warn('[agent-status] init failed:', err);
  }
}

/**
 * Resume heartbeat if agent should be active but heartbeat died.
 * Called by the watchdog or after session recovery — does NOT change
 * the DB status, only ensures the heartbeat interval is running.
 */
export async function resumeAgentStatus() {
  try {
    const { data: status } = await supabase.rpc('support_get_agent_status');
    currentStatus = status || 'OFFLINE';
    if (currentStatus === 'AVAILABLE' || currentStatus === 'BUSY') {
      startHeartbeat();
      startWatchdog();
    }
  } catch {
    // Silent — watchdog will retry
  }
}

/**
 * Stop heartbeat, watchdog, and reset status tracker.
 * Called when admin signs out.
 */
export function stopAgentStatus() {
  stopHeartbeat();
  stopWatchdog();
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
    const { error } = await supabase.rpc('support_set_agent_status', { p_status: newStatus });
    if (error) {
      console.warn('[agent-status] set status failed:', error.message);
      return;
    }
    currentStatus = newStatus;
    // Re-render the dropdown with updated colours
    renderAgentStatusDropdown(container);
    // Heartbeat: start for AVAILABLE/BUSY, stop for OFFLINE
    if (newStatus === 'AVAILABLE' || newStatus === 'BUSY') {
      startHeartbeat();
      startWatchdog();
    } else {
      stopHeartbeat();
      stopWatchdog();
    }
  });
}

// -----------------------------------------------------------------------------
// Internal — heartbeat management
// -----------------------------------------------------------------------------

function startHeartbeat() {
  if (heartbeatTimer !== null) return; // already running
  fireHeartbeat();
  heartbeatTimer = setInterval(fireHeartbeat, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** Fire heartbeat RPC with error suppression — never throws. */
function fireHeartbeat() {
  supabase.rpc('support_agent_heartbeat').then(({ error }) => {
    if (error) console.warn('[agent-status] heartbeat RPC error:', error.message);
  }).catch(() => { /* network error — interval stays alive for retry */ });
}

// -----------------------------------------------------------------------------
// Internal — watchdog (recovers heartbeat after HMR or silent interval death)
// -----------------------------------------------------------------------------

function startWatchdog() {
  if (watchdogTimer !== null) return; // already running
  watchdogTimer = setInterval(watchdogCheck, WATCHDOG_MS);
}

function stopWatchdog() {
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/**
 * Watchdog: verifies the heartbeat interval is alive.
 * If the timer was lost (e.g. Vite HMR replaced the module), restarts
 * the heartbeat immediately.  Also fires a one-shot heartbeat RPC to
 * quickly refresh the DB timestamp.
 */
function watchdogCheck() {
  if (heartbeatTimer === null && (currentStatus === 'AVAILABLE' || currentStatus === 'BUSY')) {
    console.warn('[agent-status] Watchdog: heartbeat was dead — restarting');
    fireHeartbeat();
    heartbeatTimer = setInterval(fireHeartbeat, HEARTBEAT_MS);
  }
}

// -----------------------------------------------------------------------------
// Vite HMR — clean up timers when module is replaced during development
// -----------------------------------------------------------------------------
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopHeartbeat();
    stopWatchdog();
  });
}
