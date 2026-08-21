# XReserve Help & Support System — Phase 1 Implementation Report

## Live Support Chat — Complete

---

## 1. Database Migration

**File:** `supabase/migrations/022_live_support_chat.sql` (903 lines)

### Tables Created

| Table | Purpose |
|---|---|
| `support_agent_status` | Agent availability (AVAILABLE/BUSY/OFFLINE) with max_chats limit |
| `support_chat_sessions` | Chat sessions with status, queue, unread tracking, timestamps |
| `support_chat_messages` | Individual messages with sender_type (user/admin), body, timestamps |

### Indexes

- `idx_chat_sessions_user_id` — user lookup
- `idx_chat_sessions_agent_id` — active chats by agent
- `idx_chat_sessions_waiting` — FIFO queue ordering
- `idx_chat_sessions_status` — status filtering
- `idx_chat_messages_session_id` — message history per session

---

## 2. RLS Policies

| Table | Policy | Access |
|---|---|---|
| `support_agent_status` | `agent_status_select_own` | Users see only their own agent status |
| `support_chat_sessions` | `chat_sessions_select_own` | Users see sessions where they are user or agent |
| `support_chat_messages` | `chat_messages_select_participant` | Users see messages in their sessions (via session membership) |

- INSERT/UPDATE/DELETE revoked from `anon`, `authenticated`, `public` on all tables
- All write operations go through SECURITY DEFINER RPCs
- No cross-user access possible

---

## 3. RPC Functions (16 total)

| Function | Purpose | Auth |
|---|---|---|
| `support_set_agent_status(p_status)` | Admin sets availability | is_admin_user() |
| `support_get_agent_status()` | Admin checks own status | is_admin_user() |
| `support_get_chat_availability()` | Agent count + wait estimate | authenticated |
| `support_start_live_chat()` | User starts/resumes chat (auto-assigns if agent available) | authenticated |
| `support_get_user_queue_position(p_session_id)` | Queue position for waiting user | authenticated (own only) |
| `support_accept_chat()` | Admin accepts oldest waiting chat (FIFO) | is_admin_user() |
| `support_end_chat(p_session_id)` | User or admin ends a chat | participant or admin |
| `support_send_chat_message(p_session_id, p_body)` | Send message in active chat | participant only |
| `support_mark_chat_read(p_session_id)` | Reset unread counter | participant only |
| `support_get_chat_history(p_session_id, p_limit, p_offset)` | Get messages for session | participant or admin |
| `support_get_user_active_chat()` | Get user's active/waiting chat | authenticated (own only) |
| `support_get_user_chat_history()` | List user's past chat sessions | authenticated (own only) |
| `support_admin_get_waiting_chats()` | List all WAITING sessions | is_admin_user() |
| `support_admin_get_active_chats()` | List all ACTIVE sessions | is_admin_user() |
| `support_admin_get_chat_stats()` | Dashboard counts | is_admin_user() |
| `_support_chat_updated_trigger()` | Auto-update updated_at | trigger |

---

## 4. Realtime Implementation

- `support_chat_messages` and `support_chat_sessions` added to `supabase_realtime` publication
- User client subscribes to 2 channels per active chat:
  - `chat-status-{id}` — session status changes (ENDED → cleanup)
  - `chat-msgs-{id}` — new message delivery
- Admin client subscribes to 2 channels per active conversation:
  - `admin-chat-{id}` — new messages from user
  - `admin-chat-status-{id}` — session ended by user
- Graceful cleanup on navigation/unmount
- Custom events (`xreserve:chat-message`, `xreserve:chat-status`) for cross-component communication

---

## 5. User UI

### Help & Support Page (`src/pages/help-support.js`)
- Agent availability display (green/yellow/red status)
- Real agent count from `support_get_chat_availability` RPC
- Wait time estimate (based on queue size, agent count, avg handling time)
- Start Live Chat / Join Queue button
- Active chat → "Return to Chat" card
- Waiting chat → "View Queue Status" card
- Link to Chat History

### Live Chat Page (`src/pages/live-chat.js`)
- Real-time message display with bubble UI
- User messages right-aligned (dark), support messages left-aligned (light)
- Timestamps on each message
- Auto-scroll to latest message
- Input with auto-resize textarea + Enter to send
- Optimistic message rendering
- Queue view with position updates (5s polling while waiting)
- End Chat with confirmation dialog (prevents accidental click)
- Connection state display
- Opaque surfaces (no background bleed-through)

### Chat History Page (`src/pages/chat-history.js`)
- List of ended chat sessions
- Each shows: date, duration, message count, status
- Click to view full conversation in read-only overlay
- Messages displayed with same bubble UI

---

## 6. Admin UI

### Admin Help & Support (`src/admin/live-chat.js` → `renderAdminHelpSupport`)
- Hub page linking to Live Chat Center

### Admin Live Chat Center (`src/admin/live-chat.js` → `renderAdminLiveChat`)
- Agent status toggle (Available/Busy/Offline)
- Dashboard stats: Active, Waiting, Available agents
- Waiting chats list with Accept button
- Active chats list with click-to-open
- Conversation view with:
  - Message history
  - Real-time new message delivery
  - Reply input
  - End Chat button
- Auto-refresh every 8s for dashboard
- Realtime subscriptions for active conversations

---

## 7. Queue System

- FIFO: oldest waiting session assigned first
- One active chat per user enforced server-side
- If agent available → immediate assignment (WAITING never created)
- If no agent → WAITING session with queue position
- Queue position updated via `support_get_user_queue_position` RPC
- Duplicate prevention: existing WAITING/ACTIVE session returned instead of creating new one

---

## 8. Agent Availability

- `support_agent_status` table with status (AVAILABLE/BUSY/OFFLINE) and max_chats limit
- Available count = agents with status=AVAILABLE AND active_chats < max_chats
- Agents set status via dropdown in admin chat center
- Default status: OFFLINE (no row = OFFLINE)

---

## 9. Wait Time Calculation

Based on:
- Queue size (WAITING sessions count)
- Available agent count (with capacity)
- Average handling time (from last 24h completed chats)

Formula: `wait = avg_handling_time × queue_size / available_agents`

Fallback: 2 minutes per queue slot if no historical data
Honest output: "Estimated wait unavailable" if data insufficient (never fabricated)

---

## 10. Floating Chat Icon

- **File:** `src/lib/chat.js`
- Fixed position: bottom-right, above bottom nav (bottom-24 on mobile, bottom-8 on desktop)
- Only appears when user has ACTIVE chat (not WAITING, not ENDED)
- Shows unread badge (red count) when there are unread messages
- Clicking navigates to live-chat page (does NOT open a floating window)
- Polls every 20s for active chat status
- Realtime updates for instant badge updates
- Hidden on sign out

---

## 11. Notifications Integration

Uses existing `create_notification()` system (no second notification architecture):

| Event | Recipient | Trigger |
|---|---|---|
| `chat_assigned` | User | Agent accepts chat |
| `chat_message` | Admin | User sends message |
| `chat_message` | User | Admin sends message |
| `chat_ended` | User | Admin ends chat |
| `chat_ended` | Admin | User ends chat |

Notification event types added to both user and admin notification page configs.

---

## 12. Security

- ✅ No service-role key exposed to frontend
- ✅ No secrets stored or logged
- ✅ No passwords or 2FA codes stored
- ✅ Cross-user message access prevented (RLS + RPC authorization)
- ✅ Cross-user session access prevented (RLS + RPC authorization)
- ✅ Admin authorization via existing `is_admin_user()` (super_admin + is_active)
- ✅ Existing financial RLS unchanged
- ✅ Existing wallet/deposit/sell security unchanged
- ✅ No financial RPC behavior changed
- ✅ Existing authentication unchanged
- ✅ All write operations through SECURITY DEFINER RPCs with explicit authorization checks

---

## 13. Mobile

- Floating icon positioned above bottom nav (bottom-24 on mobile)
- Chat input uses auto-resize textarea (max 120px height)
- Messages use max-width 80% for readability
- Bottom nav hidden when keyboard open (visualViewport listener)
- All controls accessible on narrow screens
- End Chat confirmation dialog prevents accidental taps

---

## 14. Dark/Light Mode

- All chat surfaces use semantic color tokens (text-primary, surface, border)
- User messages: `bg-action text-white` / `dark:bg-action-dark dark:text-background-dark`
- Support messages: `bg-black/[0.04]` / `dark:bg-white/[0.08]`
- Input fields use `.input-field` class (opaque background, no bleed-through)
- Buttons use `.btn-primary` / `.btn-secondary` (solid surfaces)
- Cards use `.card` class (opaque surface)
- Status indicators use green/yellow/red consistently across themes

---

## 15. Build Result

```
vite v6.4.3 building for production...
✓ 147 modules transformed.
dist/index.html                   1.25 kB
dist/assets/index-q5iachqR.css   69.65 kB
dist/assets/index-BOQz9QHq.js   562.07 kB
✓ built in 20.63s
```

**0 errors, 0 warnings** (chunk size advisory only)

---

## 16. Files Changed

### New Files (7)
| File | Lines | Purpose |
|---|---|---|
| `supabase/migrations/022_live_support_chat.sql` | 903 | Database migration |
| `src/lib/chat.js` | 227 | Chat state + floating icon + Realtime |
| `src/pages/help-support.js` | 201 | User Help & Support hub |
| `src/pages/live-chat.js` | 421 | User Live Chat page |
| `src/pages/chat-history.js` | 205 | User Chat History page |
| `src/admin/live-chat.js` | 446 | Admin Help & Support + Live Chat Center |

### Modified Files (8)
| File | Change |
|---|---|
| `src/pages/profile.js` | "Help center" → "Help & Support" + route |
| `src/admin/profile.js` | "Help center" → "Help & Support" + route |
| `src/app.js` | 5 new route registrations + imports |
| `src/core/router.js` | 2 new admin routes in adminRouteMap |
| `src/main.js` | Chat polling lifecycle (start/stop) |
| `src/layouts/admin.js` | "Live Chat" nav tab added |
| `src/pages/notifications.js` | Chat event types added |
| `src/admin/notifications-page.js` | Chat event types added |

---

## 17. Profile Menu Change

- ✅ "Help center" → "Help & Support" (user profile)
- ✅ "Help center" → "Help & Support" (admin profile)
- ✅ User route: `help-support`
- ✅ Admin route: `admin/help-support`
- ✅ "Help center" no longer appears anywhere in the codebase (0 matches)

---

## Phase 1 Status: COMPLETE

Phase 1 (Live Support Chat) is fully implemented and builds successfully.
Phase 2 (Support Tickets) has NOT been started per spec requirements.
