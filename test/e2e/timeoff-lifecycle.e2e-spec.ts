import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { MockHcmFailureMode } from '../../src/mock-hcm/mock-hcm-failure-mode';
import { ErrorCodes } from '../../src/common/error-codes';
import { createE2eApp } from './setup-app';

const e2eVerbose = process.env.E2E_VERBOSE === '1';
let detailTestName = 'unknown test';
let detailLines: string[] = [];
/** Only the concurrency / race E2E tests emit buffered detail logs in E2E_VERBOSE mode. */
let detailFlushEnabled = false;

function isConcurrencyDetailTest(fullName: string): boolean {
  const markers = [
    'serialize via approval lock',
    'two different requests for same employee/location: only one approval',
    'two managers approve the same request concurrently',
    'two managers reject the same request concurrently',
    'one manager approves and another rejects the same request concurrently',
  ];
  return markers.some((m) => fullName.includes(m));
}

/** One-line summary of a Supertest response for verbose E2E logs. */
function httpBrief(res: { status: number; body?: unknown }): string {
  const bits = [`HTTP ${res.status}`];
  if (res.body && typeof res.body === 'object' && res.body !== null) {
    const b = res.body as Record<string, unknown>;
    if (typeof b.status === 'string') {
      bits.push(`record ${b.status}`);
    }
    if (typeof b.errorCode === 'string') {
      bits.push(`error ${b.errorCode}`);
    }
    if (typeof b.message === 'string' && b.message.length < 120) {
      bits.push(b.message);
    }
  }
  return bits.join(' · ');
}

const dlog = (title: string, lines?: string | readonly string[]) => {
  if (!e2eVerbose || !detailFlushEnabled) {
    return;
  }
  detailLines.push(`▸ ${title}`);
  if (lines == null) {
    return;
  }
  const list = typeof lines === 'string' ? [lines] : [...lines];
  for (const line of list) {
    detailLines.push(`  ${line}`);
  }
};

describe('Time-off lifecycle (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    if (e2eVerbose) {
      detailTestName = expect.getState().currentTestName ?? 'unknown test';
      detailLines = [];
      detailFlushEnabled = isConcurrencyDetailTest(detailTestName);
    } else {
      detailFlushEnabled = false;
    }
    app = await createE2eApp();
    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.NONE })
      .expect(200);
  });

  afterEach(async () => {
    if (e2eVerbose) {
      if (detailFlushEnabled && detailLines.length > 0) {
        // One console call so Jest prints a single block (not one stack frame per line).
        const block = [
          `[e2e:detail] ${detailTestName}`,
          ...detailLines.map((line) => `[e2e:detail] ${line}`),
        ].join('\n');

        console.log(block);
      } else {
        // Every other test: title only (no buffered detail lines).

        console.log(`[e2e:detail] ${detailTestName}`);
      }
    }
    await app.close();
  });

  async function seedHcm(
    employeeId: string,
    locationId: string,
    days: number,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId,
        locationId,
        availableDays: days,
        isValid: true,
      })
      .expect(200);
  }

  it('employee creates request with enough HCM balance', async () => {
    await seedHcm('E100', 'L100', 10);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E100',
        locationId: 'L100',
        requestedDays: 2,
      })
      .expect(200);

    expect(created.body.status).toBe('PENDING_APPROVAL');
    expect(created.body.requestId).toBeDefined();
  });

  it('decimal requestedDays round-trip on create, GET, approve, and HCM balance', async () => {
    await seedHcm('E-DEC-REQ', 'L-DEC-REQ', 9.5);
    const requestedDays = 1.25;

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E-DEC-REQ',
        locationId: 'L-DEC-REQ',
        requestedDays,
      })
      .expect(200);

    expect(created.body.status).toBe('PENDING_APPROVAL');
    expect(created.body.requestedDays).toBeCloseTo(requestedDays, 4);

    const fetched = await request(app.getHttpServer())
      .get(`/time-off-requests/${created.body.requestId}`)
      .expect(200);

    expect(fetched.body.requestedDays).toBeCloseTo(requestedDays, 4);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/approve`)
      .send({ managerId: 'M1' })
      .expect(200);

    const hcmBal = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E-DEC-REQ', locationId: 'L-DEC-REQ' })
      .expect(200);

    expect(hcmBal.body.availableDays).toBeCloseTo(9.5 - requestedDays, 4);
  });

  it('create succeeds when ReadyOn cache is stale but HCM has enough balance', async () => {
    await seedHcm('E101', 'L101', 1);
    await request(app.getHttpServer())
      .post('/balances/sync-from-hcm')
      .expect(200);

    const staleRead = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'E101', locationId: 'L101', refresh: false })
      .expect(200);
    expect(staleRead.body.availableDays).toBe(1);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E101',
        locationId: 'L101',
        availableDays: 10,
        isValid: true,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E101',
        locationId: 'L101',
        requestedDays: 3,
      })
      .expect(200);
  });

  it('create fails when cache looks ok but HCM is insufficient', async () => {
    await seedHcm('E102', 'L102', 1);

    await request(app.getHttpServer())
      .post('/balances/sync-from-hcm')
      .expect(200);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E102',
        locationId: 'L102',
        availableDays: 1,
        isValid: true,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E102',
        locationId: 'L102',
        availableDays: 0.5,
        isValid: true,
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E102',
        locationId: 'L102',
        requestedDays: 2,
      })
      .expect(409);

    expect(res.body.message?.errorCode ?? res.body.errorCode).toBeDefined();
  });

  it('manager approves and deducts HCM once', async () => {
    await seedHcm('E103', 'L103', 10);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E103',
        locationId: 'L103',
        requestedDays: 2,
      })
      .expect(200);

    const approve = await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/approve`)
      .send({ managerId: 'M1' })
      .expect(200);

    expect(approve.body.status).toBe('APPROVED');
    expect(approve.body.remainingDays).toBe(8);

    const hcmBal = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E103', locationId: 'L103' })
      .expect(200);

    expect(hcmBal.body.availableDays).toBe(8);
  });

  it('manager cannot approve when HCM balance dropped before approval', async () => {
    await seedHcm('E104', 'L104', 10);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E104',
        locationId: 'L104',
        requestedDays: 5,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E104',
        locationId: 'L104',
        availableDays: 1,
        isValid: true,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/approve`)
      .send({ managerId: 'M1' })
      .expect(409);
  });

  it('manager rejects pending request', async () => {
    await seedHcm('E105', 'L105', 10);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E105',
        locationId: 'L105',
        requestedDays: 2,
      })
      .expect(200);

    const rej = await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/reject`)
      .send({ managerId: 'M1', reason: 'coverage' })
      .expect(200);

    expect(rej.body.status).toBe('REJECTED');

    const hcmBal = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E105', locationId: 'L105' })
      .expect(200);

    expect(hcmBal.body.availableDays).toBe(10);
  });

  it('duplicate approve does not double deduct', async () => {
    await seedHcm('E106', 'L106', 10);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E106',
        locationId: 'L106',
        requestedDays: 2,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/approve`)
      .send({ managerId: 'M1' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/approve`)
      .send({ managerId: 'M1' })
      .expect(200);

    const hcmBal = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E106', locationId: 'L106' })
      .expect(200);

    expect(hcmBal.body.availableDays).toBe(8);
  });

  it('two approvals compete for balance', async () => {
    await seedHcm('E107', 'L107', 5);

    const a = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E107',
        locationId: 'L107',
        requestedDays: 3,
      })
      .expect(200);

    const b = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E107',
        locationId: 'L107',
        requestedDays: 3,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${a.body.requestId}/approve`)
      .send({ managerId: 'M1' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${b.body.requestId}/approve`)
      .send({ managerId: 'M1' })
      .expect(409);
  });

  it('create returns 503 when HCM server error', async () => {
    await seedHcm('E109', 'L109', 10);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.SERVER_ERROR })
      .expect(200);

    await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E109',
        locationId: 'L109',
        requestedDays: 1,
      })
      .expect(503);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.NONE })
      .expect(200);
  });

  it('create returns error when HCM malformed response', async () => {
    await seedHcm('E110', 'L110', 10);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.MALFORMED_RESPONSE })
      .expect(200);

    await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E110',
        locationId: 'L110',
        requestedDays: 1,
      })
      .expect(502);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.NONE })
      .expect(200);
  });

  it('ReadyOn blocks approval when mock ignores insufficient balance', async () => {
    await seedHcm('E111', 'L111', 1);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E111',
        locationId: 'L111',
        requestedDays: 1,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E111',
        locationId: 'L111',
        availableDays: 0.2,
        isValid: true,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.IGNORE_INSUFFICIENT_BALANCE })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/approve`)
      .send({ managerId: 'M1' })
      .expect(409);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.NONE })
      .expect(200);
  });

  it('employee cancels pending request with matching employeeId', async () => {
    await seedHcm('E120', 'L120', 10);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E120',
        locationId: 'L120',
        requestedDays: 2,
      })
      .expect(200);

    const cancelled = await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/cancel`)
      .send({ employeeId: 'E120' })
      .expect(200);

    expect(cancelled.body.status).toBe('CANCELLED');

    const hcmBal = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E120', locationId: 'L120' })
      .expect(200);

    expect(hcmBal.body.availableDays).toBe(10);
  });

  it('cancel returns 403 when employeeId does not own the request', async () => {
    await seedHcm('E121', 'L121', 10);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E121',
        locationId: 'L121',
        requestedDays: 1,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/cancel`)
      .send({ employeeId: 'E_OTHER' })
      .expect(403);
  });

  it('cannot approve after cancel', async () => {
    await seedHcm('E122', 'L122', 10);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E122',
        locationId: 'L122',
        requestedDays: 2,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/cancel`)
      .send({ employeeId: 'E122' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/approve`)
      .send({ managerId: 'M1' })
      .expect(409);
  });

  it('cannot cancel after approve', async () => {
    await seedHcm('E123', 'L123', 10);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E123',
        locationId: 'L123',
        requestedDays: 1,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/approve`)
      .send({ managerId: 'M1' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.requestId}/cancel`)
      .send({ employeeId: 'E123' })
      .expect(409);
  });

  it('create succeeds after transient HCM TIMEOUT then retry succeeds', async () => {
    const prevT = process.env.HCM_TIMEOUT_MS;
    process.env.HCM_TIMEOUT_MS = '1500';
    try {
      await seedHcm('E_TIMEOUT_CREATE', 'L_TIMEOUT_CREATE', 10);

      await request(app.getHttpServer())
        .post('/mock-hcm/test/failure-mode')
        .send({ mode: MockHcmFailureMode.TIMEOUT })
        .expect(200);

      const fail = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'E_TIMEOUT_CREATE',
          locationId: 'L_TIMEOUT_CREATE',
          requestedDays: 1,
        })
        .expect(503);
      expect(fail.body.errorCode).toBe(ErrorCodes.HCM_UNAVAILABLE);

      await request(app.getHttpServer())
        .post('/mock-hcm/test/failure-mode')
        .send({ mode: MockHcmFailureMode.NONE })
        .expect(200);

      const ok = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'E_TIMEOUT_CREATE',
          locationId: 'L_TIMEOUT_CREATE',
          requestedDays: 1,
        })
        .expect(200);
      expect(ok.body.status).toBe('PENDING_APPROVAL');
    } finally {
      process.env.HCM_TIMEOUT_MS = prevT;
    }
  }, 25_000);

  it('approve succeeds after transient HCM TIMEOUT on first attempt', async () => {
    const prevT = process.env.HCM_TIMEOUT_MS;
    process.env.HCM_TIMEOUT_MS = '1500';
    try {
      await seedHcm('E_TIMEOUT_APPR', 'L_TIMEOUT_APPR', 10);
      const created = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'E_TIMEOUT_APPR',
          locationId: 'L_TIMEOUT_APPR',
          requestedDays: 2,
        })
        .expect(200);

      const requestId = created.body.requestId as string;

      await request(app.getHttpServer())
        .post('/mock-hcm/test/failure-mode')
        .send({ mode: MockHcmFailureMode.TIMEOUT })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/time-off-requests/${requestId}/approve`)
        .send({ managerId: 'M1' })
        .expect(503);

      const pending = await request(app.getHttpServer())
        .get(`/time-off-requests/${requestId}`)
        .expect(200);
      expect(pending.body.status).toBe('PENDING_APPROVAL');

      await request(app.getHttpServer())
        .post('/mock-hcm/test/failure-mode')
        .send({ mode: MockHcmFailureMode.NONE })
        .expect(200);

      const approved = await request(app.getHttpServer())
        .post(`/time-off-requests/${requestId}/approve`)
        .send({ managerId: 'M1' })
        .expect(200);
      expect(approved.body.status).toBe('APPROVED');
    } finally {
      process.env.HCM_TIMEOUT_MS = prevT;
    }
  }, 35_000);

  it('GET /employees/:id/time-off-requests lists and filters by status and locationId', async () => {
    await seedHcm('E_LIST', 'L_LIST_A', 10);
    await seedHcm('E_LIST', 'L_LIST_B', 10);

    const a = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E_LIST',
        locationId: 'L_LIST_A',
        requestedDays: 1,
      })
      .expect(200);

    const b = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E_LIST',
        locationId: 'L_LIST_B',
        requestedDays: 1,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${a.body.requestId}/approve`)
      .send({ managerId: 'M1' })
      .expect(200);

    const all = await request(app.getHttpServer())
      .get('/employees/E_LIST/time-off-requests')
      .expect(200);

    expect(Array.isArray(all.body)).toBe(true);
    expect(all.body.length).toBeGreaterThanOrEqual(2);

    const pendingOnly = await request(app.getHttpServer())
      .get('/employees/E_LIST/time-off-requests')
      .query({ status: 'PENDING_APPROVAL' })
      .expect(200);

    const pendingRows = pendingOnly.body as Array<{
      status: string;
      requestId: string;
    }>;
    expect(pendingRows.every((r) => r.status === 'PENDING_APPROVAL')).toBe(
      true,
    );
    expect(pendingRows.some((r) => r.requestId === b.body.requestId)).toBe(
      true,
    );

    const locA = await request(app.getHttpServer())
      .get('/employees/E_LIST/time-off-requests')
      .query({ locationId: 'L_LIST_A' })
      .expect(200);

    const locRows = locA.body as Array<{ locationId: string }>;
    expect(locRows.every((r) => r.locationId === 'L_LIST_A')).toBe(true);
  });

  it('GET /employees/:id/time-off-requests returns empty array for employee with no requests', async () => {
    const res = await request(app.getHttpServer())
      .get('/employees/E_NO_REQUESTS/time-off-requests')
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('create returns 400 when body fails validation', async () => {
    const missing = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        locationId: 'L400',
        requestedDays: 1,
      })
      .expect(400);
    expect(missing.body.statusCode).toBe(400);

    const zeroDays = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E400',
        locationId: 'L400',
        requestedDays: 0,
      })
      .expect(400);
    expect(zeroDays.body.statusCode).toBe(400);
  });

  it('approve and reject return 400 when managerId is missing', async () => {
    await seedHcm('E400MGR', 'L400MGR', 10);
    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E400MGR',
        locationId: 'L400MGR',
        requestedDays: 1,
      })
      .expect(200);

    const id = created.body.requestId as string;

    await request(app.getHttpServer())
      .post(`/time-off-requests/${id}/approve`)
      .send({})
      .expect(400);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${id}/reject`)
      .send({})
      .expect(400);
  });

  it('GET and mutations return 404 for unknown requestId', async () => {
    await request(app.getHttpServer())
      .get('/time-off-requests/REQ_does_not_exist_zzzz')
      .expect(404);

    const nf = await request(app.getHttpServer())
      .post('/time-off-requests/REQ_does_not_exist_zzzz/approve')
      .send({ managerId: 'M1' })
      .expect(404);
    expect(nf.body.errorCode).toBe(ErrorCodes.REQUEST_NOT_FOUND);

    await request(app.getHttpServer())
      .post('/time-off-requests/REQ_does_not_exist_zzzz/reject')
      .send({ managerId: 'M1' })
      .expect(404);

    await request(app.getHttpServer())
      .post('/time-off-requests/REQ_does_not_exist_zzzz/cancel')
      .send({ employeeId: 'E1' })
      .expect(404);
  });

  it('reject after approve and approve after reject return 409', async () => {
    await seedHcm('E409FLOW', 'L409FLOW', 10);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E409FLOW',
        locationId: 'L409FLOW',
        requestedDays: 1,
      })
      .expect(200);

    const id = created.body.requestId as string;

    await request(app.getHttpServer())
      .post(`/time-off-requests/${id}/approve`)
      .send({ managerId: 'M1' })
      .expect(200);

    const rejAfter = await request(app.getHttpServer())
      .post(`/time-off-requests/${id}/reject`)
      .send({ managerId: 'M2', reason: 'late' })
      .expect(409);
    expect(rejAfter.body.errorCode).toBe(ErrorCodes.REQUEST_NOT_APPROVABLE);

    const created2 = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E409FLOW',
        locationId: 'L409FLOW',
        requestedDays: 1,
      })
      .expect(200);

    const id2 = created2.body.requestId as string;

    await request(app.getHttpServer())
      .post(`/time-off-requests/${id2}/reject`)
      .send({ managerId: 'M1', reason: 'no' })
      .expect(200);

    const apprAfter = await request(app.getHttpServer())
      .post(`/time-off-requests/${id2}/approve`)
      .send({ managerId: 'M1' })
      .expect(409);
    expect(apprAfter.body.errorCode).toBe(ErrorCodes.REQUEST_NOT_APPROVABLE);
  });

  it('cancel after reject returns 409', async () => {
    await seedHcm('E409CAN', 'L409CAN', 10);

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E409CAN',
        locationId: 'L409CAN',
        requestedDays: 1,
      })
      .expect(200);

    const id = created.body.requestId as string;

    await request(app.getHttpServer())
      .post(`/time-off-requests/${id}/reject`)
      .send({ managerId: 'M1', reason: 'x' })
      .expect(200);

    const can = await request(app.getHttpServer())
      .post(`/time-off-requests/${id}/cancel`)
      .send({ employeeId: 'E409CAN' })
      .expect(409);
    expect(can.body.errorCode).toBe(ErrorCodes.REQUEST_NOT_CANCELLABLE);
  });

  it('concurrent approvals for 2 request with same employee-location serialize via approval lock, the blance can fulfill both requests both requests', async () => {
    await seedHcm('E200', 'L200', 10);

    if (detailFlushEnabled) {
      const before = await request(app.getHttpServer())
        .get('/mock-hcm/balances')
        .query({ employeeId: 'E200', locationId: 'L200' });
      dlog('Mock HCM before concurrent approves', [
        'Employee E200 @ location L200',
        `${before.body.availableDays} days available (expect 10 right after seed)`,
      ]);
    }

    const a = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E200',
        locationId: 'L200',
        requestedDays: 2,
      })
      .expect(200);

    const b = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E200',
        locationId: 'L200',
        requestedDays: 2,
      })
      .expect(200);

    dlog('Two separate requests (2 days each)', [
      `Request A: ${a.body.requestId}`,
      `Request B: ${b.body.requestId}`,
    ]);

    const [ra, rb] = await Promise.all([
      request(app.getHttpServer())
        .post(`/time-off-requests/${a.body.requestId}/approve`)
        .send({ managerId: 'M1' }),
      request(app.getHttpServer())
        .post(`/time-off-requests/${b.body.requestId}/approve`)
        .send({ managerId: 'M1' }),
    ]);

    dlog('Concurrent approve — both should win (serialized lock)', [
      `Approve A: ${httpBrief(ra)}`,
      `Approve B: ${httpBrief(rb)}`,
    ]);

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);

    const hcmBal = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E200', locationId: 'L200' })
      .expect(200);

    dlog(
      'Mock HCM after both requests approved',
      `${hcmBal.body.availableDays} days left (10 − 2 − 2 → expect 6)`,
    );

    expect(hcmBal.body.availableDays).toBe(6);
  });

  it('two different requests for same employee/location: only one approval succeeds when balance fits one', async () => {
    await seedHcm('E200Y', 'L200Y', 3);

    if (detailFlushEnabled) {
      const before = await request(app.getHttpServer())
        .get('/mock-hcm/balances')
        .query({ employeeId: 'E200Y', locationId: 'L200Y' });
      dlog('Mock HCM before competing approvals', [
        'Employee E200Y @ location L200Y',
        `${before.body.availableDays} days available`,
      ]);
    }

    const first = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E200Y',
        locationId: 'L200Y',
        requestedDays: 2,
      })
      .expect(200);

    const second = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E200Y',
        locationId: 'L200Y',
        requestedDays: 2,
      })
      .expect(200);

    dlog('Two pending requests compete for remaining balance', [
      `Request 1: ${first.body.requestId}`,
      `Request 2: ${second.body.requestId}`,
      'Only one can be approved because available is 3 and each needs 2',
    ]);

    const [approve1, approve2] = await Promise.all([
      request(app.getHttpServer())
        .post(`/time-off-requests/${first.body.requestId}/approve`)
        .send({ managerId: 'M1' }),
      request(app.getHttpServer())
        .post(`/time-off-requests/${second.body.requestId}/approve`)
        .send({ managerId: 'M1' }),
    ]);

    dlog('Concurrent approvals outcome', [
      `Request 1: ${httpBrief(approve1)}`,
      `Request 2: ${httpBrief(approve2)}`,
      'Expect one HTTP 200 and one HTTP 409',
    ]);

    const statuses = [approve1.status, approve2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const finalBalance = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E200Y', locationId: 'L200Y' })
      .expect(200);

    dlog(
      'Mock HCM after competing approvals',
      `${finalBalance.body.availableDays} days left (3 − 2 → expect 1)`,
    );

    expect(finalBalance.body.availableDays).toBe(1);
  });

  it('two managers approve the same request concurrently; second is idempotent', async () => {
    await seedHcm('E201', 'L201', 10);

    if (detailFlushEnabled) {
      const before = await request(app.getHttpServer())
        .get('/mock-hcm/balances')
        .query({ employeeId: 'E201', locationId: 'L201' });
      dlog('Mock HCM after seed', [
        'Employee E201 @ location L201',
        `${before.body.availableDays} days available`,
      ]);
    }

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E201',
        locationId: 'L201',
        requestedDays: 2,
      })
      .expect(200);

    const requestId = created.body.requestId as string;

    dlog('Single pending request', [
      `id ${requestId}`,
      `status ${created.body.status} · 2 days requested`,
    ]);

    const [r1, r2] = await Promise.all([
      request(app.getHttpServer())
        .post(`/time-off-requests/${requestId}/approve`)
        .send({ managerId: 'M1' }),
      request(app.getHttpServer())
        .post(`/time-off-requests/${requestId}/approve`)
        .send({ managerId: 'M2' }),
    ]);

    dlog('Same request approved twice in parallel (idempotent)', [
      `Manager M1: ${httpBrief(r1)} · hcmTransactionId ${String(r1.body?.hcmTransactionId ?? '—')}`,
      `Manager M2: ${httpBrief(r2)} · hcmTransactionId ${String(r2.body?.hcmTransactionId ?? '—')}`,
      '(both HTTP 200; second must reuse the same HCM transaction id)',
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.status).toBe('APPROVED');
    expect(r2.body.status).toBe('APPROVED');
    expect(r1.body.hcmTransactionId).toBe(r2.body.hcmTransactionId);

    if (detailFlushEnabled) {
      const getReq = await request(app.getHttpServer())
        .get(`/time-off-requests/${requestId}`)
        .expect(200);

      dlog('Persisted request after dual approve', [
        `GET /time-off-requests/${requestId}`,
        `status ${getReq.body.status} · requestedDays ${getReq.body.requestedDays}`,
      ]);
    }

    const hcmBal = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E201', locationId: 'L201' })
      .expect(200);

    dlog(
      'Mock HCM after single usage filed',
      `${hcmBal.body.availableDays} days left (10 − 2 → expect 8)`,
    );

    expect(hcmBal.body.availableDays).toBe(8);
  });

  it('two managers reject the same request concurrently; ends REJECTED once', async () => {
    await seedHcm('E202', 'L202', 10);

    if (detailFlushEnabled) {
      const before = await request(app.getHttpServer())
        .get('/mock-hcm/balances')
        .query({ employeeId: 'E202', locationId: 'L202' });
      dlog('Mock HCM after seed', [
        'Employee E202 @ location L202',
        `${before.body.availableDays} days available`,
      ]);
    }

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E202',
        locationId: 'L202',
        requestedDays: 2,
      })
      .expect(200);

    const requestId = created.body.requestId as string;

    dlog('Pending request before concurrent rejects', [
      `id ${requestId}`,
      `status ${created.body.status}`,
    ]);

    const [r1, r2] = await Promise.all([
      request(app.getHttpServer())
        .post(`/time-off-requests/${requestId}/reject`)
        .send({ managerId: 'M1', reason: 'first' }),
      request(app.getHttpServer())
        .post(`/time-off-requests/${requestId}/reject`)
        .send({ managerId: 'M2', reason: 'second' }),
    ]);

    dlog('Concurrent reject — one succeeds, duplicate may be 409', [
      `Manager M1 (reason "first"):  ${httpBrief(r1)}`,
      `Manager M2 (reason "second"): ${httpBrief(r2)}`,
    ]);

    expect([r1.status, r2.status].every((s) => s === 200 || s === 409)).toBe(
      true,
    );
    expect([r1.status, r2.status].some((s) => s === 200)).toBe(true);
    if (r1.status === 200) {
      expect(r1.body.status).toBe('REJECTED');
    }
    if (r2.status === 200) {
      expect(r2.body.status).toBe('REJECTED');
    }

    const get = await request(app.getHttpServer())
      .get(`/time-off-requests/${requestId}`)
      .expect(200);

    dlog('Persisted request after rejects', [
      `GET /time-off-requests/${requestId}`,
      `status ${get.body.status} · managerId ${get.body.managerId ?? '—'}`,
    ]);

    expect(get.body.status).toBe('REJECTED');

    const hcmBal = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E202', locationId: 'L202' })
      .expect(200);

    dlog(
      'Mock HCM after reject (no usage filed)',
      `${hcmBal.body.availableDays} days — unchanged from seed (expect 10)`,
    );

    expect(hcmBal.body.availableDays).toBe(10);
  });

  it('one manager approves and another rejects the same request concurrently; exactly one wins', async () => {
    await seedHcm('E203', 'L203', 10);

    if (detailFlushEnabled) {
      const before = await request(app.getHttpServer())
        .get('/mock-hcm/balances')
        .query({ employeeId: 'E203', locationId: 'L203' });
      dlog('Mock HCM after seed', [
        'Employee E203 @ location L203',
        `${before.body.availableDays} days available`,
      ]);
    }

    const created = await request(app.getHttpServer())
      .post('/time-off-requests')
      .send({
        employeeId: 'E203',
        locationId: 'L203',
        requestedDays: 2,
      })
      .expect(200);

    const requestId = created.body.requestId as string;

    dlog('Pending request — approve vs reject race', [
      `id ${requestId}`,
      `status ${created.body.status}`,
    ]);

    const [approveRes, rejectRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/time-off-requests/${requestId}/approve`)
        .send({ managerId: 'M1' }),
      request(app.getHttpServer())
        .post(`/time-off-requests/${requestId}/reject`)
        .send({ managerId: 'M2', reason: 'coverage' }),
    ]);

    dlog('Concurrent approve (M1) vs reject (M2)', [
      `Approve: ${httpBrief(approveRes)}`,
      `Reject:  ${httpBrief(rejectRes)}`,
      'Expect one HTTP 200 and one HTTP 409 (loser)',
    ]);

    const statuses = [approveRes.status, rejectRes.status].sort(
      (a, b) => a - b,
    );
    expect(statuses).toEqual([200, 409]);

    const get = await request(app.getHttpServer())
      .get(`/time-off-requests/${requestId}`)
      .expect(200);

    dlog('Winner recorded in DB', [
      `GET /time-off-requests/${requestId}`,
      `final status ${get.body.status} · requestedDays ${get.body.requestedDays}`,
    ]);

    expect(['APPROVED', 'REJECTED']).toContain(get.body.status);

    const hcmBal = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E203', locationId: 'L203' })
      .expect(200);

    dlog(
      'Mock HCM after race',
      get.body.status === 'APPROVED'
        ? `${hcmBal.body.availableDays} days (approved → expect 8)`
        : `${hcmBal.body.availableDays} days (rejected → no deduction, expect 10)`,
    );

    if (get.body.status === 'APPROVED') {
      expect(hcmBal.body.availableDays).toBe(8);
    } else {
      expect(hcmBal.body.availableDays).toBe(10);
    }
  });
});
