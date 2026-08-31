# XReserve — Project Wiki

**XReserve** is a USDT-to-INR exchange platform built as a single-page application (SPA) with a Supabase backend. Users authenticate with a username and password backed by a synthetic Supabase Auth email identity, then complete mandatory two-factor authentication using an authenticator code or Passkey. The platform supports USDT deposits, INR sell orders, wallet management, support, and server-authorized security enrollment.

---

## Quick Links

| Document | Description |
|---|---|
| [Architecture](Architecture.md) | High-level system design, tech stack, and data flow |
| [Frontend Structure](Frontend-Structure.md) | Pages, components, routing, layouts, and styling |
| [Database Schema](Database-Schema.md) | Tables, migrations, RLS policies, and RPC functions |
| [Edge Functions](Edge-Functions.md) | Supabase Edge Functions for Authenticator, Passkey, blockchain, and market operations |
| [Security Model](Security-Model.md) | Authentication, verification scopes, Passkey enrollment, RLS, and RPC security |
| [Setup Guide](Setup-Guide.md) | How to install, configure, and run the project |

---

## Project Name

**xreserve** — v1.3.0

## Tagline

> Sell Crypto. Get INR.

## Description

XReserve is an offline-operated USDT-to-INR exchange. Administrators manually review and process deposits and sell orders. The platform handles:

- **User wallet management** — deposit USDT, view balances, track transactions
- **Blockchain-verified deposits** — users submit deposit claims with TXID; system verifies on-chain via TronGrid API before crediting
- **Sell orders** — convert USDT to INR at a platform-set exchange rate
- **Admin operations** — review deposits, credit wallets, complete/reject sell orders, manage deposit methods
- **Two-factor authentication** — mandatory authenticator or Passkey protection, fresh operation-scoped verification, recovery codes, and last-factor safeguards
- **Live support chat** — real-time in-app chat between users and admin agents (Supabase Realtime, heartbeat-based availability, FIFO queue)
- **Support tickets** — asynchronous ticket-based support with categories, priorities, internal notes, and assignment tracking (separate from live chat)
- **Notifications** — real-time user and admin notifications wired into financial events (deposits, sell orders, signups), chat events (assigned, message, ended), and ticket events (created, replied, status changed, resolved, closed)
- **Audit logging** — every financial action is recorded

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JavaScript (ES Modules), Vite, Tailwind CSS |
| Backend / Database | Supabase (PostgreSQL, Auth, WebAuthn/Passkeys, Edge Functions, RPC) |
| Authentication | Username/password mapped to synthetic Supabase Auth email identities |
| 2FA | Authenticator TOTP and Passkeys/WebAuthn; server-issued verification tokens |
| Blockchain Verification | TronGrid API (USDT TRC20 contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`) |
| Styling | Tailwind CSS 3 with custom design tokens, Geist font |
| Smooth Scrolling | Lenis |
| QR Codes | `qrcode` library |
| Build Tool | Vite 6 |

## Key Design Decisions

1. **No frontend framework** — The UI is built with vanilla JS DOM manipulation. No React, Vue, or Angular.
2. **Hash-based routing** — Custom SPA router using `window.location.hash`.
3. **Admin-operated exchange** — All financial operations (credit deposits, complete sells) require manual admin action with 2FA verification.
4. **Server-side business logic** — All wallet mutations happen via PostgreSQL RPC functions (`SECURITY DEFINER`), never from the client.
5. **Edge Functions for security operations** — TOTP generation/verification and Passkey management run server-side; secrets and service-role credentials never enter browser code.
6. **Operation-scoped verification tokens** — Each successful TOTP or Passkey action verification produces a five-minute, single-use token with a strict scope such as `user_transaction`, `admin_financial`, `admin_settings`, or `passkey_enrollment`.
7. **Server-authorized Passkey enrollment** — Existing users must complete fresh verification before a short-lived enrollment authorization permits insertion into `auth.webauthn_credentials`; legacy zero-factor users use a restricted mandatory setup path.
8. **Blockchain-verified deposits** — User-declared amounts are declarative only. The actual credited amount is determined by on-chain verification via TronGrid API. Admins perform a manual verification checklist before crediting.
9. **Admin-configurable deposit methods** — Deposit addresses are managed via the `deposit_methods` table, not hardcoded. Admins can activate/deactivate networks (TRC20, BEP20) dynamically.
10. **Realtime live chat** — Users and admin agents communicate via Supabase Realtime channels. Agent availability is managed with heartbeat-based presence detection (3-minute stale threshold). FIFO queue ensures fair ordering.
11. **Heartbeat-based agent presence** — Admin agents must maintain a 60-second heartbeat. Agents with no heartbeat for >3 minutes are excluded from availability calculations and cannot receive new chat assignments.
12. **Separate live chat and support tickets** — Live chat and support tickets are independent systems. Live chat represents real-time sessions; tickets provide asynchronous conversations, status tracking, assignment, priorities, and internal admin notes.

## Repository Structure

```
/
├── index.html                 # SPA entry point
├── src/
│   ├── main.js                # Application bootstrap
│   ├── app.js                 # Route registration, layout management
│   ├── core/                  # Auth, router, theme, TOTP, Passkeys, smooth scroll, username
│   ├── lib/                   # Supabase client
│   ├── data/                  # Shared data modules (wallet balance, transactions)
│   ├── pages/                 # User-facing page renderers
│   ├── admin/                 # Admin panel page renderers
│   ├── components/            # Reusable UI components
│   ├── layouts/               # Admin layout
│   └── styles/                # Global CSS (Tailwind)
├── supabase/
│   ├── functions/             # Edge Functions (Deno)
│   │   ├── _shared/           # Shared utilities (common.ts)
│   │   ├── enroll-2fa/
│   │   ├── verify-2fa/
│   │   ├── verify-2fa-setup/
│   │   ├── disable-2fa/
│   │   ├── passkey-manage/
│   │   ├── verify-passkey-action/
│   │   ├── verify-trc20-deposit/  # Blockchain verification via TronGrid
│   │   └── market-rates/      # Aggregates Binance/OKX/Bybit + CoinGecko rates
│   └── migrations/            # Sequential SQL migrations through 036
├── wiki/                      # Project documentation
├── template/                  # UI template/reference (not used at runtime)
├── package.json
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
```
