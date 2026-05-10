import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosError, AxiosHeaders } from 'axios';
import { HttpHcmClient } from '../../src/hcm/http-hcm-client.service';

describe('HttpHcmClient', () => {
  let client: HttpHcmClient;
  let http: { get: jest.Mock; post: jest.Mock };

  beforeEach(async () => {
    http = { get: jest.fn(), post: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [HttpHcmClient, { provide: HttpService, useValue: http }],
    }).compile();
    client = moduleRef.get(HttpHcmClient);
  });

  describe('getBalance', () => {
    it('returns balance when response shape is valid', async () => {
      http.get.mockReturnValue(
        of({
          status: 200,
          data: {
            employeeId: 'E1',
            locationId: 'L1',
            availableDays: 12,
            version: 3,
          },
        }),
      );
      const r = await client.getBalance('E1', 'L1');
      expect(r).toEqual({
        type: 'balance',
        employeeId: 'E1',
        locationId: 'L1',
        availableDays: 12,
        version: 3,
      });
    });

    it('returns invalid_dimension when errorCode set', async () => {
      http.get.mockReturnValue(
        of({
          status: 200,
          data: { errorCode: 'INVALID_DIMENSION', message: 'no row' },
        }),
      );
      const r = await client.getBalance('X', 'Y');
      expect(r).toEqual({
        type: 'invalid_dimension',
        message: 'no row',
      });
    });

    it('uses default message when INVALID_DIMENSION without string message', async () => {
      http.get.mockReturnValue(
        of({
          status: 200,
          data: { errorCode: 'INVALID_DIMENSION', message: 123 },
        }),
      );
      const r = await client.getBalance('X', 'Y');
      expect(r.type).toBe('invalid_dimension');
      if (r.type === 'invalid_dimension') {
        expect(r.message).toBe('Invalid dimension');
      }
    });

    it('returns transport UNAVAILABLE on HTTP 503', async () => {
      http.get.mockReturnValue(of({ status: 503, data: {} }));
      const r = await client.getBalance('E', 'L');
      expect(r).toEqual({ type: 'transport', code: 'UNAVAILABLE' });
    });

    it('returns INVALID_RESPONSE when body is not an object', async () => {
      http.get.mockReturnValue(of({ status: 200, data: 'x' }));
      const r = await client.getBalance('E', 'L');
      expect(r).toEqual({ type: 'transport', code: 'INVALID_RESPONSE' });
    });

    it('returns INVALID_RESPONSE when balance fields incomplete', async () => {
      http.get.mockReturnValue(
        of({
          status: 200,
          data: { employeeId: 'E1', locationId: 'L1', availableDays: '12' },
        }),
      );
      const r = await client.getBalance('E1', 'L1');
      expect(r).toEqual({ type: 'transport', code: 'INVALID_RESPONSE' });
    });

    it('maps ECONNABORTED to UNAVAILABLE', async () => {
      const err = new AxiosError('aborted');
      err.code = 'ECONNABORTED';
      http.get.mockReturnValue(throwError(() => err));
      const r = await client.getBalance('E', 'L');
      expect(r).toEqual({ type: 'transport', code: 'UNAVAILABLE' });
    });

    it('maps timeout message to UNAVAILABLE', async () => {
      const err = new AxiosError('timeout of 5000ms exceeded');
      http.get.mockReturnValue(throwError(() => err));
      const r = await client.getBalance('E', 'L');
      expect(r).toEqual({ type: 'transport', code: 'UNAVAILABLE' });
    });

    it('maps 500 response in axios error to UNAVAILABLE', async () => {
      const err = new AxiosError('fail');
      err.response = {
        status: 502,
        data: {},
        statusText: '',
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
      http.get.mockReturnValue(throwError(() => err));
      const r = await client.getBalance('E', 'L');
      expect(r).toEqual({ type: 'transport', code: 'UNAVAILABLE' });
    });

    it('maps non-object response data to INVALID_RESPONSE', async () => {
      const err = new AxiosError('bad');
      err.response = {
        status: 400,
        data: 'plain text body',
        statusText: '',
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
      http.get.mockReturnValue(throwError(() => err));
      const r = await client.getBalance('E', 'L');
      expect(r).toEqual({ type: 'transport', code: 'INVALID_RESPONSE' });
    });

    it('returns UNAVAILABLE for unknown thrown errors', async () => {
      http.get.mockReturnValue(throwError(() => new Error('boom')));
      const r = await client.getBalance('E', 'L');
      expect(r).toEqual({ type: 'transport', code: 'UNAVAILABLE' });
    });
  });

  describe('submitTimeOffUsage', () => {
    const payload = {
      employeeId: 'E',
      locationId: 'L',
      days: 1,
      externalRequestId: 'REQ',
      idempotencyKey: 'k',
    };

    it('returns success with idempotentReplay when present', async () => {
      http.post.mockReturnValue(
        of({
          status: 200,
          data: {
            success: true,
            hcmTransactionId: 'T1',
            remainingDays: 4,
            idempotentReplay: true,
          },
        }),
      );
      const r = await client.submitTimeOffUsage(payload);
      expect(r).toEqual({
        type: 'success',
        hcmTransactionId: 'T1',
        remainingDays: 4,
        idempotentReplay: true,
      });
    });

    it('returns insufficient_balance with default message and balance 0', async () => {
      http.post.mockReturnValue(
        of({
          status: 200,
          data: { success: false },
        }),
      );
      const r = await client.submitTimeOffUsage(payload);
      expect(r).toEqual({
        type: 'insufficient_balance',
        message: 'Insufficient balance',
        currentBalance: 0,
      });
    });

    it('returns INVALID_RESPONSE when success true but missing fields', async () => {
      http.post.mockReturnValue(
        of({
          status: 200,
          data: { success: true, hcmTransactionId: 'T' },
        }),
      );
      const r = await client.submitTimeOffUsage(payload);
      expect(r).toEqual({ type: 'transport', code: 'INVALID_RESPONSE' });
    });

    it('returns UNAVAILABLE on HTTP 500 response body', async () => {
      http.post.mockReturnValue(of({ status: 500, data: {} }));
      const r = await client.submitTimeOffUsage(payload);
      expect(r).toEqual({ type: 'transport', code: 'UNAVAILABLE' });
    });

    it('maps unknown submit errors to UNAVAILABLE', async () => {
      http.post.mockReturnValue(throwError(() => new Error('x')));
      const r = await client.submitTimeOffUsage(payload);
      expect(r).toEqual({ type: 'transport', code: 'UNAVAILABLE' });
    });
  });

  describe('getBatchBalances', () => {
    it('returns ok with empty balances array', async () => {
      http.get.mockReturnValue(of({ status: 200, data: { balances: [] } }));
      const r = await client.getBatchBalances();
      expect(r).toEqual({ type: 'ok', balances: [] });
    });

    it('returns INVALID_RESPONSE when balances is not an array', async () => {
      http.get.mockReturnValue(of({ status: 200, data: { balances: {} } }));
      const r = await client.getBatchBalances();
      expect(r).toEqual({ type: 'transport', code: 'INVALID_RESPONSE' });
    });

    it('returns INVALID_RESPONSE when a row is malformed', async () => {
      http.get.mockReturnValue(
        of({
          status: 200,
          data: {
            balances: [
              {
                employeeId: 'E1',
                locationId: 'L1',
                availableDays: 1,
                version: 1,
              },
              { employeeId: 'E2' },
            ],
          },
        }),
      );
      const r = await client.getBatchBalances();
      expect(r).toEqual({ type: 'transport', code: 'INVALID_RESPONSE' });
    });

    it('returns UNAVAILABLE when catch has non-axios error', async () => {
      http.get.mockReturnValue(throwError(() => new Error('network')));
      const r = await client.getBatchBalances();
      expect(r).toEqual({ type: 'transport', code: 'UNAVAILABLE' });
    });
  });
});
