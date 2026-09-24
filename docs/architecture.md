# SupportMe Architecture

SupportMe is a Stellar/Soroban-based creator donation platform with three
layers: on-chain smart contracts that settle and record donations, a
Node/Express backend that owns off-chain profile data and streams real-time
updates, and a Next.js frontend that ties wallets, contracts, and the API
together.

## Architecture Overview

- **Smart Contracts**: `contracts/`
  - `donation` and `creator-registry` are two independently deployed Soroban
    contracts on Stellar Testnet that talk to each other exclusively through
    cross-contract calls (`env.invoke_contract`).
  - `donation` moves XLM from donor to creator via the native Stellar Asset
    Contract, keeps an append-only on-chain donation log, and reports every
    settled donation to `creator-registry`.
  - `creator-registry` owns creator profile state (username, lifetime
    totals) and only accepts `record_donation` calls from the `donation`
    contract address it was initialized with.
  - Both contracts have unit test coverage (`cargo test --workspace`) using
    `soroban-sdk`'s `testutils`, including cross-contract integration tests
    that register a real `creator-registry` instance in a shared test `Env`.

- **Frontend**: `frontend/`
  - Next.js (App Router) app for the landing page, creator profile pages,
    the donation flow, and the creator dashboard/settings.
  - Connects wallets (Freighter, xBull, Albedo, Rabet, Lobstr) via Stellar
    Wallets Kit, and calls the `donation` contract directly
    (`lib/contract.js`: simulate → sign → submit → poll for confirmation).
  - Supports multiple donation assets (XLM + USDC) via a client-side asset
    registry (`lib/assets.js`) that resolves each asset's Stellar Asset
    Contract id for the `donation` contract's generic `token` parameter — no
    contract change required.
  - Integrates a Stellar **anchor** for fiat cash-out (`lib/anchor.js`): the
    full SEP-24 interactive withdraw flow (SEP-10 auth → `/info` → interactive
    popup → status polling → on-chain payment to the anchor), wired into
    `/settings`. Defaults to the SDF reference anchor on testnet.
  - Subscribes to the backend's SSE stream (`EventSource`) on the dashboard
    and public profile pages so new donations appear live without polling.
  - Tested with Vitest + React Testing Library (components, `AuthContext`,
    and the dashboard page's data/SSE behavior).

- **Backend**: `backend/`
  - Node.js + Express API, Prisma ORM, PostgreSQL.
  - Owns everything the contracts don't: user accounts, creator profiles,
    wallet-signature-based auth (JWT), and a denormalized donation history
    used for dashboard queries/stats.
  - Polls the Soroban RPC for `donation` contract events
    (`services/sorobanEventListener.ts`) through a failover endpoint pool,
    idempotently indexes each event by its on-chain identity, and republishes
    it on an in-process event bus, which `routes/events.ts` streams to
    connected clients over Server-Sent Events. Browser-reported rows are
    provisional until the listener verifies the corresponding event.
  - All backend Soroban reads (health, event polling, and subscription
    execution) share `services/sorobanRpc.ts`, which supports
    `SOROBAN_RPC_URLS` and logs the endpoint that served each request.
  - Privileged admin access and state-changing admin actions are recorded in
    the append-only `AdminAuditLog` table and exposed at
    `/api/admin/audit-logs`.
  - Centralized error handling (`errors/`, `middleware/errorHandler.ts`) and
    Zod-based request validation (`middleware/validate.ts`, `schemas/`).
  - Tested with Jest + Supertest; Prisma is mocked in tests so the suite
    never touches a real database.

- **Database**: PostgreSQL
  - Stores `User`, `Creator`, `Donation`, and `AdminAuditLog` records (see
    README for the schema). Compatible with any PostgreSQL-compatible host
    (the deployed instance runs on Railway).

- **CI**: `.github/workflows/ci.yml`
  - Three independent GitHub Actions jobs run on every push/PR to `main`:
    contracts (`cargo test` + a release `wasm32v1-none` build), backend
    (`tsc`/Prisma generate + `jest`), and frontend (`tsc` + `vitest` +
    `next build`).

## Flow Diagram

```mermaid
flowchart TD
  A[Supporter Browser] -->|opens creator page| B[Frontend Next.js]
  B -->|loads creator profile| C[Backend API]
  B -->|connects wallet| D[Stellar Wallets Kit]
  D -->|simulate/sign/submit donate| E[donation contract]
  E -->|cross-contract record_donation| G[creator-registry contract]
  E -->|emits DonatedEvent| H[Stellar Testnet RPC]
  B -->|reports donation metadata| C
  C -->|writes donation record| F[(PostgreSQL)]
  C -->|reads creator/donation data| F
  H -->|polled by| I[SorobanEventListener]
  I -->|publishes to| J[In-process event bus]
  J -->|streams| K[SSE /api/events]
  K -->|EventSource| B
  B -->|displays live dashboard/profile| A
```

## Key Responsibilities

- **Contracts**
  - Settle donations atomically and trustlessly on-chain (no custody by the
    backend).
  - Keep the source of truth for lifetime creator totals via
    `creator-registry`, independent of the off-chain database.

- **Frontend**
  - Manage wallet sessions, build/sign/submit the `donate` contract
    invocation, and show live transaction status.
  - Send donation metadata to the backend after a successful on-chain
    transfer, and subscribe to SSE for real-time updates from other
    supporters.
  - Provide skeleton loading states and a root error boundary
    (`app/error.tsx`) for a resilient UX while data is loading or a render
    fails unexpectedly.

- **Backend**
  - Authenticate users via a signed wallet challenge (no passwords) and
    issue JWTs.
  - Store creator profile data and donation history for fast dashboard
    queries (avoiding a full-ledger scan for every page load).
  - Bridge on-chain activity to connected clients in real time via the
    Soroban event listener + SSE endpoint.
  - Validate all mutating requests with Zod schemas and return consistent
    error shapes via centralized error-handling middleware.

## Anchor / Fiat Flow (SEP-24 deposit & withdraw)

```mermaid
flowchart TD
  A[Creator on /settings] -->|Add Funds / Cash Out| B[lib/anchor.js]
  B -->|SEP-1: read stellar.toml| C[Anchor home domain]
  B -->|SEP-10: sign challenge| D[Wallet]
  B -->|POST deposit or withdraw /interactive| E[Anchor transfer server]
  E -->|hosted URL| F[Interactive popup: KYC + amount / bank details]
  B -->|poll GET /transaction| E
  B -->|withdraw: sign + submit payment to anchor| G[Stellar Testnet]
  B -->|deposit: sign changeTrust on pending_trust| G
  E -->|withdraw payout| H[Creator's bank account]
  E -->|deposit: credit asset to wallet| G
```

On testnet this points at the SDF reference anchor (`testanchor.stellar.org`,
asset `SRT`) — no signup, cost, or partnership. The same code targets a real
NGN anchor on mainnet by changing `NEXT_PUBLIC_ANCHOR_*` env vars.

Both SEP-24 legs are implemented in `lib/anchor.js`: **withdraw** (`runWithdraw`,
signs an on-chain payment to the anchor) and **deposit** (`runDeposit`, adds a
trustline when the anchor parks at `pending_trust`, then lets the anchor credit
the asset). Path-payment auto-settlement (tip in one asset → payout in another)
remains out of scope.

**Auth limitation:** only SEP-10 is implemented, which covers classic (`G...`)
and muxed (`M...`) accounts. Contract accounts (`C...`, smart wallets) would
require SEP-45 (Soroban authorization entries verified via RPC), which is not
implemented — sufficient for the Freighter `G...` account used on testnet.

## Contribution Focus Areas

- Add pagination and filtering for dashboards and donation history
- Add integration/e2e tests that exercise the full donate flow against a
  local Stellar network (e.g. `stellar-cli`'s local sandbox)
- Add a Railway/production deploy step to the CI workflow, gated on the
  existing test jobs
- Add SEP-24 **deposit** (fan fiat on-ramp) and path-payment settlement so a
  tip in one asset lands in the creator's preferred payout asset
- Add embeddable donation widgets for creators to use on other sites
