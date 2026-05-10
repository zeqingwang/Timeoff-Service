# Implementation checklist (TRD)

Use this list to track alignment with [TRD.md](TRD.md) and [agents.md](agents.md).

## Done

- [x] SQLite + TypeORM; entities: `readyon_balances`, `time_off_requests`, `hcm_sync_logs`, `mock_hcm_balances`, `mock_hcm_time_off_usages`
- [x] Mock HCM module: realtime balance, usage submit (idempotent), batch export, test seed + failure modes
- [x] `HcmClient` + `HttpHcmClient` (`HCM_BASE_URL` / `PORT`)
- [x] ReadyOn: `GET /balances`, `POST /balances/sync-from-hcm`, sync logging
- [x] ReadyOn: create / get / list / approve / reject time-off requests
- [x] Unit tests: `test/unit/balances.service.spec.ts`, `test/unit/timeoff.service.spec.ts`
- [x] E2E tests: `test/e2e/mock-hcm.e2e-spec.ts`, `balance-sync.e2e-spec.ts`, `timeoff-lifecycle.e2e-spec.ts`
- [x] README: run, env vars, tests, coverage, API summary
- [x] Combined coverage via `npm run test:cov` (unit + E2E)

## Acceptance (TRD §24)

- [x] Cached + refreshed balance
- [x] Create / approve / reject flows with HCM validation
- [x] Batch sync updates cache
- [x] Mock HCM independent changes + failure modes
- [x] Automated tests + coverage report
