import type {
  HcmBalanceResponse,
  HcmBatchBalancesResponse,
  HcmSubmitUsagePayload,
  HcmSubmitUsageResponse,
} from './hcm-client.types';

export interface HcmClient {
  getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<HcmBalanceResponse>;
  submitTimeOffUsage(
    payload: HcmSubmitUsagePayload,
  ): Promise<HcmSubmitUsageResponse>;
  getBatchBalances(): Promise<HcmBatchBalancesResponse>;
}

export const HCM_CLIENT = Symbol('HCM_CLIENT');
