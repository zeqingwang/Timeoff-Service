# Technical Requirements Document: ReadyOn Time-Off Microservice

## 1. Overview

ReadyOn provides the primary employee-facing and manager-facing interface for requesting and approving time off. However, the external Human Capital Management system, such as Workday or SAP, remains the source of truth for employment and time-off balance data.

The goal of this project is to design and implement a Time-Off Microservice that manages the lifecycle of time-off requests while maintaining balance integrity with the external HCM system.

The service will be implemented using:

- **NestJS** for the backend API service
- **SQLite** for persistence
- **REST APIs** for ReadyOn and mock HCM integration
- **Jest + Supertest** for unit and end-to-end testing
- **A stateful mock HCM service** to simulate external HCM behavior

This document defines the system design, API contracts, data model, sync strategy, failure handling, alternatives considered, and test strategy.

### 1.1 Original assignment alignment

This TRD satisfies the take-home engineering specification alongside an implemented repository. Deliverables map as follows:

| Deliverable | Location |
| ----------- | -------- |
| Technical Requirement Document (TRD) | This document (`TRD.md` at repository root) |
| Implementable codebase | Git repository (NestJS + SQLite, as specified) |
| Test suite and coverage proof | `test/unit`, `test/e2e`, `npm run test:cov`, README |

The original problem stresses **sync difficulty** between ReadyOn and HCM when balances change independently (e.g. work anniversary, plan year reset, HR adjustments). The design addresses **realtime** balance read and usage filing, a **batch** corpus sync into ReadyOn’s cache, **defensive** validation when HCM responses are imperfect, and a **stateful mock HCM** with realistic failure modes for automated tests.

---

## 2. Problem Statement

Time-off balances are difficult to keep synchronized between ReadyOn and the external HCM system because both systems may observe or trigger balance changes.

Example:

1. An employee has 10 PTO days in HCM.
2. ReadyOn syncs this balance and displays 10 days.
3. The employee requests 2 days through ReadyOn.
4. Before approval, HCM independently changes the employee balance due to a work anniversary bonus, yearly reset, manual HR adjustment, or another system integration.
5. ReadyOn must avoid approving or submitting requests using stale balance data.

The system must provide employees with fast and accurate feedback while ensuring final approval and filing are validated against the HCM source of truth.

---

## 3. Goals

The Time-Off Microservice must:

1. Allow employees to view their time-off balances.
2. Allow employees to create time-off requests.
3. Allow employees to cancel their own pending requests (terminal `CANCELLED` status).
4. Allow managers to approve or reject time-off requests.
5. Validate time-off requests against HCM balances.
6. Keep a local cache of HCM balances for fast reads and UI responsiveness.
7. Support realtime HCM balance checks.
8. Support batch balance synchronization from HCM.
9. Defensively handle stale data, invalid dimension combinations, insufficient balances, HCM errors, and duplicate actions.
10. Provide a mock HCM service for test and development purposes.
11. Include a rigorous automated test suite that protects against future regressions.

---

## 4. Non-Goals

The following are outside the scope of this take-home implementation:

1. Building a frontend UI.
2. Implementing real Workday, SAP, or third-party HCM authentication.
3. Supporting multiple real HCM vendors with vendor-specific adapters.
4. Implementing payroll calculation.
5. Supporting complex accrual policy engines.
6. Supporting partial-day or hourly time-off calculations beyond simple day-based balances.
7. Implementing production-grade distributed locking.
8. Implementing real message queues or background workers.
9. Supporting multi-tenant production isolation beyond a simple customer-agnostic model.

---

## 5. Assumptions

1. Balances are tracked per employee and per location.
2. All balances represent the same time-off type (single bucket), to simplify the problem.
3. HCM exposes a realtime API for reading balances and filing time-off usage.
4. HCM exposes a batch endpoint that returns the full corpus of time-off balances.
5. HCM usually returns errors for invalid dimensions or insufficient balance, but ReadyOn must still perform defensive validation.
6. ReadyOn’s local balance table is a cache, not the source of truth.
7. A time-off request should not become finally approved unless HCM accepts the filing request.
8. SQLite is acceptable for this take-home, but the design should be portable to a production relational database such as PostgreSQL.
9. **Stable employment context for the take-home:** employees do not terminate or lose eligibility mid-flow between submit and manager action. In other words, we do not model “employee submitted while active but was terminated before approval”—approvals still operate on a request in `PENDING_APPROVAL` against current HCM dimensions and balance.

---

## 6. User Personas

### 6.1 Employee

The employee wants to:

- See a reasonably accurate available balance.
- Submit a time-off request quickly.
- Receive instant feedback when a request cannot be submitted.
- Understand whether the request is pending, approved, rejected, or failed.

### 6.2 Manager

The manager wants to:

- Review pending time-off requests.
- Approve requests with confidence that balances are valid.
- Reject requests when appropriate.
- Avoid approving requests that later fail in HCM.

### 6.3 System Operator / Developer

The system operator wants to:

- Understand sync failures.
- Reconcile ReadyOn state with HCM state.
- Run tests that prove the system handles stale balances, HCM failures, and duplicate submissions.

---

## 7. High-Level Architecture

```text
Employee / Manager Client
        |
        v
ReadyOn Time-Off Microservice
        |
        | REST via HcmClient abstraction
        v
Mock HCM API
        |
        v
Mock HCM Tables
```

The NestJS application contains two logical bounded contexts:

1. **ReadyOn Time-Off Context**

   - Owns ReadyOn time-off requests.
   - Stores cached balances.
   - Manages request lifecycle.
   - Calls HCM through an `HcmClient` abstraction.

2. **Mock HCM Context**

   - Simulates an external HCM system.
   - Owns separate mock HCM balance records.
   - Exposes mock realtime and batch APIs.
   - Can simulate independent balance changes, insufficient balance, invalid dimensions, and failures.

Although both contexts may run in the same NestJS app and SQLite database for simplicity, ReadyOn must never directly read mock HCM tables. ReadyOn may only interact with mock HCM through API calls using the HCM client abstraction. This preserves the external system boundary and makes sync behavior testable.

---

## 8. Core Design Principle

HCM is the source of truth. ReadyOn stores a local balance cache only for fast reads and user experience.

The local balance cache can be used for quick feedback, but critical transitions must validate against HCM.

Critical transitions include:

- Creating a time-off request.
- Approving a time-off request.
- Filing time-off usage into HCM.
- Reconciling after batch sync.

Recommended policy:

| Action              | Use Local Cache? | Call HCM?        | Reason                                                  |
| ------------------- | ---------------- | ---------------- | ------------------------------------------------------- |
| Display balance     | Yes              | Optional refresh | Fast UI response                                        |
| Create request      | No               | Yes              | HCM realtime balance is the source of truth for request validation |
| Approve request     | Yes              | Yes              | Final validation before filing                          |
| Submit usage to HCM | No               | Yes              | To simulate the day usage, so HCM must accept the usage |
| Batch sync          | No               | Yes              | HCM snapshot updates local cache                        |

---

## 9. Request Lifecycle

### 9.1 Statuses

A time-off request may have the following statuses:

| Status                  | Meaning                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `PENDING_APPROVAL`      | Employee submitted the request and it is waiting for manager approval. |
| `APPROVED`              | Manager approved the request and HCM accepted the usage.               |
| `REJECTED`              | Manager rejected the request.                                          |
| `FAILED_HCM_SUBMISSION` | Manager attempted approval, but filing into HCM failed.                |
| `CANCELLED`             | Employee or system cancelled the request before final approval.        |

For this take-home, `APPROVED` means the request was both manager-approved and successfully filed into HCM.

**Final statuses:** `APPROVED`, `REJECTED`, `CANCELLED`, and `FAILED_HCM_SUBMISSION` are terminal. No transition moves **into** `CANCELLED` from `APPROVED` or `REJECTED` (or any non-pending state). Only `PENDING_APPROVAL` may become `CANCELLED`, via the employee cancel API (see §9.5 and §11.1).

### 9.2 Create Request Flow

```text
1. Employee submits employeeId, locationId,requestedDays. 
2. Service validates request payload.
3. Service calls HCM realtime balance API to get the current source-of-truth balance.
4. If HCM says the dimension is invalid, reject request creation.
5. If HCM balance is insufficient, reject request creation.
6. If valid, create request in PENDING_APPROVAL status.
7. Update ReadyOn local balance cache with latest HCM balance.
```

### 9.3 Manager Approval Flow

```text
1. Manager approves a PENDING_APPROVAL request.
2. Service loads request in a database transaction.
3. Service verifies the request is still approvable.
4. Service calls HCM realtime balance API again.
5. If HCM balance is insufficient, mark or return approval failure.
6. Service calls HCM submit usage API with an idempotency key.
7. If HCM accepts, mark request APPROVED.
8. Update local balance cache using HCM remaining balance.
9. Write an HCM submission log.
```

### 9.4 Manager Rejection Flow

```text
1. Manager rejects a PENDING_APPROVAL request.
2. Service verifies the request is still rejectable.
3. Service updates status to REJECTED.
4. No HCM balance deduction occurs.
5. Rejection reason may be stored.
```

### 9.5 Employee Cancellation Flow

```text
1. Employee calls cancel with their employeeId (must match the request owner).
2. Service verifies the request exists and is PENDING_APPROVAL.
3. Service sets status to CANCELLED (terminal). No HCM usage is filed; balances are unchanged.
4. Approved, rejected, failed-HCM, or already-cancelled requests cannot be cancelled.
```

---

## 10. Data Model

### 10.1 readyon\_balances

Stores ReadyOn’s cached view of HCM balances.

| Column           | Type     | Notes                        |
| ---------------- | -------- | ---------------------------- |
| id               | integer  | Primary key                  |
| employee\_id     | varchar  | Employee identifier          |
| location\_id     | varchar  | Location identifier          |
|                  |          |                              |
| available\_days  | decimal  | Last known available balance |
| last\_synced\_at | datetime | Last successful sync time    |
| created\_at      | datetime | Record creation time         |
| updated\_at      | datetime | Record update time           |

Unique constraint:

```text
(employee_id, location_id)
```

### 10.2 time\_off\_requests

Stores ReadyOn request lifecycle records.

| Column               | Type     | Notes                                      |
| -------------------- | -------- | ------------------------------------------ |
| id                   | integer  | Primary key                                |
| request\_id          | varchar  | Public request identifier                  |
| employee\_id         | varchar  | Employee identifier                        |
| location\_id         | varchar  | Location identifier                        |
|                      |          |                                            |
| requested\_days      | decimal  | Number of requested days                   |
|                      |          |                                            |
| status               | varchar  | Request lifecycle status                   |
| manager\_id          | varchar  | Manager who approved/rejected, nullable    |
| rejection\_reason    | text     | Optional rejection reason                  |
| hcm\_transaction\_id | varchar  | HCM transaction ID after successful filing |
| idempotency\_key     | varchar  | Used to prevent duplicate HCM filing       |
| created\_at          | datetime | Record creation time                       |
| updated\_at          | datetime | Record update time                         |

Unique constraints:

```text
request_id
idempotency_key
```

### 10.3 hcm\_sync\_logs

Stores logs for realtime and batch sync operations.

| Column         | Type     | Notes                                               |
| -------------- | -------- | --------------------------------------------------- |
| id             | integer  | Primary key                                         |
| sync\_type     | varchar  | `REALTIME_BALANCE`, `BATCH_BALANCE`, `SUBMIT_USAGE` |
| status         | varchar  | `SUCCESS`, `FAILED`                                 |
| employee\_id   | varchar  | Nullable for batch sync                             |
| location\_id   | varchar  | Nullable for batch sync                             |
|                |          |                                                     |
| request\_id    | varchar  | Nullable                                            |
| error\_code    | varchar  | Nullable                                            |
| error\_message | text     | Nullable                                            |
| created\_at    | datetime | Log creation time                                   |

### 10.4 mock\_hcm\_balances

Stores fake HCM balances. This table represents the external source of truth in tests.

| Column          | Type     | Notes                            |
| --------------- | -------- | -------------------------------- |
| id              | integer  | Primary key                      |
| employee\_id    | varchar  | Employee identifier              |
| location\_id    | varchar  | Location identifier              |
|                 |          |                                  |
| available\_days | decimal  | HCM source-of-truth balance      |
|                 |          |                                  |
| version         | integer  | Incremented when balance changes |
| created\_at     | datetime | Record creation time             |
| updated\_at     | datetime | Record update time               |

Unique constraint:

```text
(employee_id, location_id)
```

### 10.5 mock\_hcm\_time\_off\_usages

Stores fake HCM usage submissions.

| Column                | Type     | Notes                             |
| --------------------- | -------- | --------------------------------- |
| id                    | integer  | Primary key                       |
| hcm\_transaction\_id  | varchar  | Mock HCM transaction identifier   |
| external\_request\_id | varchar  | ReadyOn request ID                |
| employee\_id          | varchar  | Employee identifier               |
| location\_id          | varchar  | Location identifier               |
|                       |          |                                   |
| days                  | decimal  | Deducted days                     |
| idempotency\_key      | varchar  | Prevents duplicate HCM deductions |
| created\_at           | datetime | Record creation time              |

Unique constraints:

```text
external_request_id
idempotency_key
```

---

## 11. API Design

## 11.1 ReadyOn APIs

### GET /balances

Returns ReadyOn’s local cached balance. Optionally refreshes from HCM.

Query parameters:

| Name       | Required | Example |
| ---------- | -------- | ------- |
| employeeId | Yes      | `E001`  |
| locationId | Yes      | `L001`  |
| refresh    | No       | `true`  |

Example response:

```json
{
  "employeeId": "E001",
  "locationId": "L001",
  "availableDays": 10,
  "lastSyncedAt": "2026-05-09T10:00:00.000Z",
  "source": "HCM_CACHE"
}
```

If `refresh=true`, the service calls HCM realtime balance API first, updates local cache, and returns the refreshed value.

---

### POST /balances/sync-from-hcm

Triggers batch balance sync from HCM.

Example response:

```json
{
  "status": "SUCCESS",
  "recordsReceived": 120,
  "recordsUpserted": 120,
  "recordsFailed": 0
}
```

Behavior:

1. Calls HCM batch balance endpoint.
2. Upserts returned balances into `readyon_balances`.
3. Writes `hcm_sync_logs` record.
4. Returns sync summary.

---

### POST /time-off-requests

Creates a time-off request.

Request body:

```json
{
  "employeeId": "E001",
  "locationId": "L001",
  "requestedDays": 2
}
```

Success response:

```json
{
  "requestId": "REQ_001",
  "status": "PENDING_APPROVAL",
  "employeeId": "E001",
  "locationId": "L001",
  "requestedDays": 2
}
```

Failure response example:

```json
{
  "errorCode": "INSUFFICIENT_BALANCE",
  "message": "Requested days exceed current HCM balance",
  "currentBalance": 1,
  "requestedDays": 2
}
```

Failure examples:

- `400 INVALID_REQUEST_DAYS`
- `422 INVALID_DIMENSION`
- `409 INSUFFICIENT_BALANCE`
- `503 HCM_UNAVAILABLE`

---

### GET /time-off-requests/\:requestId

Returns one time-off request.

Example response:

```json
{
  "requestId": "REQ_001",
  "employeeId": "E001",
  "locationId": "L001",
  "requestedDays": 2,
  "status": "PENDING_APPROVAL"
}
```

---

### GET /employees/\:employeeId/time-off-requests

Lists requests for an employee.

Optional query parameters:

| Name       | Example            |
| ---------- | ------------------ |
| status     | `PENDING_APPROVAL` |
| locationId | `L001`             |

---

### POST /time-off-requests/\:requestId/approve

Approves and files the request into HCM.

Request body:

```json
{
  "managerId": "M001"
}
```

Success response:

```json
{
  "requestId": "REQ_001",
  "status": "APPROVED",
  "hcmTransactionId": "HCM_TXN_001",
  "remainingDays": 8
}
```

Failure examples:

- `404 REQUEST_NOT_FOUND`
- `409 REQUEST_NOT_APPROVABLE`
- `409 INSUFFICIENT_BALANCE`
- `422 INVALID_DIMENSION`
- `503 HCM_UNAVAILABLE`

---

### POST /time-off-requests/\:requestId/reject

Rejects a pending request. This API only supports rejecting requests that are currently in `PENDING_APPROVAL` status.

Request body:

```json
{
  "managerId": "M001",
  "reason": "Team coverage conflict"
}
```

Success response:

```json
{
  "requestId": "REQ_001",
  "status": "REJECTED"
}
```

---

### POST /time-off-requests/\:requestId/cancel

Cancels a **pending** request by the owning employee. **`CANCELLED` is a final status** alongside `APPROVED`, `REJECTED`, and `FAILED_HCM_SUBMISSION`; it cannot be reached from `APPROVED` or `REJECTED`.

Request body:

```json
{
  "employeeId": "E001"
}
```

Success response:

```json
{
  "requestId": "REQ_001",
  "status": "CANCELLED"
}
```

Failure examples:

- `403 EMPLOYEE_MISMATCH` — `employeeId` does not own this request
- `404 REQUEST_NOT_FOUND`
- `409 REQUEST_NOT_CANCELLABLE` — request is not `PENDING_APPROVAL`

---

## 11.2 Mock HCM APIs

The mock HCM API is used for development and e2e testing.

### GET /mock-hcm/balances

Query parameters:

| Name       | Required | Example |
| ---------- | -------- | ------- |
| employeeId | Yes      | `E001`  |
| locationId | Yes      | `L001`  |

Success response:

```json
{
  "employeeId": "E001",
  "locationId": "L001",
  "availableDays": 10,
  "version": 1
}
```

Invalid dimension response:

```json
{
  "errorCode": "INVALID_DIMENSION",
  "message": "Invalid employee/location combination"
}
```

---

### POST /mock-hcm/time-off-usages

Deducts time off from mock HCM balance.

Request body:

```json
{
  "employeeId": "E001",
  "locationId": "L001",
  "days": 2,
  "externalRequestId": "REQ_001",
  "idempotencyKey": "REQ_001_APPROVAL"
}
```

Success response:

```json
{
  "success": true,
  "hcmTransactionId": "HCM_TXN_001",
  "remainingDays": 8
}
```

Insufficient balance response:

```json
{
  "success": false,
  "errorCode": "INSUFFICIENT_BALANCE",
  "message": "Insufficient balance",
  "currentBalance": 1
}
```

Idempotent duplicate response:

```json
{
  "success": true,
  "hcmTransactionId": "HCM_TXN_001",
  "remainingDays": 8,
  "idempotentReplay": true
}
```

---

### GET /mock-hcm/balances/batch

Returns the full mock HCM balance corpus.

Example response:

```json
{
  "balances": [
    {
      "employeeId": "E001",
      "locationId": "L001",
      "availableDays": 10,
      "version": 1
    },
    {
      "employeeId": "E002",
      "locationId": "L002",
      "availableDays": 5,
      "version": 1
    }
  ]
}
```

---

### POST /mock-hcm/test/balances

Test-only endpoint to seed or update mock HCM balances.

Request body:

```json
{
  "employeeId": "E001",
  "locationId": "L001",
  "availableDays": 15,
  "isValid": true
}
```

This endpoint simulates independent HCM-side balance changes such as anniversary bonuses or manual HR adjustments.

---

### POST /mock-hcm/test/failure-mode

Test-only endpoint to configure mock HCM failure behavior.

Request body:

```json
{
  "mode": "TIMEOUT"
}
```

Supported modes:

| Mode                          | Behavior                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `NONE`                        | Normal behavior                                                                   |
| `TIMEOUT`                     | Simulates HCM timeout                                                             |
| `SERVER_ERROR`                | Returns 500 error                                                                 |
| `MALFORMED_RESPONSE`          | Returns unexpected response shape                                                 |
| `IGNORE_INSUFFICIENT_BALANCE` | Simulates defensive case where HCM does not correctly reject insufficient balance |

---

## 12. HCM Client Abstraction

ReadyOn service code should depend on an interface, not directly on mock HCM implementation.

```text
HcmClient
- getBalance(employeeId, locationId)
- submitTimeOffUsage(payload)
- getBatchBalances()
```

Production-like implementation:

```text
HttpHcmClient
```

Test unit implementation:

```text
Jest mocked HcmClient
```

E2E implementation:

```text
HttpHcmClient pointing to Mock HCM API
```

This allows fast unit tests and realistic end-to-end tests.

---

## 13. Balance Sync Strategy

### 13.1 Local Cache

ReadyOn stores HCM balances locally in `readyon_balances` for fast reads. Each row includes `last_synced_at` and optional `source_version`.

The cache is updated by:

1. Realtime balance refresh.
2. Request creation HCM validation.
3. Manager approval HCM validation.
4. HCM usage submission result.
5. Batch sync.

### 13.2 Realtime Sync

Realtime sync is used before critical actions.

Examples:

- Employee creates a request.
- Manager approves a request.
- User explicitly asks for a refreshed balance.

### 13.3 Batch Sync

Batch sync periodically replaces or updates ReadyOn’s cached view of HCM balances.

For this implementation, batch sync will upsert all returned balances by `(employee_id, location_id)`.

If a previously known balance does not appear in the batch response, this implementation will not immediately delete it. Instead, future production design could mark it as missing or inactive after repeated batch omissions. This avoids accidental deletion due to partial batch failures.

### 13.4 Conflict Handling

If ReadyOn local balance differs from HCM realtime balance, HCM wins.

Example:

```text
readyon_balances = 10
mock_hcm_balances = 15
```

After realtime refresh or batch sync:

```text
readyon_balances = 15
```

---

## 14. Error Handling

### 14.1 Invalid Request Payload

Examples:

- `requestedDays <= 0`
- Missing employeeId or locationId

Response:

```json
{
  "errorCode": "INVALID_REQUEST",
  "message": "Requested days must be greater than 0"
}
```

### 14.2 Invalid Dimension

Occurs when the employee/location combination is invalid in HCM.

Response:

```json
{
  "errorCode": "INVALID_DIMENSION",
  "message": "Invalid employee/location combination"
}
```

### 14.3 Insufficient Balance

Occurs when HCM or ReadyOn defensive validation determines the available balance is not enough.

Response:

```json
{
  "errorCode": "INSUFFICIENT_BALANCE",
  "message": "Requested days exceed available balance",
  "currentBalance": 1
}
```

### 14.4 HCM Unavailable

If HCM is unavailable during create or approval, the service should not assume success.

Create request behavior:

- Return `503 HCM_UNAVAILABLE`.
- Do not create the request unless product explicitly allows pending validation.

Approval behavior:

- Return `503 HCM_UNAVAILABLE`.
- Do not mark request as approved.
- Optionally mark request as `FAILED_HCM_SUBMISSION` if filing was attempted and failed.

### 14.5 Malformed HCM Response

If HCM returns malformed or incomplete data, the service treats it as failure.

Response:

```json
{
  "errorCode": "HCM_INVALID_RESPONSE",
  "message": "HCM returned an invalid response"
}
```

---

## 15. Defensive Validation

Even though HCM is expected to reject invalid requests, ReadyOn should defensively validate:

1. Required fields are present.
2. Requested days are positive.
3. Request status transition is valid.
4. HCM realtime balance is sufficient before create and approve.
5. HCM submission response includes expected transaction ID and remaining balance.
6. Duplicate approval does not double-submit to HCM.

Special defensive case:

If the mock HCM is configured to incorrectly allow a submission that would make balance negative, ReadyOn should reject or flag the operation based on its own pre-submit realtime balance check.

---

## 16. Concurrency and Idempotency

### 16.1 Duplicate Approval

Problem:

A manager double-clicks approve, or a network retry repeats the request.

Solution:

- Approval must only be valid from `PENDING_APPROVAL` status.
- Use a stable idempotency key, such as `requestId + ':approval'`.
- Store the HCM transaction ID on successful submission.
- If approval is repeated for an already approved request, return current approved state without submitting again.

### 16.2 Two Requests Competing for Same Balance

Problem:

Employee has 5 days. Two requests for 3 days each are approved around the same time.

Solution:

- Each approval re-checks HCM realtime balance.
- HCM submit usage endpoint deducts from mock HCM source-of-truth balance.
- If the second approval exceeds remaining HCM balance, it fails.
- SQLite transaction protects local request status update.

### 16.3 SQLite Limitation

SQLite has limited concurrent write behavior compared with production databases. For this take-home, transactions and idempotency are sufficient. In production, this design should move to PostgreSQL with row-level locking, stronger isolation, and possibly distributed locking or queue-based approval processing.

---

## 17. Alternatives Considered

### 17.1 Trust ReadyOn Local Balance Only

Rejected.

This provides fast performance but fails when HCM changes balances independently. It does not satisfy the source-of-truth requirement.

### 17.2 Always Call HCM for Every Read

Rejected as the default.

This provides the freshest data but may be slower, more expensive, and less resilient to HCM downtime. It also creates poor user experience if HCM latency is high.

### 17.3 Hybrid Local Cache + Realtime Validation

Selected.

ReadyOn uses local cache for fast display and realtime HCM validation for critical actions. This balances user experience with correctness.

### 17.4 Mock HCM with Static JSON Only

Rejected as the only test strategy.

Static JSON mocks are useful for unit tests, but they cannot simulate independent HCM balance changes, batch sync, source-of-truth behavior, or double-deduction risks.

### 17.5 Stateful Mock HCM with Separate Tables and APIs

Selected.

A stateful mock HCM provides realistic integration behavior and enables strong e2e tests. ReadyOn must call the mock HCM through an API boundary rather than directly reading mock HCM tables.

### 17.6 REST versus GraphQL

**REST** is selected for ReadyOn and mock HCM HTTP APIs. It matches NestJS conventions, keeps contracts easy to document and test with Jest/Supertest, and is sufficient for resource-oriented balance and time-off operations. **GraphQL** was considered as an alternative for flexible reads but was deferred to reduce scope and avoid an additional schema and resolver layer in the take-home; a future BFF could expose GraphQL while this service remains REST.

---

## 18. Testing Strategy

The test suite is a core deliverable. Because this project may be developed using AI-assisted or agentic development, tests must be precise enough to catch regressions and incorrect generated code.

Some assignment wording suggests prioritizing a rigorous specification over hand-written code; in practice, **quality comes from a precise TRD plus automated tests that encode acceptance behavior.** Implementation should follow the TRD and tests so that agent-assisted changes remain verifiable.

The project will include:

1. Unit tests with mocked HCM client responses.
2. Integration/e2e tests using the stateful mock HCM API and SQLite.
3. Test coverage reporting.
4. Tests for failure and edge cases, not only happy paths.

---

## 19. Unit Test Plan

Unit tests focus on service-level business logic with mocked `HcmClient`.

### 19.1 Request Creation Unit Tests

| Test Case                                     | Expected Result                                   |
| --------------------------------------------- | ------------------------------------------------- |
| Create request with sufficient HCM balance    | Request created as `PENDING_APPROVAL`             |
| Create request with insufficient HCM balance  | Request rejected                                  |
| Create request with invalid dimension         | Request rejected                                  |
| Create request with zero days                 | Validation error                                  |
| Create request with negative days             | Validation error                                  |
| HCM timeout during create                     | Request not created; returns HCM unavailable      |
| HCM malformed response                        | Request not created; returns invalid HCM response |

### 19.2 Approval Unit Tests

| Test Case                                             | Expected Result                                |
| ----------------------------------------------------- | ---------------------------------------------- |
| Approve pending request with sufficient balance       | Request becomes `APPROVED`                     |
| Approve request when HCM rejects insufficient balance | Request not approved                           |
| Approve request when HCM dimension invalid            | Request not approved                           |
| Approve already approved request                      | Does not double-submit; returns approved state |
| Approve rejected request                              | Returns request not approvable                 |
| HCM timeout before filing                             | Request remains unapproved                     |
| HCM fails during filing                               | Request becomes or remains failed/unapproved   |

### 19.3 Cancellation Unit Tests

| Test Case                                    | Expected Result                                |
| -------------------------------------------- | ---------------------------------------------- |
| Cancel pending request with matching owner   | Status becomes `CANCELLED` (terminal)          |
| Cancel with non-matching `employeeId`        | `403` / `EMPLOYEE_MISMATCH`                    |
| Cancel when approved, rejected, or cancelled | `409` / `REQUEST_NOT_CANCELLABLE`              |
| Cancel missing request                       | `404` / `REQUEST_NOT_FOUND`                    |

### 19.4 Balance Sync Unit Tests

| Test Case                        | Expected Result                                    |
| -------------------------------- | -------------------------------------------------- |
| Upsert new balance from HCM      | Local balance created                              |
| Update existing balance from HCM | Local balance updated                              |
| HCM batch returns duplicate rows | Deterministic handling; no duplicate local records |
| HCM batch fails                  | Sync log records failure                           |

---

## 20. End-to-End Test Plan

E2E tests use real HTTP endpoints, SQLite, and mock HCM state.

### 20.1 Mock HCM State Tests

| Test Case                | Setup                                 | Expected Result               |
| ------------------------ | ------------------------------------- | ----------------------------- |
| HCM balance lookup       | Seed mock HCM with E001/L001 = 10 | GET returns 10                |
| Invalid dimension        | No valid mock HCM row                 | GET returns invalid dimension |
| HCM usage deduction      | Seed balance = 10, submit 2 days      | HCM remaining balance = 8     |
| HCM insufficient balance | Seed balance = 1, submit 2 days       | HCM rejects                   |
| HCM idempotent replay    | Submit same idempotency key twice     | Balance deducted only once    |

### 20.2 Batch Sync E2E Tests

| Test Case                   | Setup                          | Action                       | Expected Result                |
| --------------------------- | ------------------------------ | ---------------------------- | ------------------------------ |
| Initial batch sync          | HCM has balance, ReadyOn empty | POST /balances/sync-from-hcm | ReadyOn balance created        |
| HCM independent increase    | ReadyOn = 10, HCM = 15         | POST /balances/sync-from-hcm | ReadyOn becomes 15             |
| HCM independent decrease    | ReadyOn = 10, HCM = 6          | POST /balances/sync-from-hcm | ReadyOn becomes 6              |
| Batch sync multiple records | HCM has multiple balances      | Sync                         | All balances upserted          |
| Batch sync failure          | HCM failure mode SERVER\_ERROR | Sync                         | Returns failure and logs error |

### 20.3 Request Lifecycle E2E Tests

| Test Case                                                               | Setup                             | Expected Result                                      |
| ----------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| Employee creates request with enough balance                            | HCM balance = 10, requestedDays = 2     | Request created pending approval                     |
| Employee creates request with stale ReadyOn cache but HCM enough        | ReadyOn = 1, HCM = 10             | Request may succeed after realtime refresh           |
| Employee creates request with ReadyOn cache enough but HCM insufficient | ReadyOn = 10, HCM = 1             | Request rejected                                     |
| Manager approves valid request                                          | Request pending, HCM balance = 10 | Request approved, HCM balance = 8, ReadyOn cache = 8 |
| Manager approves after HCM balance changed lower                        | Request = 2, HCM changed to 1     | Approval rejected                                    |
| Manager rejects request                                                 | Pending request                   | Request becomes rejected, HCM unchanged              |
| Employee cancels pending request                                      | Pending, matching `employeeId`    | `CANCELLED`; HCM balance unchanged                   |
| Cancel with wrong `employeeId`                                          | Pending                         | `403`                                                |
| Approve after cancel                                                    | Cancelled request               | `409` / not approvable                               |
| Cancel after approve                                                    | Approved request                | `409` / not cancellable                              |

### 20.4 Duplicate and Race-Like E2E Tests

| Test Case                            | Setup                             | Expected Result                                |
| ------------------------------------ | --------------------------------- | ---------------------------------------------- |
| Duplicate approval call              | One pending request, balance = 10 | HCM deducts only once                          |
| Two requests exceed combined balance | Balance = 5, two requests of 3    | First approval succeeds, second fails          |
| Retry after HCM timeout              | HCM timeout first, normal second  | No duplicate deduction; final state consistent |

### 20.5 Defensive HCM Tests

| Test Case                                     | Setup                                                               | Expected Result                     |
| --------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| HCM malformed response                        | Mock mode MALFORMED\_RESPONSE                                       | ReadyOn rejects safely              |
| HCM server error                              | Mock mode SERVER\_ERROR                                             | ReadyOn returns HCM unavailable     |
| HCM incorrectly allows insufficient deduction | Mock mode IGNORE\_INSUFFICIENT\_BALANCE and HCM balance < requested | ReadyOn pre-check prevents approval |

---

## 21. Coverage Expectations

Target coverage:

```text
Statements: 80%+
Branches: 75%+
Functions: 80%+
Lines: 80%+
```

Coverage proof should be included in the repository README or generated coverage report.

The most important coverage is not raw percentage. The test suite must prove correctness for:

1. Stale balance handling.
2. HCM source-of-truth validation.
3. Batch sync reconciliation.
4. Duplicate approval protection.
5. HCM failure safety.
6. Invalid dimension handling.
7. Insufficient balance handling.

---

## 22. Suggested Repository Structure

```text
readyon-timeoff-service/
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
      http-hcm-client.service.ts
      hcm-sync-types.ts
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
  package.json
```

---

## 23. Implementation Sequence

Recommended development order:

1. Create NestJS project.
2. Configure SQLite and TypeORM.
3. Define entities.
4. Implement mock HCM module.
5. Implement HCM client abstraction.
6. Implement balance sync service.
7. Implement time-off request creation.
8. Implement manager approval, rejection, and employee cancellation.
9. Add unit tests.
10. Add e2e tests.
11. Add failure mode simulation.
12. Add README with run instructions and coverage proof.

---

## 24. Acceptance Criteria

The implementation is complete when:

1. Employee can retrieve cached balance.
2. Employee can refresh balance from HCM.
3. Employee can create a valid time-off request.
4. Employee cannot create a request with invalid dimensions or insufficient HCM balance.
5. Manager can approve a pending request.
6. Approval files usage into HCM.
7. Local ReadyOn balance is updated after HCM filing.
8. Manager cannot approve rejected, cancelled, or already approved requests in a way that double-deducts balance.
9. Batch sync updates local ReadyOn balances from HCM.
10. Mock HCM can simulate independent balance changes.
11. Mock HCM can simulate insufficient balance, invalid dimensions, timeout, server error, and malformed responses.
12. Unit and e2e tests pass.
13. Coverage report is generated.
14. README explains how to run the service, tests, and coverage.
15. Employee can cancel their own `PENDING_APPROVAL` request (`CANCELLED` is terminal); mismatched `employeeId` is rejected with `403`; non-pending cancellation attempts receive `409`.

---

## 25. Key Design Summary

The selected design uses a hybrid sync strategy:

- ReadyOn keeps local cached balances for performance and user experience.
- HCM remains the source of truth.
- Realtime HCM validation is required before request creation and manager approval.
- Batch sync reconciles local cache with HCM snapshots.
- A stateful mock HCM service with separate tables and APIs simulates real external system behavior.
- Unit tests mock HCM responses directly for speed.
- E2E tests use the mock HCM API and database for realistic sync and failure scenarios.

This design balances correctness, testability, and implementation simplicity for the take-home scope while leaving a clear path toward production-grade improvements.

