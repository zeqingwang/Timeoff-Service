# ReadyOn Time-Off Microservice

Backend service for employee time-off requests, cached balances, and synchronization with an external HCM system. Implements the product scope described in [TRD.md](TRD.md) and engineering rules in [agents.md](agents.md).

## Stack

- **NestJS** – HTTP API
- **SQLite** + **TypeORM** – persistence
- **REST** – ReadyOn APIs + in-process **mock HCM** APIs
- **Jest** + **Supertest** – unit tests (mocked `HcmClient`) and E2E tests (real HTTP + SQLite)

## Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` in the project root if you want file-based config. At startup, `app.module` loads it via [dotenv](https://github.com/motdotla/dotenv) (`import 'dotenv/config'`). Values already set in your environment take precedence. You can still rely on defaults without a `.env` file.

## Run

Development (watch mode):

```bash
npm run start:dev
```

Default URL: **http://localhost:3000**. Override with `PORT`.

SQLite database file defaults to **`timeoff.sqlite`** in the project root. Override with:

```bash
set DATABASE_PATH=./data/my.db
```

On startup the app sets **`HCM_BASE_URL`** to `http://127.0.0.1:<PORT>/mock-hcm` so the HTTP `HcmClient` calls the mock HCM routes in the same process. Override if needed:

```bash
set HCM_BASE_URL=http://127.0.0.1:3000/mock-hcm
```

Optional approval lock tuning (serialize `POST .../approve` per employee + location):

```bash
set APPROVAL_LOCK_TTL_MS=30000
set APPROVAL_LOCK_ACQUIRE_TIMEOUT_MS=5000
set APPROVAL_LOCK_RETRY_DELAY_MS=50
```

Production:

```bash
npm run build
npm run start:prod
```

## Tests

```bash
# Unit tests only (fast)
npm test

# End-to-end only (same app + SQLite + mock HCM HTTP)
npm run test:e2e

# Coverage: unit + E2E combined (recommended for TRD proof)
npm run test:cov
```

Coverage is collected from `src/**/*.ts` while executing both `test/unit/**/*.spec.ts` and `test/e2e/**/*.e2e-spec.ts`. With the current suite, combined figures are approximately **96%** lines, **96%** statements, **93%** functions, and **84%** branches; open the HTML report under `coverage/` after `npm run test:cov` for file-level detail.

## Main APIs (ReadyOn)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/balances` | Cached balance; `refresh=true` pulls from HCM first |
| POST | `/balances/sync-from-hcm` | Batch sync from HCM into cache |
| POST | `/time-off-requests` | Create request (validates with HCM realtime balance) |
| GET | `/time-off-requests/:requestId` | Get one request |
| GET | `/employees/:employeeId/time-off-requests` | List requests (`status`, `locationId` optional) |
| POST | `/time-off-requests/:requestId/approve` | Approve + file usage in HCM (idempotent) |
| POST | `/time-off-requests/:requestId/reject` | Reject pending request |
| POST | `/time-off-requests/:requestId/cancel` | Employee cancels own pending request (`employeeId` body) |

## Mock HCM (development / tests)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/mock-hcm/balances` | Realtime balance |
| POST | `/mock-hcm/time-off-usages` | Deduct / idempotent usage |
| GET | `/mock-hcm/balances/batch` | Full balance corpus |
| POST | `/mock-hcm/test/balances` | Seed or update mock balances |
| POST | `/mock-hcm/test/failure-mode` | Configure failure simulation |

## Design summary

- **HCM is the source of truth** for balances at create and approve time; ReadyOn `readyon_balances` is a cache updated after successful HCM reads or filings and after batch sync.
- ReadyOn **never reads `mock_hcm_*` tables directly**; it uses the **`HcmClient`** HTTP adapter to call mock HCM routes.
- Approval uses a stable idempotency key (`<requestId>:approval`) so duplicate approvals do not double-deduct in HCM.
- Concurrent approvals for the same employee and location are serialized via the `approval_locks` table (see `APPROVAL_LOCK_*` env vars and [TRD.md](TRD.md) §16).
