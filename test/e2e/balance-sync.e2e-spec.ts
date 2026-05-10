import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { MockHcmFailureMode } from '../../src/mock-hcm/mock-hcm-failure-mode';
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
});
