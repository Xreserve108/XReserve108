
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
| `admin` | `renderAdminDashboard` | Yes | Yes | admin |
| `admin/deposits` | `renderAdminDeposits` | Yes | Yes | admin |
| `admin/sell-orders` | `renderAdminSellOrders` | Yes | Yes | admin |
| `admin/users` | Placeholder | Yes | Yes | admin |
| `admin/settings` | `renderAdminSettings` (tabbed) | Yes | Yes | admin |
| `admin/notifications` | `renderAdminNotifications` | Yes | Yes | admin |

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
- `initAuth()` — Resolves initial session from Supabase
- `signInWithGoogle()` — Google OAuth via Supabase
- `signOut()` — End session
- `getUser()` / `isAuthenticated()` — Current user state
- `isAdmin()` — Checks `admin_users` table via `is_admin_user` RPC (cached)
- `onAuthStateChange(callback)` — Subscribe to auth events

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
- `disable2FA(code)` — Edge Function `disable-2fa`
- `verify2FACode(code, scope)` — Edge Function `verify-2fa`, returns `verification_id`
- `renderQRCode(container, otpauthUri)` — Client-side QR rendering via `qrcode` library

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
- TOTP verification required before order creation

### `deposit.js` — Deposit Cryptocurrency (Multi-Screen Wizard)
- **Screen flow**: loading → no-2fa / no-method / networks → submit → confirming → success / pending
- **2FA gate**: requires 2FA enabled before depositing; loads active deposit methods and pending deposits
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

### `signin.js` — Authentication
- Google OAuth button with loading state
- Error display for OAuth failures
- Handles OAuth return redirect with error params
- Auto-redirect if already authenticated

### `security.js` — 2FA Management
- Shows enabled/disabled 2FA state
- Enrollment flow: generate secret → show QR → verify code → display recovery codes
- Disable flow: enter TOTP code to confirm
- Uses Edge Functions for all TOTP operations

### `notifications.js` — User Notifications
- List of user notifications from `get_user_notifications` RPC (paginated)
- Notification types: deposit_submitted, deposit_credited, deposit_rejected, sell_order_created, sell_order_completed, sell_order_rejected
- Each notification shows title, description, timestamp, and read/unread status
- Mark individual notifications as read via `mark_notification_read` RPC
- Mark all as read via `mark_all_notifications_read` RPC
- Unread count badge in navigation header (from `get_unread_notification_count` RPC)
- Empty state when no notifications exist

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
  2. **Manual Admin Verification** — 8-item checklist (TXID correct, TRC20 network, token is USDT, sender verified, recipient matches, amount correct, finality sufficient, wallet info reviewed) + optional notes; no 2FA required (logged confirmation only)
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
- All actions require TOTP verification (`admin_financial` scope)
- Calls: `admin_list_sell_orders`, `admin_complete_sell_order`, `admin_reject_sell_order`

### `security.js` — Admin 2FA Management
- Same enrollment/disable flow as user security page
- Scoped to admin context

### `notifications-page.js` — Admin Notifications
- List of admin notifications from `get_user_notifications` RPC (paginated)
- Notification types: new_user_signup, new_deposit, deposit_credited, deposit_rejected, new_sell_order, sell_order_completed, sell_order_rejected
- Each notification shows title, description, timestamp, and read/unread status
- Mark individual notifications as read via `mark_notification_read` RPC
- Mark all as read via `mark_all_notifications_read` RPC
- Unread count badge in admin navigation (from `get_unread_notification_count` RPC)
- Empty state when no notifications exist

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
| `TotpDialog` | `TotpDialog.js` | Modal for TOTP verification (returns Promise with `verification_id`) |
| `ConfirmDialog` | `admin/ConfirmDialog.js` | Generic confirmation dialog for admin actions |
| `ChangeRateDialog` | `admin/ChangeRateDialog.js` | Multi-step exchange rate change flow: input → review → `admin_settings` 2FA → final confirm → `admin_update_exchange_rate` RPC → success |
| `MarketPulse` | `MarketPulse.js` | Live USDT/INR market reference widget (labeled "Market reference") with XReserve rate + info tooltip. Each exchange row shows a brand logo (Binance yellow diamond, OKX four squares, Bybit stylized B) followed by the exchange name in semibold weight |
| Navigation | `navigation.js` | Bottom nav, top bar, desktop sidebar |

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
