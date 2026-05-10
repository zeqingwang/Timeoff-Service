import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { MockHcmFailureMode } from '../../src/mock-hcm/mock-hcm-failure-mode';
import { createE2eApp } from './setup-app';

describe('Mock HCM (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await createE2eApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET balance returns seeded value', async () => {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E001',
        locationId: 'L001',
        availableDays: 10,
        isValid: true,
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E001', locationId: 'L001' })
      .expect(200);

    expect(res.body.availableDays).toBe(10);
    expect(res.body.version).toBeDefined();
  });

  it('GET balance returns invalid dimension when missing', async () => {
    const res = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'X', locationId: 'Y' })
      .expect(200);

    expect(res.body.errorCode).toBe('INVALID_DIMENSION');
  });

  it('POST usage deducts balance', async () => {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E001',
        locationId: 'L001',
        availableDays: 10,
        isValid: true,
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/mock-hcm/time-off-usages')
      .send({
        employeeId: 'E001',
        locationId: 'L001',
        days: 2,
        externalRequestId: 'REQ_A',
        idempotencyKey: 'k1',
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.remainingDays).toBe(8);
  });

  it('POST usage rejects insufficient balance', async () => {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E001',
        locationId: 'L001',
        availableDays: 1,
        isValid: true,
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/mock-hcm/time-off-usages')
      .send({
        employeeId: 'E001',
        locationId: 'L001',
        days: 3,
        externalRequestId: 'REQ_B',
        idempotencyKey: 'k2',
      })
      .expect(200);

    expect(res.body.success).toBe(false);
    expect(res.body.errorCode).toBe('INSUFFICIENT_BALANCE');
  });

  it('POST usage idempotent replay does not double deduct', async () => {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E001',
        locationId: 'L001',
        availableDays: 10,
        isValid: true,
      })
      .expect(200);

    const payload = {
      employeeId: 'E001',
      locationId: 'L001',
      days: 2,
      externalRequestId: 'REQ_C',
      idempotencyKey: 'same-key',
    };

    const first = await request(app.getHttpServer())
      .post('/mock-hcm/time-off-usages')
      .send(payload)
      .expect(200);

    const second = await request(app.getHttpServer())
      .post('/mock-hcm/time-off-usages')
      .send(payload)
      .expect(200);

    expect(first.body.hcmTransactionId).toBe(second.body.hcmTransactionId);
    expect(second.body.idempotentReplay).toBe(true);

    const bal = await request(app.getHttpServer())
      .get('/mock-hcm/balances')
      .query({ employeeId: 'E001', locationId: 'L001' })
      .expect(200);

    expect(bal.body.availableDays).toBe(8);
  });

  it('reset failure mode', async () => {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.TIMEOUT })
      .expect(200);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.NONE })
      .expect(200);
  });
});
