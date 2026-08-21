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
 * An active admin session is automatically AVAILABLE.
 * No manual status selection — the heartbeat proves the session is alive.
 *
 * Safe to call multiple times — guards prevent duplicate intervals.
 */
export async function initAgentStatus() {
  try {
    // Always set AVAILABLE — active admin session = available agent
    const { error: setError } = await supabase.rpc('support_set_agent_status', { p_status: 'AVAILABLE' });
    if (setError) {
      console.warn('[agent-status] set AVAILABLE failed:', setError.message);
      return;
    }
    currentStatus = 'AVAILABLE';

    // Start heartbeat to prove session is active
    startHeartbeat();
    startWatchdog();
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
    if (currentStatus === 'AVAILABLE') {
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
 * Return the last-known agent status (AVAILABLE / OFFLINE / null).
 */
export function getAgentStatus() {
  return currentStatus;
}

/**
 * Render a read-only status indicator into the given container element.
 * Reflects the actual backend/session state — not a permanent label.
 *
 * ● Available  — heartbeat is healthy, agent is AVAILABLE
 * ● Connecting — heartbeat may be stale or status is still initializing
 */
export function renderAgentStatusIndicator(container) {
  if (!container) return;

  const isHealthy = currentStatus === 'AVAILABLE' && heartbeatTimer !== null;
  const dotColor = isHealthy ? 'bg-green-500' : 'bg-yellow-500';
  const label = isHealthy ? 'Available' : 'Connecting';

  container.innerHTML = `
    <span class="flex h-2 w-2 rounded-full ${dotColor}"></span>
    <span class="text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark">${label}</span>
  `;
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
  if (heartbeatTimer === null && currentStatus === 'AVAILABLE') {
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
