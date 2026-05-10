import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { isAxiosError } from 'axios';
import type { HcmClient } from './hcm-client.interface';
import type {
  HcmBalanceResponse,
  HcmBatchBalancesResponse,
  HcmSubmitUsagePayload,
  HcmSubmitUsageResponse,
} from './hcm-client.types';

function resolveBaseUrl(): string {
  return (
    process.env.HCM_BASE_URL ??
    `http://127.0.0.1:${process.env.PORT ?? '3000'}/mock-hcm`
  );
}

function timeoutMs(): number {
  return Number(process.env.HCM_TIMEOUT_MS ?? 30000);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object';
}

@Injectable()
export class HttpHcmClient implements HcmClient {
  constructor(private readonly http: HttpService) {}

  async getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<HcmBalanceResponse> {
    const base = resolveBaseUrl();
    try {
      const response = await firstValueFrom(
        this.http.get(`${base.replace(/\/$/, '')}/balances`, {
          params: { employeeId, locationId },
          validateStatus: () => true,
          timeout: timeoutMs(),
        }),
      );
      const raw: unknown = response.data;
      if (response.status >= 500) {
        return { type: 'transport', code: 'UNAVAILABLE' };
      }
      if (!isRecord(raw)) {
        return { type: 'transport', code: 'INVALID_RESPONSE' };
      }
      if (raw['errorCode'] === 'INVALID_DIMENSION') {
        return {
          type: 'invalid_dimension',
          message:
            typeof raw['message'] === 'string'
              ? raw['message']
              : 'Invalid dimension',
        };
      }
      if (
        typeof raw['employeeId'] === 'string' &&
        typeof raw['locationId'] === 'string' &&
        typeof raw['availableDays'] === 'number' &&
        typeof raw['version'] === 'number'
      ) {
        return {
          type: 'balance',
          employeeId: raw['employeeId'],
          locationId: raw['locationId'],
          availableDays: raw['availableDays'],
          version: raw['version'],
        };
      }
      return { type: 'transport', code: 'INVALID_RESPONSE' };
    } catch (err: unknown) {
      return this.mapAxiosErrBalance(err);
    }
  }

  async submitTimeOffUsage(
    payload: HcmSubmitUsagePayload,
  ): Promise<HcmSubmitUsageResponse> {
    const base = resolveBaseUrl();
    try {
      const response = await firstValueFrom(
        this.http.post(`${base.replace(/\/$/, '')}/time-off-usages`, payload, {
          validateStatus: () => true,
          timeout: timeoutMs(),
        }),
      );
      const raw: unknown = response.data;
      if (response.status >= 500) {
        return { type: 'transport', code: 'UNAVAILABLE' };
      }
      if (!isRecord(raw)) {
        return { type: 'transport', code: 'INVALID_RESPONSE' };
      }
      if (raw['success'] === false) {
        return {
          type: 'insufficient_balance',
          message:
            typeof raw['message'] === 'string'
              ? raw['message']
              : 'Insufficient balance',
          currentBalance:
            typeof raw['currentBalance'] === 'number'
              ? raw['currentBalance']
              : 0,
        };
      }
      if (
        raw['success'] === true &&
        typeof raw['hcmTransactionId'] === 'string' &&
        typeof raw['remainingDays'] === 'number'
      ) {
        return {
          type: 'success',
          hcmTransactionId: raw['hcmTransactionId'],
          remainingDays: raw['remainingDays'],
          ...(raw['idempotentReplay'] === true
            ? { idempotentReplay: true }
            : {}),
        };
      }
      return { type: 'transport', code: 'INVALID_RESPONSE' };
    } catch (err: unknown) {
      return this.mapAxiosErrSubmit(err);
    }
  }

  async getBatchBalances(): Promise<HcmBatchBalancesResponse> {
    const base = resolveBaseUrl();
    try {
      const response = await firstValueFrom(
        this.http.get(`${base.replace(/\/$/, '')}/balances/batch`, {
          validateStatus: () => true,
          timeout: timeoutMs(),
        }),
      );
      const raw: unknown = response.data;
      if (response.status >= 500) {
        return { type: 'transport', code: 'UNAVAILABLE' };
      }
      if (!isRecord(raw) || !Array.isArray(raw['balances'])) {
        return { type: 'transport', code: 'INVALID_RESPONSE' };
      }
      const balancesUnknown = raw['balances'];
      const out: Array<{
        employeeId: string;
        locationId: string;
        availableDays: number;
        version: number;
      }> = [];
      for (const row of balancesUnknown) {
        if (
          isRecord(row) &&
          typeof row['employeeId'] === 'string' &&
          typeof row['locationId'] === 'string' &&
          typeof row['availableDays'] === 'number' &&
          typeof row['version'] === 'number'
        ) {
          out.push({
            employeeId: row['employeeId'],
            locationId: row['locationId'],
            availableDays: row['availableDays'],
            version: row['version'],
          });
        } else {
          return { type: 'transport', code: 'INVALID_RESPONSE' };
        }
      }
      return { type: 'ok', balances: out };
    } catch (err: unknown) {
      const t = this.mapAxiosTransportCode(err);
      if (t) return { type: 'transport', code: t };
      return { type: 'transport', code: 'UNAVAILABLE' };
    }
  }

  private mapAxiosErrBalance(err: unknown): HcmBalanceResponse {
    const t = this.mapAxiosTransportCode(err);
    if (t) return { type: 'transport', code: t };
    return { type: 'transport', code: 'UNAVAILABLE' };
  }

  private mapAxiosErrSubmit(err: unknown): HcmSubmitUsageResponse {
    const t = this.mapAxiosTransportCode(err);
    if (t) return { type: 'transport', code: t };
    return { type: 'transport', code: 'UNAVAILABLE' };
  }

  private mapAxiosTransportCode(
    err: unknown,
  ): 'UNAVAILABLE' | 'INVALID_RESPONSE' | null {
    if (isAxiosError(err)) {
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        return 'UNAVAILABLE';
      }
      if (err.response && err.response.status >= 500) {
        return 'UNAVAILABLE';
      }
      if (
        err.response?.data !== undefined &&
        typeof err.response.data !== 'object'
      ) {
        return 'INVALID_RESPONSE';
      }
    }
    return null;
  }
}
