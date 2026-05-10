# AGENTS.md

## Project Context

This repository implements the **ReadyOn Time-Off Microservice** take-home exercise.

The system is a backend microservice built with:

- **NestJS**
- **SQLite**
- **TypeORM**
- **REST APIs**
- **Jest + Supertest**

The service manages employee time-off request lifecycle and keeps ReadyOn balance data synchronized with a mock external HCM system.

The external HCM system is the **source of truth** for time-off balances. ReadyOn stores a local cached balance only for display and sync purposes.

---

## Primary Source of Truth for Requirements

Before making any implementation decision, read and follow:

```text
TRD.md
```

The TRD defines:

- Product requirements
- System architecture
- API contracts
- Data model
- Request lifecycle
- HCM sync strategy
- Error handling
- Idempotency requirements
- Unit test plan
- E2E test plan
- Acceptance criteria

Do **not** invent behavior that conflicts with the TRD.

If code and TRD disagree, update the code to match the TRD unless explicitly instructed otherwise.

---

## Development Principles

### 1. Be solid, professional, and production-minded

Write code as if this were a real backend service review.

The implementation should be:

- Clear
- Typed
- Modular
- Testable
- Deterministic
- Easy to review
- Easy to extend

Avoid clever, fragile, or overly abstract code.

Prefer straightforward service/controller/entity patterns that fit NestJS conventions.

---

### 2. Do not take shortcuts or fallback to fake behavior

Do **not** silently replace required behavior with simpler fallback logic.

Examples of unacceptable fallback behavior:

- Returning hardcoded success responses instead of implementing real service logic.
- Skipping HCM realtime validation when the TRD requires it.
- Directly reading mock HCM tables from ReadyOn services.
- Approving a request locally when HCM submission fails.
- Ignoring idempotency and allowing duplicate HCM deduction.
- Catching errors and returning success.
- Skipping tests because implementation is inconvenient.
- Replacing e2e tests with only unit tests.

If something is difficult, implement the smallest correct version that satisfies the TRD. Do not fake correctness.

---

### 3. Preserve the HCM system boundary

The mock HCM context must behave like an external system.

ReadyOn services must communicate with HCM only through the HCM client abstraction.

Allowed:

```text
ReadyOn Service -> HcmClient -> Mock HCM API -> mock_hcm_* tables
```

Not allowed:

```text
ReadyOn Service -> mock_hcm_balances table
```

Even if mock HCM and ReadyOn run in the same NestJS app and SQLite database, they must remain logically separated.

This is important because the take-home is testing sync and external-system boundary thinking.

---

### 4. HCM is the source of truth

ReadyOn local balances are cache records only.

Use local cache for:

- Fast balance display
- Storing last synced balance
- Returning cached data when refresh is not requested

Do not use local cache as the final validator for request creation or approval.

Critical actions must call HCM realtime APIs:

- Create time-off request
- Approve time-off request
- Submit time-off usage

If HCM says insufficient balance, reject the operation.

If HCM is unavailable, do not assume success.

---

### 5. Keep the simplified scope

This project intentionally simplifies the domain.

Follow the TRD simplifications:

- Balance is tracked by `employeeId` and `locationId`.
- Do not add `type`, `startDate`, or `endDate` unless the TRD is later updated.
- All balances use the same simplified time-off category.
- No frontend UI.
- No real Workday/SAP integration.
- No real authentication or authorization system unless requested.
- No production distributed locking.
- No payroll or accrual policy engine.

Do not expand scope unnecessarily.

---

## Expected Repository Structure

Follow this structure unless there is a strong reason not to:

```text
readyon-timeoff-service/
  docs/
    TRD.md
  src/
    app.module.ts
    common/
      errors.ts
      idempotency.ts
    balances/
      balance.entity.ts
      balances.controller.ts
      balances.service.ts
      dto/
    timeoff/
      time-off-request.entity.ts
      timeoff.controller.ts
      timeoff.service.ts
      dto/
    hcm/
      hcm-client.interface.ts
      hcm-http-client.ts
      hcm-sync-log.entity.ts
    mock-hcm/
      mock-hcm-balance.entity.ts
      mock-hcm-time-off-usage.entity.ts
      mock-hcm.controller.ts
      mock-hcm.service.ts
  test/
    unit/
      timeoff.service.spec.ts
      balances.service.spec.ts
    e2e/
      balance-sync.e2e-spec.ts
      timeoff-lifecycle.e2e-spec.ts
      mock-hcm.e2e-spec.ts
  README.md
  AGENTS.md
  package.json
```

---

## API Scope

Implement the APIs described in `TRD.md`.

Core ReadyOn APIs:

```text
GET  /balances
POST /balances/sync-from-hcm
POST /time-off-requests
GET  /time-off-requests/:requestId
GET  /employees/:employeeId/time-off-requests
POST /time-off-requests/:requestId/approve
POST /time-off-requests/:requestId/reject
POST /time-off-requests/:requestId/cancel
```

Core Mock HCM APIs:

```text
GET  /mock-hcm/balances
POST /mock-hcm/time-off-usages
GET  /mock-hcm/balances/batch
POST /mock-hcm/test/balances
POST /mock-hcm/test/failure-mode
```

Do not add unnecessary APIs unless they support tests or TRD acceptance criteria.

---

## Data Model Rules

Use SQLite and TypeORM entities.

Required tables:

```text
readyon_balances
time_off_requests
hcm_sync_logs
mock_hcm_balances
mock_hcm_time_off_usages
```

Important constraints:

- `readyon_balances` should be unique by `(employee_id, location_id)`.
- `mock_hcm_balances` should be unique by `(employee_id, location_id)`.
- `time_off_requests.request_id` should be unique.
- HCM usage submissions should be protected by an idempotency key.

Use decimal-compatible storage for `availableDays` and `requestedDays`, but keep the implementation simple for SQLite.

---

## Request Lifecycle Rules

### Create Request

Required behavior:

1. Validate request payload.
2. Call HCM realtime balance API.
3. Reject invalid employee/location combinations.
4. Reject insufficient HCM balance.
5. Create request as `PENDING_APPROVAL` only if HCM validation succeeds.
6. Update ReadyOn local balance cache using latest HCM balance.

Do not create a request if HCM is unavailable.

---

### Approve Request

Required behavior:

1. Load the request.
2. Verify the request is `PENDING_APPROVAL`.
3. Call HCM realtime balance API again.
4. Reject approval if HCM balance is insufficient.
5. Submit usage to HCM using an idempotency key.
6. Mark request `APPROVED` only after HCM accepts the submission.
7. Store the HCM transaction ID.
8. Update ReadyOn local balance cache using HCM remaining balance.
9. Prevent duplicate approval from deducting HCM balance twice.

Do not mark a request approved if HCM filing fails.

---

### Reject Request

Required behavior:

1. Load the request.
2. Verify the request is `PENDING_APPROVAL`.
3. Mark request as `REJECTED`.
4. Store manager ID and optional rejection reason.
5. Do not call HCM to deduct balance.

---

## Error Handling Rules

Use clear error responses with stable error codes.

Expected error codes include:

```text
INVALID_REQUEST
INVALID_REQUEST_DAYS
INVALID_DIMENSION
INSUFFICIENT_BALANCE
REQUEST_NOT_FOUND
REQUEST_NOT_APPROVABLE
HCM_UNAVAILABLE
HCM_INVALID_RESPONSE
```

Do not return generic success for failed operations.

Do not hide HCM failures.

If an HCM response is malformed, treat it as a failure.

---

## Idempotency Rules

Approval must be idempotent.

A duplicate approval call must not deduct HCM balance twice.

Use a stable idempotency key, for example:

```text
${requestId}:approval
```

The mock HCM usage table should store the idempotency key and return the original transaction if the same key is submitted again.

---

## Testing Rules

Tests are not optional. The quality of this take-home depends heavily on the rigor of the test suite.

When implementing a feature, add or update tests at the same time.

### Unit tests

Use mocked `HcmClient` responses for fast service-level tests.

Unit tests should cover:

- Request creation success
- Request creation insufficient balance
- Request creation invalid dimension
- Request creation HCM timeout
- Request creation malformed HCM response
- Approval success
- Approval insufficient balance
- Approval invalid status
- Duplicate approval
- Rejection success
- Rejection invalid status
- Batch sync success
- Batch sync failure

### E2E tests

Use real HTTP calls with Supertest, SQLite, and the stateful mock HCM API.

E2E tests should cover:

- Mock HCM balance lookup
- Mock HCM usage deduction
- Mock HCM insufficient balance
- Mock HCM idempotent replay
- Batch sync initial load
- Batch sync HCM independent increase
- Batch sync HCM independent decrease
- Employee create request with enough HCM balance
- Employee create request with stale ReadyOn cache but enough HCM balance
- Employee create request with ReadyOn cache enough but HCM insufficient
- Manager approval success
- Manager approval after HCM balance changed lower
- Manager reject request
- Duplicate approval deducts only once
- Two requests competing for same balance
- HCM timeout
- HCM server error
- HCM malformed response

### Coverage

Target coverage:

```text
Statements: 80%+
Branches: 75%+
Functions: 80%+
Lines: 80%+
```

Coverage percentage is not enough. Tests must prove the important business rules.

---

## Cursor / AI Agent Workflow

When using Cursor or any AI coding agent, follow this workflow:

1. Read `TRD.md` first.
2. Read this `AGENTS.md` file second.
3. Implement in small steps.
4. After each step, run relevant tests.
5. Do not continue building on failing tests.
6. Do not rewrite unrelated files.
7. Do not introduce new libraries unless necessary.
8. Do not change API contracts without updating the TRD.
9. Prefer fixing root causes over patching symptoms.
10. Keep commits small and explainable.

Recommended implementation order:

```text
1. Project setup
2. SQLite + TypeORM config
3. Entities
4. Mock HCM module
5. HCM client abstraction
6. Balance sync module
7. Time-off request creation
8. Approval/rejection workflow
9. Unit tests
10. E2E tests
11. README and coverage proof
```

---

## Code Quality Rules

Use:

- DTOs for request validation
- Services for business logic
- Controllers for HTTP routing only
- Entities for persistence mapping
- Clear error classes or shared error helpers
- Descriptive names
- Small methods where practical
- Explicit status transitions

Avoid:

- Business logic inside controllers
- Hardcoded fake success paths
- Global mutable state except controlled mock HCM failure mode for tests
- Unclear magic strings scattered across files
- Swallowing exceptions silently
- Direct database access across bounded contexts
- Large unrelated refactors

---

## Validation Rules

Validate at minimum:

- `employeeId` is required.
- `locationId` is required.
- `requestedDays` is required for request creation.
- `requestedDays` must be greater than 0.
- `managerId` is required for approve/reject.
- Rejection reason is optional.

Do not add date or type validation unless the TRD is updated to include those fields.

---

## Mock HCM Rules

The mock HCM service should simulate real external-system behavior.

It should support:

- Balance lookup
- Usage submission
- Batch balance export
- Independent balance update through test endpoint
- Failure mode configuration
- Insufficient balance response
- Invalid dimension response
- Idempotent replay

Failure modes should include:

```text
NONE
TIMEOUT
SERVER_ERROR
MALFORMED_RESPONSE
IGNORE_INSUFFICIENT_BALANCE
```

The `IGNORE_INSUFFICIENT_BALANCE` mode exists to prove ReadyOn performs defensive validation before submitting usage.

---

## Documentation Rules

Keep documentation aligned with implementation.

Update `README.md` with:

- Project purpose
- Tech stack
- Setup commands
- How to run the app
- How to run tests
- How to run coverage
- Main API examples
- Design summary

Do not let code drift away from `TRD.md`.

---

## Final Acceptance Checklist

Before considering the task complete, verify:

- `npm install` works from a clean checkout.
- `npm run start:dev` starts the service.
- SQLite database is created locally.
- ReadyOn APIs work.
- Mock HCM APIs work.
- Unit tests pass.
- E2E tests pass.
- Coverage report is generated.
- Duplicate approval does not double-deduct HCM balance.
- HCM stale balance scenarios are tested.
- HCM failure scenarios are tested.
- README explains how to run and test the project.
- Implementation follows `TRD.md`.

---

## Important Reminder

Do not optimize for the fastest possible implementation.

Optimize for a clean, defensible take-home submission that demonstrates:

- System design judgment
- Balance integrity thinking
- External system boundary discipline
- Failure handling
- Idempotency
- Test rigor
- Professional backend engineering practice

