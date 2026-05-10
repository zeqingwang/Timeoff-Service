export type HcmBalanceResponse =
  | {
      type: 'balance';
      employeeId: string;
      locationId: string;
      availableDays: number;
      version: number;
    }
  | { type: 'invalid_dimension'; message: string }
  | { type: 'transport'; code: 'UNAVAILABLE' | 'INVALID_RESPONSE' };

export interface HcmSubmitUsagePayload {
  employeeId: string;
  locationId: string;
  days: number;
  externalRequestId: string;
  idempotencyKey: string;
}

export type HcmSubmitUsageResponse =
  | {
      type: 'success';
      hcmTransactionId: string;
      remainingDays: number;
      idempotentReplay?: boolean;
    }
  | {
      type: 'insufficient_balance';
      message: string;
      currentBalance: number;
    }
  | { type: 'transport'; code: 'UNAVAILABLE' | 'INVALID_RESPONSE' };

export type HcmBatchBalancesResponse =
  | {
      type: 'ok';
      balances: Array<{
        employeeId: string;
        locationId: string;
        availableDays: number;
        version: number;
      }>;
    }
  | { type: 'transport'; code: 'UNAVAILABLE' | 'INVALID_RESPONSE' };
