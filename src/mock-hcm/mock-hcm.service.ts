import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { MockHcmBalance } from './mock-hcm-balance.entity';
import { MockHcmTimeOffUsage } from './mock-hcm-time-off-usage.entity';
import { MockHcmFailureMode } from './mock-hcm-failure-mode';

export interface MockHcmBalanceRow {
  employeeId: string;
  locationId: string;
  availableDays: number;
  version: number;
}

@Injectable()
export class MockHcmService {
  private failureMode: MockHcmFailureMode = MockHcmFailureMode.NONE;

  constructor(
    @InjectRepository(MockHcmBalance)
    private readonly balanceRepo: Repository<MockHcmBalance>,
    @InjectRepository(MockHcmTimeOffUsage)
    private readonly usageRepo: Repository<MockHcmTimeOffUsage>,
  ) {}

  setFailureMode(mode: MockHcmFailureMode): void {
    this.failureMode = mode;
  }

  getFailureMode(): MockHcmFailureMode {
    return this.failureMode;
  }

  async getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<
    | { ok: true; data: MockHcmBalanceRow }
    | { ok: false; errorCode: 'INVALID_DIMENSION'; message: string }
  > {
    const row = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });
    if (!row) {
      return {
        ok: false,
        errorCode: 'INVALID_DIMENSION',
        message: 'Invalid employee/location combination',
      };
    }
    return {
      ok: true,
      data: {
        employeeId: row.employeeId,
        locationId: row.locationId,
        availableDays: row.availableDays,
        version: row.version,
      },
    };
  }

  async getBatchBalances(): Promise<MockHcmBalanceRow[]> {
    const rows = await this.balanceRepo.find();
    return rows.map((row) => ({
      employeeId: row.employeeId,
      locationId: row.locationId,
      availableDays: row.availableDays,
      version: row.version,
    }));
  }

  async seedOrUpdateBalance(input: {
    employeeId: string;
    locationId: string;
    availableDays: number;
    isValid: boolean;
  }): Promise<void> {
    if (!input.isValid) {
      await this.balanceRepo.delete({
        employeeId: input.employeeId,
        locationId: input.locationId,
      });
      return;
    }
    let row = await this.balanceRepo.findOne({
      where: { employeeId: input.employeeId, locationId: input.locationId },
    });
    if (!row) {
      row = this.balanceRepo.create({
        employeeId: input.employeeId,
        locationId: input.locationId,
        availableDays: input.availableDays,
        version: 1,
      });
    } else {
      row.availableDays = input.availableDays;
      row.version = row.version + 1;
    }
    await this.balanceRepo.save(row);
  }

  async submitTimeOffUsage(input: {
    employeeId: string;
    locationId: string;
    days: number;
    externalRequestId: string;
    idempotencyKey: string;
  }): Promise<
    | {
        success: true;
        hcmTransactionId: string;
        remainingDays: number;
        idempotentReplay?: boolean;
      }
    | {
        success: false;
        errorCode: 'INSUFFICIENT_BALANCE';
        message: string;
        currentBalance: number;
      }
  > {
    const existingByKey = await this.usageRepo.findOne({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existingByKey) {
      const bal = await this.balanceRepo.findOne({
        where: { employeeId: input.employeeId, locationId: input.locationId },
      });
      return {
        success: true,
        hcmTransactionId: existingByKey.hcmTransactionId,
        remainingDays: bal?.availableDays ?? 0,
        idempotentReplay: true,
      };
    }

    const existingByExternal = await this.usageRepo.findOne({
      where: { externalRequestId: input.externalRequestId },
    });
    if (existingByExternal) {
      const bal = await this.balanceRepo.findOne({
        where: { employeeId: input.employeeId, locationId: input.locationId },
      });
      return {
        success: true,
        hcmTransactionId: existingByExternal.hcmTransactionId,
        remainingDays: bal?.availableDays ?? 0,
        idempotentReplay: true,
      };
    }

    const row = await this.balanceRepo.findOne({
      where: { employeeId: input.employeeId, locationId: input.locationId },
    });
    if (!row) {
      return {
        success: false,
        errorCode: 'INSUFFICIENT_BALANCE',
        message: 'Invalid employee/location combination',
        currentBalance: 0,
      };
    }

    const ignoreInsufficient =
      this.failureMode === MockHcmFailureMode.IGNORE_INSUFFICIENT_BALANCE;

    if (!ignoreInsufficient && row.availableDays < input.days) {
      return {
        success: false,
        errorCode: 'INSUFFICIENT_BALANCE',
        message: 'Insufficient balance',
        currentBalance: row.availableDays,
      };
    }

    const newBalance = ignoreInsufficient
      ? row.availableDays - input.days
      : row.availableDays - input.days;

    row.availableDays = newBalance;
    row.version = row.version + 1;
    await this.balanceRepo.save(row);

    const hcmTransactionId = `HCM_TXN_${randomUUID()}`;
    const usage = this.usageRepo.create({
      hcmTransactionId,
      externalRequestId: input.externalRequestId,
      employeeId: input.employeeId,
      locationId: input.locationId,
      days: input.days,
      idempotencyKey: input.idempotencyKey,
    });
    await this.usageRepo.save(usage);

    return {
      success: true,
      hcmTransactionId,
      remainingDays: row.availableDays,
    };
  }
}
