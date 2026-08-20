# XReserve — Project Wiki

**XReserve** is a USDT-to-INR exchange platform built as a single-page application (SPA) with a Supabase backend. It allows users to deposit cryptocurrency (USDT via TRC20), sell USDT for Indian Rupees, and manage their wallet — all secured by mandatory TOTP-based two-factor authentication and blockchain-verified deposit submissions.

---

## Quick Links

| Document | Description |
|---|---|
| [Architecture](Architecture.md) | High-level system design, tech stack, and data flow |
| [Frontend Structure](Frontend-Structure.md) | Pages, components, routing, layouts, and styling |
| [Database Schema](Database-Schema.md) | Tables, migrations, RLS policies, and RPC functions |
| [Edge Functions](Edge-Functions.md) | Supabase Edge Functions for 2FA and blockchain verification |
| [Security Model](Security-Model.md) | Authentication, 2FA enforcement, RLS, and RPC security |
| [Setup Guide](Setup-Guide.md) | How to install, configure, and run the project |

---

## Project Name

**xreserve** — v0.1.0

## Tagline

> Sell Crypto. Get INR.

## Description

XReserve is an offline-operated USDT-to-INR exchange. Administrators manually review and process deposits and sell orders. The platform handles:

- **User wallet management** — deposit USDT, view balances, track transactions
- **Blockchain-verified deposits** — users submit deposit claims with TXID; system verifies on-chain via TronGrid API before crediting
- **Sell orders** — convert USDT to INR at a platform-set exchange rate
- **Admin operations** — review deposits, credit wallets, complete/reject sell orders, manage deposit methods
- **Two-factor authentication** — mandatory TOTP (authenticator app) for all sensitive operations
- **Notifications** — real-time user and admin notifications wired into financial events (deposits, sell orders, signups), created atomically in the same transaction as the financial operation
- **Audit logging** — every financial action is recorded

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JavaScript (ES Modules), Vite, Tailwind CSS |
| Backend / Database | Supabase (PostgreSQL, Auth, Edge Functions, RPC) |
| 2FA / TOTP | Supabase Edge Functions (Deno) + `otplib` |
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
5. **Edge Functions for TOTP** — TOTP secret generation and verification run in Supabase Edge Functions (Deno), never in the browser or database.
6. **Operation-scoped 2FA tokens** — Each TOTP verification produces a single-use token with an operation scope (e.g., `user_transaction`, `admin_financial`).
7. **Blockchain-verified deposits** — User-declared amounts are declarative only. The actual credited amount is determined by on-chain verification via TronGrid API. Admins perform a manual verification checklist before crediting.
8. **Admin-configurable deposit methods** — Deposit addresses are managed via the `deposit_methods` table, not hardcoded. Admins can activate/deactivate networks (TRC20, BEP20) dynamically.

## Repository Structure

```
/
├── index.html                 # SPA entry point
├── src/
│   ├── main.js                # Application bootstrap
│   ├── app.js                 # Route registration, layout management
│   ├── core/                  # Auth, router, theme, TOTP, smooth scroll, username
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
│   │   ├── verify-trc20-deposit/  # Blockchain verification via TronGrid
│   │   └── market-rates/      # Aggregates Binance/OKX/Bybit + CoinGecko rates
│   └── migrations/            # SQL migrations (20 files, Phases 3–20)
├── wiki/                      # Project documentation
├── template/                  # UI template/reference (not used at runtime)
├── package.json
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
```
