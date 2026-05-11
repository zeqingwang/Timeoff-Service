import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { MockHcmFailureMode } from '../../src/mock-hcm/mock-hcm-failure-mode';
import { ErrorCodes } from '../../src/common/error-codes';
import { createE2eApp } from './setup-app';

describe('Balance sync (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await createE2eApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('batch sync loads mock balances into ReadyOn cache', async () => {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E001',
        locationId: 'L001',
        availableDays: 12,
        isValid: true,
      })
      .expect(200);

    const syncRes = await request(app.getHttpServer())
      .post('/balances/sync-from-hcm')
      .expect(200);

    expect(syncRes.body.recordsUpserted).toBe(1);
    expect(syncRes.body.status).toMatch(/SUCCESS|FAILED/);

    const cached = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'E001', locationId: 'L001', refresh: false })
      .expect(200);

    expect(cached.body.availableDays).toBe(12);
    expect(cached.body.source).toBe('HCM_CACHE');
  });

  it('batch sync and GET /balances preserve decimal availableDays', async () => {
    const availableDays = 12.375;

    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E-DEC-BAL',
        locationId: 'L-DEC-BAL',
        availableDays,
        isValid: true,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/balances/sync-from-hcm')
      .expect(200);

    const cached = await request(app.getHttpServer())
      .get('/balances')
      .query({
        employeeId: 'E-DEC-BAL',
        locationId: 'L-DEC-BAL',
        refresh: false,
      })
      .expect(200);

    expect(cached.body.availableDays).toBeCloseTo(availableDays, 4);
    expect(cached.body.source).toBe('HCM_CACHE');

    const refreshed = await request(app.getHttpServer())
      .get('/balances')
      .query({
        employeeId: 'E-DEC-BAL',
        locationId: 'L-DEC-BAL',
        refresh: 'true',
      })
      .expect(200);

    expect(refreshed.body.availableDays).toBeCloseTo(availableDays, 4);
  });

  it('batch sync reconciles when HCM increases independently', async () => {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E002',
        locationId: 'L002',
        availableDays: 10,
        isValid: true,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/balances/sync-from-hcm')
      .expect(200);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E002',
        locationId: 'L002',
        availableDays: 15,
        isValid: true,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/balances/sync-from-hcm')
      .expect(200);

    const cached = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'E002', locationId: 'L002', refresh: false })
      .expect(200);

    expect(cached.body.availableDays).toBe(15);
  });

  it('batch sync reconciles when HCM decreases independently', async () => {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E003',
        locationId: 'L003',
        availableDays: 10,
        isValid: true,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/balances/sync-from-hcm')
      .expect(200);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E003',
        locationId: 'L003',
        availableDays: 6,
        isValid: true,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/balances/sync-from-hcm')
      .expect(200);

    const cached = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'E003', locationId: 'L003', refresh: false })
      .expect(200);

    expect(cached.body.availableDays).toBe(6);
  });

  it('batch sync fails when mock HCM returns server error', async () => {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.SERVER_ERROR })
      .expect(200);

    await request(app.getHttpServer())
      .post('/balances/sync-from-hcm')
      .expect(503);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.NONE })
      .expect(200);
  });

  it('batch sync upserts multiple HCM balances; GET balances matches each', async () => {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E_MULTI_A',
        locationId: 'L_MULTI_A',
        availableDays: 4.25,
        isValid: true,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/balances')
      .send({
        employeeId: 'E_MULTI_B',
        locationId: 'L_MULTI_B',
        availableDays: 7.5,
        isValid: true,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/balances/sync-from-hcm')
      .expect(200);

    const a = await request(app.getHttpServer())
      .get('/balances')
      .query({
        employeeId: 'E_MULTI_A',
        locationId: 'L_MULTI_A',
        refresh: false,
      })
      .expect(200);

    const b = await request(app.getHttpServer())
      .get('/balances')
      .query({
        employeeId: 'E_MULTI_B',
        locationId: 'L_MULTI_B',
        refresh: 'true',
      })
      .expect(200);

    expect(a.body.availableDays).toBeCloseTo(4.25, 4);
    expect(b.body.availableDays).toBeCloseTo(7.5, 4);
    expect(a.body.source).toBe('HCM_CACHE');
    expect(b.body.source).toBe('HCM_CACHE');
  });

  it('batch sync returns 502 when mock HCM batch response is malformed', async () => {
    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.MALFORMED_RESPONSE })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/balances/sync-from-hcm')
      .expect(502);

    expect(res.body.errorCode).toBe(ErrorCodes.HCM_INVALID_RESPONSE);

    await request(app.getHttpServer())
      .post('/mock-hcm/test/failure-mode')
      .send({ mode: MockHcmFailureMode.NONE })
      .expect(200);
  });

  it('GET /balances returns 400 when required query params are missing', async () => {
    const missingEmployee = await request(app.getHttpServer())
      .get('/balances')
      .query({ locationId: 'L1' })
      .expect(400);

    expect(missingEmployee.body.statusCode).toBe(400);

    const missingLocation = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'E1' })
      .expect(400);

    expect(missingLocation.body.statusCode).toBe(400);
  });
});
