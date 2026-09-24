# SupportMe Backend

This backend is a lightweight API layer for the SupportMe application.
It is built with TypeScript, Express, and Prisma, and is designed to support creator profiles, donations, and backend-driven dashboards.

## Features

- REST API for creators and donations
- PostgreSQL-compatible Prisma schema
- Local development server with hot reload
- Clear extension points for contributors

## Getting Started

1. Install dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Create a `.env` from the example:
   ```bash
   cp .env.example .env
   ```

3. Set your database URL in `.env`.

4. Generate Prisma client:
   ```bash
   npm run prisma:generate
   ```

5. Run the backend in development mode:
   ```bash
   npm run dev
   ```

6. Visit the health check:
   ```bash
   http://localhost:4000/health
   ```

## API Endpoints

- `GET /health`
- `GET /api/creators`
- `POST /api/creators`
- `GET /api/creators/:username`
- `PUT /api/creators/:username`
- `GET /api/donations?creatorUsername={username}&page=1&limit=20`
- `POST /api/donations` (requires an `Idempotency-Key` header)
- `GET /api/admin/overview` (requires an allowlisted admin wallet)
- `GET /api/admin/audit-logs?page=1&limit=20` (requires an allowlisted admin wallet)

Donation history responses contain `items` and `pagination`. `limit` defaults to
20 and is capped at 100. Use `page` to request older pages. Recording the same
on-chain donation again with the same `Idempotency-Key` returns the original
donation without inserting another row. Keys are retained for 24 hours.

`GET /health` reports `status: "ok"` when the process and Soroban RPC are
available, and `status: "degraded"` with `dependencies.sorobanRpc.status:
"down"` when all RPC endpoints fail. Configure a failover pool with
`SOROBAN_RPC_URLS` (comma-separated, in priority order); the legacy
`SOROBAN_RPC_URL` setting is still accepted. `SOROBAN_RPC_TIMEOUT_MS` controls
the per-endpoint timeout (the health probe allows 1.5 seconds per endpoint and
up to 3 seconds total for failover). Each
successful request logs the endpoint that served it, and failed endpoints are
logged before the next attempt.

## Notes for Contributors

- The backend is intentionally simple so contributors can add authentication, payment workflows, and dashboard queries.
- There is no contract dependency for this API layer.
- Soroban donation events are indexed with a durable `(transaction hash, operation index, event index)` identity. A listener restart may replay the configured lookback window, but the unique on-chain identity makes the database write an idempotent upsert rather than a second donation. New contract events include the SAC token address; redeploy the donation contract with this event shape before relying on USDC classification, and configure `SOROBAN_USDC_ISSUER` (or `SOROBAN_USDC_TOKEN_ID`) so the listener can classify USDC instead of guessing.
- Donation rows reported by a browser with a transaction hash remain provisional (`verified: false`) and are excluded from aggregate queries until the listener verifies the on-chain event; the listener then replaces the provisional metadata with authoritative event data.
- Admin overview access and future state-changing admin routes are recorded in `AdminAuditLog`; `/api/admin/audit-logs` exposes the recent entries to allowlisted admins.
- If you add a new database model, update `prisma/schema.prisma` and run `npm run prisma:generate`.
- Apply schema changes with `npx prisma db push` in environments that do not yet use Prisma migrations. Reconcile any historical duplicate on-chain identities before adding the unique constraint to a populated database.
