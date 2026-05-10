import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReadyOnBalance } from './balance.entity';
import { HcmSyncLog } from '../hcm/hcm-sync-log.entity';
import { HCM_CLIENT, type HcmClient } from '../hcm/hcm-client.interface';
import { HcmSyncLogStatus, HcmSyncType } from '../hcm/hcm-sync-types';
import {
  hcmInvalidResponse,
  hcmUnavailable,
  invalidDimension,
} from '../common/errors';

@Injectable()
export class BalancesService {
  constructor(
    @InjectRepository(ReadyOnBalance)
    private readonly balanceRepo: Repository<ReadyOnBalance>,
    @InjectRepository(HcmSyncLog)
    private readonly syncLogRepo: Repository<HcmSyncLog>,
    @Inject(HCM_CLIENT) private readonly hcmClient: HcmClient,
  ) {}

  async getBalances(
    employeeId: string,
    locationId: string,
    refresh?: boolean,
  ): Promise<{
    employeeId: string;
    locationId: string;
    availableDays: number;
    lastSyncedAt: string;
    source: 'HCM_CACHE';
  }> {
    const needsFetch = refresh === true;
    if (!needsFetch) {
      const cached = await this.balanceRepo.findOne({
        where: { employeeId, locationId },
      });
      if (cached) {
        return {
          employeeId,
          locationId,
          availableDays: cached.availableDays,
          lastSyncedAt: cached.lastSyncedAt.toISOString(),
          source: 'HCM_CACHE',
        };
      }
    }

    const result = await this.hcmClient.getBalance(employeeId, locationId);
    if (result.type === 'transport') {
      await this.recordSyncLog({
        syncType: HcmSyncType.REALTIME_BALANCE,
        status: HcmSyncLogStatus.FAILED,
        employeeId,
        locationId,
        errorCode: result.code,
        errorMessage: 'Realtime balance fetch failed',
      });
      if (result.code === 'INVALID_RESPONSE') {
        throw hcmInvalidResponse();
      }
      throw hcmUnavailable();
    }
    if (result.type === 'invalid_dimension') {
      await this.recordSyncLog({
        syncType: HcmSyncType.REALTIME_BALANCE,
        status: HcmSyncLogStatus.FAILED,
        employeeId,
        locationId,
        errorCode: 'INVALID_DIMENSION',
        errorMessage: result.message,
      });
      throw invalidDimension(result.message);
    }

    const now = new Date();
    await this.upsertCache(employeeId, locationId, result.availableDays, now);
    await this.recordSyncLog({
      syncType: HcmSyncType.REALTIME_BALANCE,
      status: HcmSyncLogStatus.SUCCESS,
      employeeId,
      locationId,
    });

    return {
      employeeId,
      locationId,
      availableDays: result.availableDays,
      lastSyncedAt: now.toISOString(),
      source: 'HCM_CACHE',
    };
  }

  async syncFromHcm(): Promise<{
    status: string;
    recordsReceived: number;
    recordsUpserted: number;
    recordsFailed: number;
  }> {
    const batch = await this.hcmClient.getBatchBalances();
    if (batch.type === 'transport') {
      await this.recordSyncLog({
        syncType: HcmSyncType.BATCH_BALANCE,
        status: HcmSyncLogStatus.FAILED,
        employeeId: null,
        locationId: null,
        errorCode: batch.code,
        errorMessage: 'Batch balance fetch failed',
      });
      if (batch.code === 'INVALID_RESPONSE') {
        throw hcmInvalidResponse();
      }
      throw hcmUnavailable('Batch sync failed: HCM unavailable');
    }

    let failed = 0;
    const now = new Date();
    for (const row of batch.balances) {
      try {
        await this.upsertCache(
          row.employeeId,
          row.locationId,
          row.availableDays,
          now,
        );
      } catch {
        failed += 1;
      }
    }

    const upserted = batch.balances.length - failed;
    await this.recordSyncLog({
      syncType: HcmSyncType.BATCH_BALANCE,
      status:
        failed === batch.balances.length
          ? HcmSyncLogStatus.FAILED
          : HcmSyncLogStatus.SUCCESS,
      employeeId: null,
      locationId: null,
      errorCode: failed > 0 ? 'PARTIAL_FAILURE' : null,
      errorMessage: failed > 0 ? `${failed} records failed to upsert` : null,
    });

    return {
      status: failed === batch.balances.length ? 'FAILED' : 'SUCCESS',
      recordsReceived: batch.balances.length,
      recordsUpserted: upserted,
      recordsFailed: failed,
    };
  }

  private async upsertCache(
    employeeId: string,
    locationId: string,
    availableDays: number,
    lastSyncedAt: Date,
  ): Promise<void> {
    let row = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });
    if (!row) {
      row = this.balanceRepo.create({
        employeeId,
        locationId,
        availableDays,
        lastSyncedAt,
      });
    } else {
      row.availableDays = availableDays;
      row.lastSyncedAt = lastSyncedAt;
    }
    await this.balanceRepo.save(row);
  }

  async recordSyncLog(entry: {
    syncType: HcmSyncType;
    status: HcmSyncLogStatus;
    employeeId: string | null;
    locationId: string | null;
    requestId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<void> {
    const log = this.syncLogRepo.create({
      syncType: entry.syncType,
      status: entry.status,
      employeeId: entry.employeeId ?? null,
      locationId: entry.locationId ?? null,
      requestId: entry.requestId ?? null,
      errorCode: entry.errorCode ?? null,
      errorMessage: entry.errorMessage ?? null,
    });
    await this.syncLogRepo.save(log);
  }

  async upsertBalanceCache(
    employeeId: string,
    locationId: string,
    availableDays: number,
  ): Promise<void> {
    await this.upsertCache(employeeId, locationId, availableDays, new Date());
  }
}
