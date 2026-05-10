import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { MockHcmFailureMode } from '../../src/mock-hcm/mock-hcm-failure-mode';
import { createE2eApp } from './setup-app';

describe('Time-off lifecycle (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await createE2eApp();
    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.NONE })
      .expect(200);
  });

  afterEach(async () => {
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
});
