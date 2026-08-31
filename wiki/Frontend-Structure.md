
## Entry Points

| File | Purpose |
|---|---|
| `index.html` | SPA shell — loads Geist font, sets theme meta, mounts `#app` |
| `src/main.js` | Bootstrap — initializes theme, auth, TOTP gate, routing |
| `src/app.js` | Route registration, layout management, admin state |

---

## Routing

The app uses a custom hash-based SPA router (`src/core/router.js`). Routes are registered in `src/app.js` via `registerRoute()`.

### Route Configuration

| Route | Render Function | Protected | Admin | Layout |
|---|---|---|---|---|
| `home` | `renderHome` | No | No | user |
| `wallet` | `renderWallet` | Yes | No | user |
| `sell` | `renderSell` + `setupSellInteractions` | Yes | No | user |
| `deposit` | `renderDeposit` | Yes | No | user |
| `orders` | `renderOrders` | Yes | No | user |
| `profile` | `renderProfile` | No | No | user |
| `signin` | `renderSignIn` | No | No | user |
| `signup` | `renderSignUp` | No | No | user |
| `security` | `renderSecurity` | Yes | No | user |
| `notifications` | `renderNotifications` | Yes | No | user |
| `help-support` | `renderHelpSupport` | Yes | No | user |
| `live-chat` | `renderLiveChat` | Yes | No | user |
| `chat-history` | `renderChatHistory` | Yes | No | user |
| `my-tickets` | `renderMyTickets` | Yes | No | user |
| `create-ticket` | `renderCreateTicket` | Yes | No | user |
| `ticket-detail` | `renderTicketDetail` | Yes | No | user |
| `admin` | `renderAdminDashboard` | Yes | Yes | admin |
| `admin/deposits` | `renderAdminDeposits` | Yes | Yes | admin |
| `admin/sell-orders` | `renderAdminSellOrders` | Yes | Yes | admin |
| `admin/users` | Placeholder | Yes | Yes | admin |
| `admin/settings` | `renderAdminSettings` (tabbed) | Yes | Yes | admin |
| `admin/notifications` | `renderAdminNotifications` | Yes | Yes | admin |
| `admin/help-support` | `renderAdminHelpSupport` | Yes | Yes | admin |
| `admin/live-chat` | `renderAdminLiveChat` | Yes | Yes | admin |
| `admin/tickets` | `renderAdminTickets` | Yes | Yes | admin |

### Router Guards

- **Protected routes**: Redirect to `signin` if not authenticated
- **Admin routes**: Redirect to `home` if not admin; redirect to `security` if 2FA not enabled
- **Admin on home**: Admins are automatically redirected from `#home` to `#admin`

### Route Config Shape

```js
registerRoute('routeName', {
  render: () => HTMLElement | Promise<HTMLElement>,  // Returns DOM element (may be async)
  onMount: (container) => {},   // Optional post-render setup
  protected: true,              // Requires authentication
  admin: true,                  // Requires admin role + 2FA
  layout: 'admin',              // 'user' (default) or 'admin'
});
```

---

## Core Modules (`src/core/`)

### `auth.js`
- `signUpWithUsername()` / `signInWithUsername()` — username/password through a normalized synthetic Supabase Auth email
- `initAuth()` — waits for the initial Supabase auth event
- `currentUser` — application authentication state, separate from the underlying Supabase session
- `login2faPending` — blocks interactive login from populating `currentUser` before security handling completes
- `openAuthGate()` — checks server-side login assurance via `check_login_assurance` RPC, populates `currentUser` for restored bootstrap sessions
- `completeLogin2FA()` — completes interactive login after Authenticator/Passkey verification or mandatory setup; verifies assurance before populating `currentUser`
- `signOut()` — ends the Supabase session and resets application auth state
- `isAdmin()` — checks `is_admin_user` and caches the result
- `onAuthStateChange(callback)` — subscribes to application auth events
- `TOKEN_REFRESHED` handler re-verifies login assurance asynchronously on every token refresh (defense in depth); signs out if assurance is lost

### `router.js`
- `registerRoute(name, config)` — Register a route
- `navigate(routeName)` — Programmatic navigation with guards
- `initRouter()` — Start listening to `hashchange` events
- `getCurrentRoute()` — Get active route name
- `refreshCurrentPage()` — Re-render current page
- `onLayoutChange(handler)` — Register layout switch callback

### `theme.js`
- `initTheme()` — Apply saved or system preference theme
- `toggleTheme()` — Switch between light/dark
- `getTheme()` — Returns `'light'` or `'dark'`
- Persists preference in `localStorage` under key `xreserve-theme`

### `totp.js`
- `get2FAStatus()` — RPC call to `get_2fa_status`
- `begin2FAEnrollment()` — Edge Function `enroll-2fa`
- `confirm2FAEnrollment(code)` — Edge Function `verify-2fa-setup`
- `disable2FA(code)` — direct authenticator-code disable path
- `disable2FAWithVerification(verificationId, requiredScope)` — unified token-based disable path
- `verify2FACode(code, scope)` — Edge Function `verify-2fa`, returns scoped `verification_id`
- `renderQRCode(container, otpauthUri)` — client-side QR rendering via `qrcode`

### `passkey.js`
- Registration paths: signup, mandatory legacy setup, and existing-user enrollment
- Existing-user registration requires a `passkey_enrollment` verification token before WebAuthn begins
- Uses Supabase Auth two-step Passkey registration and authentication APIs
- Uses raw verification through `verify-passkey-action` for sensitive actions so the current session is not replaced
- Login Passkey authentication uses `signInWithPasskey()` followed by `establishPasskeyLoginAssurance()` which establishes login assurance for the new session
- **Cross-account protection**: Login captures the password-authenticated user's ID before the passkey ceremony and rejects the login if the post-ceremony session belongs to a different user (fail-closed)
- Lists, renames, and deletes Passkeys through `passkey-manage`
- `browserSupportsPasskeys()` gates Passkey UI by browser capability

### `smooth-scroll.js`
- `initLenis()` — Initialize Lenis smooth scrolling (respects `prefers-reduced-motion`)
- `getLenis()` — Access the Lenis instance

---

## Pages (`src/pages/`)

### `home.js` — Landing / Dashboard
- Hero section with exchange rate display — rate fetched asynchronously via `getPlatformRate()` (no hardcode)
- Market Pulse widget — live market reference rates (USDT/USD × USD/INR cross-rate) + XReserve rate
- Balance card (authenticated users only) — real balance from `getWalletBalance()`
- Recent activity feed — real transactions from `getTransactions()` (ledger_entries via RLS)
- Market cards grid
- CTAs: "Sell USDT" and "Deposit"
- Unauthenticated users see "Sign in to view your activity"

### `wallet.js` — Wallet & Transactions
- Available balance display — real USDT from `wallet_balances` table via `getWalletBalance()`
- Deposit and Sell action buttons (navigate to #deposit / #sell)
- Transaction history list — real ledger entries via `getTransactions()`
- Uses `TransactionItem` component for each transaction row
- Empty state: "No transactions yet" when no ledger entries exist

### `sell.js` — Sell USDT
- Amount input with quick-select chips (10, 50, 100, 500)
- MAX button to use full balance
- Live INR payout calculation using the platform rate from `getPlatformRate()` (rate stored in `data-rate`, no hardcode)
- Sticky bottom CTA bar
- Fresh `user_transaction` verification through the unified Authenticator/Passkey dialog before order creation

### `deposit.js` — Deposit Cryptocurrency (Multi-Screen Wizard)
- **Screen flow**: loading → no-2fa / no-method / networks → submit → confirming → success / pending
- **2FA gate**: the current page-level availability check uses Authenticator status; submission itself uses unified fresh verification
- **Networks screen**: shows available deposit methods from `get_active_deposit_methods` RPC; currently TRC20
- **Submit screen**: multi-field form with:
  - Declared amount input (numeric, validated > 0)
  - Transaction hash (TXID) input
  - Optional blockchain explorer URL (must be HTTPS)
  - 4 confirmation checkboxes: funds confirmed, correct network, TXID correct, amount correct
  - Submit requires 2FA verification (`user_transaction` scope) → calls `submit_deposit` RPC
  - After submit, triggers `request_blockchain_verification` RPC (non-fatal on failure)
- **Success screen**: deposit summary, informs user blockchain verification is in progress (~5 min)
- **Pending screen**: shows user's pending deposits from `get_user_pending_deposits` RPC
- **No-method screen**: shown when admin hasn't configured any active deposit method
- Calls: `get_active_deposit_methods`, `get_user_pending_deposits`, `submit_deposit`, `request_blockchain_verification`

### `orders.js` — Order History
- Filter tabs: All, Pending, Completed
- Real sell orders from `sell_orders` table (RLS-scoped to auth.uid())
- Order cards via `OrderCard` component with real status badges
- Empty state when no orders match the active filter
- No deposit data shown (orders are sell orders only)

### `profile.js` — User Profile & Settings
- User card (avatar, name, email) or "Not signed in" state
- Menu sections: Account, Preferences, Support
- Security link → `#security`
- Sign out button with loading state
- Version display (v1.1.0)

### `signup.js` — Registration
- Creates a username/password account through the synthetic Supabase Auth email mapping
- Validates username format and availability
- Requires immediate Authenticator or Passkey enrollment before setup completes
- Enrollment establishes login assurance for the new session
- Signup Passkey enrollment uses the age-limited `signup-authorize` server path
- Cancelling required security setup signs the new session out

### `signin.js` — Authentication
- Username/password form backed by Supabase Auth synthetic email identities
- Sets `login2faPending` before password authentication
- Detects enabled Authenticator and registered Passkeys
- Authenticator-only, Passkey-only, and factor-choice login flows
- **Passkey cross-account guard**: Both the passkey-only path and the 2FA choice dialog capture the password user's ID before `signInWithPasskey()` and verify it matches the resulting session user (fail-closed)
- Successful 2FA verification establishes server-side login assurance (session-bound)
- Security-state failures and cancelled login verification sign the user out
- Legacy zero-factor users enter mandatory, non-dismissible Authenticator or Passkey setup
- Calls `completeLogin2FA()` only after the selected security flow succeeds and assurance is confirmed

### `security.js` — Security Management
- Displays Authenticator and Passkey state independently
- Authenticator enrollment: generate secret → show QR → verify code → display recovery codes
- Existing-user Add Passkey: fresh `passkey_enrollment` verification → enrollment authorization → WebAuthn registration
- Passkey listing, cosmetic rename, and verification-protected deletion
- Authenticator disable uses unified fresh verification and 2FA invariant enforcement (Phase 28)
- Frontend conditionally disables Delete/Disable buttons when removal would violate the invariant (amber warning shown)
- Password change requires current-password reauthentication and fresh scoped verification

### `notifications.js` — User Notifications
- List of user notifications from `get_user_notifications` RPC (paginated)
- Notification types: deposit_submitted, deposit_credited, deposit_rejected, sell_order_created, sell_order_completed, sell_order_rejected
- Each notification shows title, description, timestamp, and read/unread status
- Mark individual notifications as read via `mark_notification_read` RPC
- Mark all as read via `mark_all_notifications_read` RPC
- Unread count badge in navigation header (from `get_unread_notification_count` RPC)
- Empty state when no notifications exist

### `help-support.js` — Help & Support Hub
- Live support availability display (calls `support_get_chat_availability` RPC)
- Shows agent availability status with live indicator (green/yellow/red)
- Estimated wait time display
- "Start Live Chat" / "Join Queue" / "No Agents Available" button based on availability
- If user has an active chat: shows "Return to Chat" button
- If user has a waiting chat: shows "View Queue Status" button
- Link to chat history
- Calls: `support_get_chat_availability`, `support_start_live_chat`, `support_get_user_active_chat`

### `live-chat.js` — Live Support Chat (User)
- Real-time chat interface with message bubbles
- Three views: queue (waiting), active chat, ended
- Queue view: shows position, polls for agent assignment every 5s
- Active chat: loads message history via `support_get_chat_history`, subscribes to Realtime
- Optimistic message sending (shows immediately, removes on error)
- Auto-scroll to latest messages
- "End Chat" button with confirmation dialog
- Realtime events via `xreserve:chat-message` and `xreserve:chat-status` custom events
- Marks messages as read via `support_mark_chat_read` on load and new message
- Calls: `support_start_live_chat`, `support_get_chat_history`, `support_send_chat_message`, `support_mark_chat_read`, `support_end_chat`, `support_get_user_queue_position`, `support_get_user_active_chat`

### `chat-history.js` — Chat History
- Lists user's past ended/abandoned chat sessions
- Each card shows date, duration, message count, status badge
- Click to open full-screen overlay with message conversation
- Loads messages via `support_get_chat_history`
- Calls: `support_get_user_chat_history`, `support_get_chat_history`

### `my-tickets.js` — My Tickets
- User ticket list with 6 filter tabs: All, Open, In Progress, Waiting, Resolved, Closed
- Each ticket card shows ticket_number, subject, category, status badge, priority, relative time, unread dot
- Calls `support_get_user_tickets` RPC with pagination
- Click navigates to `ticket-detail?id=<uuid>`

### `create-ticket.js` — Create Support Ticket
- Form with: Category (select), Subject (input), Description (textarea), Transaction Hash (optional)
- Contextual support via URL hash params: `#create-ticket?ctx=deposit&ref=<uuid>` or `?ctx=sell-order&ref=<uuid>`
- Auto-selects category based on context type
- Loads deposit/sell_order details to show reference info when context is provided
- Calls `support_create_ticket` RPC, navigates to ticket detail on success

### `ticket-detail.js` — Ticket Detail (User)
- Ticket header with number, status badge, subject, category, priority, dates
- Conversation messages (initial description + replies)
- Reply area with textarea and Send button (calls `support_reply_to_ticket`)
- "Reopen Ticket" button for RESOLVED tickets (calls `support_reopen_ticket`)
- Marks messages read via `support_mark_ticket_read`
- Calls `support_get_user_ticket` RPC

---

## Admin Pages (`src/admin/`)

### `dashboard.js` — Admin Overview
- USDT/INR exchange rate card with **Change Exchange Rate** button → opens `ChangeRateDialog`
- Stats grid: Pending Deposits, Pending Orders, Total Users, Credited Deposits, Completed Sells
- Calls `admin_dashboard_stats` RPC; refreshes after a successful rate update

### `deposits.js` — Deposit Management (3-Stage Verification)
- Filter tabs: All, Pending Verification, Awaiting Manual Review, Pending, Under Review, Credited, Rejected
- Deposit cards with user email, declared/verified amounts, network, TXID, status
- **Detail modal with 3-stage verification progress indicator**:
  1. **Blockchain Verification** — auto-verified via TronGrid; shows from-address, block, confirmations, Tronscan link; displays amount differences if declared ≠ verified
  2. **Manual Admin Verification** — 8-item checklist (TXID correct, TRC20 network, token is USDT, sender verified, recipient matches, amount correct, finality sufficient, wallet info reviewed) + optional notes; requires `admin_financial` 2FA verification
  3. **Financial Authorization** — credit wallet button with `admin_financial` 2FA challenge; credits `verified_amount`
- Reject button available for any non-credited/non-rejected deposit (requires `admin_financial` 2FA)
- Calls: `admin_list_deposits`, `get_deposit_verification_details`, `admin_manually_verify_deposit`, `admin_update_deposit_status`, `admin_credit_deposit`

### `deposit-methods.js` — Deposit Method Configuration
- Manage active deposit addresses per network (TRC20, BEP20)
- Add/edit deposit address for each network (one active per network)
- QR code generation for deposit addresses
- Toggle active/inactive per network
- All changes require `admin_settings` 2FA verification
- Calls: `admin_list_deposit_methods`, `admin_set_deposit_method`, `admin_toggle_deposit_method`
- Embedded as "Deposit Methods" tab in Admin Settings page

### `sell-orders.js` — Sell Order Management
- Filter tabs: All, Payment Pending, Completed, Rejected, Cancelled, Manual Review
- Order cards with user email, USDT/INR amounts, rate, bank details
- Detail modal with actions: Complete Order, Reject Order, Cancel Order
- All actions require fresh unified verification (`admin_financial` scope)
- Calls: `admin_list_sell_orders`, `admin_complete_sell_order`, `admin_reject_sell_order`

### `security.js` — Admin Security Management
- Mirrors user Authenticator and Passkey management
- Add Passkey uses the dedicated `passkey_enrollment` scope
- Passkey deletion and Authenticator disable use `admin_financial` verification
- 2FA invariant (`active_2fa_methods >= 1`) enforced server-side via advisory lock and factor-removal receipts (Phase 28)
- Frontend conditionally disables Delete/Disable buttons when removal would violate the invariant (amber warning shown)
- Password changes require current-password reauthentication and `admin_financial` verification

### `notifications-page.js` — Admin Notifications
- List of admin notifications from `get_user_notifications` RPC (paginated)
- Notification types: new_user_signup, new_deposit, deposit_credited, deposit_rejected, new_sell_order, sell_order_completed, sell_order_rejected
- Each notification shows title, description, timestamp, and read/unread status
- Mark individual notifications as read via `mark_notification_read` RPC
- Mark all as read via `mark_all_notifications_read` RPC
- Unread count badge in admin navigation (from `get_unread_notification_count` RPC)
- Empty state when no notifications exist

### `live-chat.js` — Admin Live Chat Center
- Agent status control (AVAILABLE / BUSY / OFFLINE dropdown)
- Heartbeat management: starts 60s heartbeat when AVAILABLE/BUSY, stops when OFFLINE
- Dashboard view: stats grid (active, waiting, available agents), waiting chats list, active chats list
- Accept button on waiting chats (FIFO via `support_accept_chat`)
- Conversation view: full chat interface with message history, realtime message delivery, send/reply
- Realtime subscriptions for new messages (INSERT on `support_chat_messages`) and session status (UPDATE on `support_chat_sessions`)
- End chat with confirmation dialog
- Periodic dashboard refresh (8s interval)
- Calls: `support_get_agent_status`, `support_set_agent_status`, `support_agent_heartbeat`, `support_admin_get_chat_stats`, `support_admin_get_waiting_chats`, `support_admin_get_active_chats`, `support_accept_chat`, `support_get_chat_history`, `support_send_chat_message`, `support_mark_chat_read`, `support_end_chat`

### `tickets.js` — Admin Support Ticket Center
- Dashboard view: 7 stat cards (Open, In Progress, Waiting User, Waiting Support, Resolved, Closed, Unassigned)
- Filters: status, category, priority, sort (updated/newest/oldest/priority), search input with debounce
- Ticket list rows show: ticket_number, username, status badge, priority, subject, category, time
- Detail view: ticket info card with admin controls (status select, priority select, assign button, save changes)
- Conversation display with sender names and timestamps
- Admin reply textarea (calls `support_admin_reply_to_ticket`)
- Internal notes section (yellow-tinted cards, "admin only" label) — calls `support_admin_add_note`
- Auto-refresh every 10 seconds on dashboard view
- MutationObserver for cleanup of refresh timer
- Calls: `support_admin_get_tickets`, `support_admin_get_ticket`, `support_admin_assign_ticket`, `support_admin_reply_to_ticket`, `support_admin_add_note`, `support_admin_update_ticket_status`, `support_admin_update_ticket_priority`, `support_admin_get_ticket_stats`, `support_admin_mark_ticket_read`

---

## Data Modules (`src/data/`)

### `wallet-data.js` — Shared Wallet Data
- `getWalletBalance()` — Fetches `{ available, reserved }` from `wallet_balances` table (RLS-scoped via `wallets.user_id = auth.uid()`)
- `getTransactions(limit)` — Fetches ledger entries from `ledger_entries` table, filtered by `reference_type IN ('deposit', 'sell_order')`, ordered by `created_at DESC`
- `mapLedgerToTransaction(entry)` — Maps CREDIT+deposit → deposit type, RESERVE+sell_order → sell type; returns TransactionItem-compatible objects
- Used by: `wallet.js`, `home.js`, `navigation.js` (header balance)

### `market-data.js` — Market Rates Data
- `getMarketRates()` — Calls the `market-rates` Edge Function; returns normalized exchange rates + `xreserveRate`
- Rate limiting/cache guard to avoid excessive Edge Function calls
- Used by: `platform-rate.js`, `MarketPulse.js`

### `platform-rate.js` — Authoritative Platform Rate
- `getPlatformRate()` — Single read-only access point for the XReserve USDT/INR rate; returns `{ rate, authoritative }`
- Production path: `exchange_settings.platform_usdt_inr_rate` → `market-rates` Edge Function (server-side read) → `xreserveRate`
- `DEV_FALLBACK_RATE` — used only when the Edge Function is not deployed (local dev); never a write path
- Used by: `home.js`, `sell.js`, `MarketPulse.js`
- The rate is only ever WRITTEN through the `admin_update_exchange_rate` RPC (admin + `admin_settings` 2FA)

---

## Components (`src/components/`)

| Component | File | Description |
|---|---|---|
| `StatusBadge` | `StatusBadge.js` | Colored badge for order/deposit statuses (includes PENDING_VERIFICATION variants) |
| `OrderCard` | `OrderCard.js` | Sell order summary card with status |
| `TransactionItem` | `TransactionItem.js` | Transaction row with icon, amount, status |
| `TotpDialog` | `TotpDialog.js` | Unified fresh-verification modal; detects available Authenticator/Passkey methods and returns a scoped `verification_id` |
| `ConfirmDialog` | `admin/ConfirmDialog.js` | Generic confirmation dialog for admin actions |
| `ChangeRateDialog` | `admin/ChangeRateDialog.js` | Multi-step exchange rate change flow: input → review → `admin_settings` 2FA → final confirm → `admin_update_exchange_rate` RPC → success |
| `MarketPulse` | `MarketPulse.js` | Live USDT/INR market reference widget (labeled "Market reference") with XReserve rate + info tooltip. Each exchange row shows a brand logo (Binance yellow diamond, OKX four squares, Bybit stylized B) followed by the exchange name in semibold weight |
| Navigation | `navigation.js` | Bottom nav, top bar, desktop sidebar |

### Shared Libraries (`src/lib/`)

| Module | File | Description |
|---|---|---|
| Chat | `chat.js` | Live chat state management, floating chat icon, Realtime subscriptions, active chat polling (20s interval), unread badge, visibility-aware focus tracking |
| Supabase | `supabase.js` | Supabase client initialization with persisted, auto-refreshed sessions |
| Passkey | `core/passkey.js` | WebAuthn registration, login, action verification, listing, rename, and deletion |

### Navigation System
- **Bottom nav** — Mobile-only fixed bar (4 items: Home, Wallet, Sell, Orders)
  - Wallet icon: clean wallet shape with body, fold line, and button clasp
- **Top bar** — Logo, wallet balance control (authenticated only), theme toggle, profile link, notification bell (with unread count badge)
  - Wallet balance control: Tether icon + real USDT balance + chevron
  - Balance fetched asynchronously via `getWalletBalance()` on layout creation
  - Always visible on mobile (compact sizing: 12px balance text, 20px icon)
  - Hidden for unauthenticated users (profile links to #signin instead)
- **Desktop sidebar** — 240px fixed sidebar with full navigation + theme toggle
- **Floating surfaces** — Bottom nav and wallet balance control use semi-opaque surfaces (90% opacity) + `backdrop-blur-xl`, remaining legible over the ambient background
- Admin nav items: Dashboard, Deposits, Orders, Users, Settings

---

## Layouts (`src/layouts/`)

### `admin.js` — Admin Layout
- Sticky header with "XReserve Admin" branding
- Horizontal tab navigation (scrollable on mobile)
- Theme toggle in header
- `createAdminLayout()` — Build the admin shell
- `updateAdminNav()` — Highlight active tab

---

## Styling

### Design System (`tailwind.config.js`)
- **Font**: Geist (300–700 weights)
- **Dark mode**: Class-based (`dark` class on `<html>`)
- **Colors**: Custom semantic tokens
  - `surface` (light: `#FFFFFF`, dark: `#161616`)
  - `background` (light: `#F5F5F7`, dark: `#000000`)
  - `text-primary` / `text-secondary` with dark variants
  - `action` (light: `#000000`, dark: `#FFFFFF`)
  - `border` (semi-transparent rgba) — four tiers: `light` (6% black), `light-strong` (14% black), `dark` (8% white), `dark-strong` (22% white)
- **Shadows**: `card`, `elevated` with dark variants
- **Animations**: `fade-up`, `fade-in`, `scale-in`

### Component Classes (`src/styles/app.css`)
- `.btn-primary` / `.btn-secondary` — Button variants with press animations. `.btn-secondary` uses a **solid opaque surface + visible border in both themes** (border `light-strong`/`dark-strong`) so secondary actions never read as ghost/transparent
- `.btn-danger` / `.btn-success` — Destructive and success button variants
- `.card` / `.card-interactive` — Opaque surface containers with hover shadows; dialogs (TotpDialog, ConfirmDialog) build on `.card` so they fully occlude the ambient background
- `.input-field` — Form inputs with **solid opaque backgrounds** (`surface-light` / `surface-dark`) so the ambient background never bleeds through; focus states, error/success variants
- `.tab-active` / `.tab-inactive` — Filter pills; `.tab-inactive` uses solid chip backgrounds (`#ECECEF` light, `#161616` dark) with hover states
- `.page-title` / `.display` / `.text-muted` / `.section-heading` / `.label` — Typography
- `.divider` — 1px separator line
- `.badge` / `.badge-neutral` — Small status/count badges
- `.nav-badge` — Red unread-count badge for navigation items (absolutely positioned on bottom-nav icons)
- `.sticky-action-bar` — Fixed bottom bar (sell page CTA)
- `.auth-spinner` — Loading spinner
- `.page-enter` / `.step-enter` — Page and step transition animations
- `.stagger > *` — Staggered children animation (50ms delay increments)
- `.scrollbar-hide` — Hide scrollbar utility

### Ambient Background (`body::before` / `body::after`)
Exchange-style ambient background rendered entirely in CSS — zero JS, zero DOM elements, both layers `position: fixed; z-index: -1; pointer-events: none` with a bottom-fade mask:
- **`body::before`** — Layered CSS gradients: square grid at **44px** (fine) and **220px** (structural) cell sizes, radial intersection dots, and two soft radial glow washes. Dark variant swaps to white/emerald tints
- **`body::after`** — Single URL-encoded inline SVG (1440×900, `background-size: cover`) animated with SMIL (auto-pauses in background tabs):
  - 15 strictly **orthogonal** (horizontal/vertical only) connection paths snapped to the 44px grid — no diagonals
  - 20 static node dots at grid intersections + 3 "breathing" emerald active nodes
  - **20 moving data pulses** travelling along grid-aligned routes (15–36s durations, staggered negative `begin` offsets, fade in/out at route ends)
  - 3 organic market-graph polylines with travelling `stroke-dashoffset` highlight segments
- **Theme adaptation** — Both themes share identical geometry and timing; `.dark body::after` swaps the palette (white/gray geometry) and upgrades moving-node glow to a 3-layer stack (diffusion r=7 + halo r=3.5 + crisp `#34d399` core r=1.5). Light mode stays soft/restrained
- **Layering/isolation** — Ambient layers sit below all content; bleed-through is prevented by opaque surfaces on shared classes (`.card`, `.input-field`, `.btn-secondary`, `.tab-inactive`), not by hiding the animation

### Responsive Breakpoints
- Mobile-first design
- `md:` (768px) — Desktop sidebar appears, layout shifts
- `lg:` (1024px) — Wider content padding, grid adjustments
