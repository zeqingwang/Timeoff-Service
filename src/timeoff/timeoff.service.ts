import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { TimeOffRequest } from './time-off-request.entity';
import { TimeOffRequestStatus } from './time-off-status';
import { HCM_CLIENT, type HcmClient } from '../hcm/hcm-client.interface';
import { HcmSyncLogStatus, HcmSyncType } from '../hcm/hcm-sync-types';
import { BalancesService } from '../balances/balances.service';
import { ReadyOnBalance } from '../balances/balance.entity';
import { approvalIdempotencyKey } from '../common/idempotency';
import {
  employeeMismatch,
  hcmInvalidResponse,
  hcmUnavailable,
  insufficientBalance,
  invalidDimension,
  invalidRequestDays,
  requestNotApprovable,
  requestNotCancellable,
  requestNotFound,
} from '../common/errors';
import type { CreateTimeOffRequestDto } from './dto/timeoff.dto';

function newRequestId(): string {
  return `REQ_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

@Injectable()
export class TimeOffService {
  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(ReadyOnBalance)
    private readonly balanceRepo: Repository<ReadyOnBalance>,
    @Inject(HCM_CLIENT) private readonly hcmClient: HcmClient,
    private readonly balancesService: BalancesService,
  ) {}

  async createRequest(dto: CreateTimeOffRequestDto) {
    if (dto.requestedDays <= 0) {
      throw invalidRequestDays('Requested days must be greater than 0');
    }

    const bal = await this.hcmClient.getBalance(dto.employeeId, dto.locationId);
    if (bal.type === 'transport') {
      await this.balancesService.recordSyncLog({
        syncType: HcmSyncType.REALTIME_BALANCE,
        status: HcmSyncLogStatus.FAILED,
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        errorCode: bal.code,
        errorMessage: 'HCM realtime balance failed during create',
      });
      if (bal.code === 'INVALID_RESPONSE') {
        throw hcmInvalidResponse();
      }
      throw hcmUnavailable();
    }
    if (bal.type === 'invalid_dimension') {
      await this.balancesService.recordSyncLog({
        syncType: HcmSyncType.REALTIME_BALANCE,
        status: HcmSyncLogStatus.FAILED,
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        errorCode: 'INVALID_DIMENSION',
        errorMessage: bal.message,
      });
      throw invalidDimension(bal.message);
    }

    if (bal.availableDays < dto.requestedDays) {
      throw insufficientBalance(
        'Requested days exceed current HCM balance',
        bal.availableDays,
        dto.requestedDays,
      );
    }

    const requestId = newRequestId();
    const entity = this.requestRepo.create({
      requestId,
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      requestedDays: dto.requestedDays,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
      managerId: null,
      rejectionReason: null,
      hcmTransactionId: null,
      idempotencyKey: null,
    });
    await this.requestRepo.save(entity);

    await this.balancesService.upsertBalanceCache(
      dto.employeeId,
      dto.locationId,
      bal.availableDays,
    );
    await this.balancesService.recordSyncLog({
      syncType: HcmSyncType.REALTIME_BALANCE,
      status: HcmSyncLogStatus.SUCCESS,
      employeeId: dto.employeeId,
      locationId: dto.locationId,
    });

    return {
      requestId,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      requestedDays: dto.requestedDays,
    };
  }

  async getRequest(requestId: string) {
    const req = await this.requestRepo.findOne({ where: { requestId } });
    if (!req) {
      throw requestNotFound();
    }
    return {
      requestId: req.requestId,
      employeeId: req.employeeId,
      locationId: req.locationId,
      requestedDays: req.requestedDays,
      status: req.status,
    };
  }

  async listForEmployee(
    employeeId: string,
    status?: string,
    locationId?: string,
  ) {
    const where: FindOptionsWhere<TimeOffRequest> = { employeeId };
    if (status) {
      where.status = status as TimeOffRequestStatus;
    }
    if (locationId) {
      where.locationId = locationId;
    }
    const rows = await this.requestRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => ({
      requestId: r.requestId,
      employeeId: r.employeeId,
      locationId: r.locationId,
      requestedDays: r.requestedDays,
      status: r.status,
    }));
  }

  async approve(requestId: string, managerId: string) {
    const existing = await this.requestRepo.findOne({ where: { requestId } });
    if (!existing) {
      throw requestNotFound();
    }
    if (existing.status === TimeOffRequestStatus.APPROVED) {
      const remaining = await this.getCachedBalance(
        existing.employeeId,
        existing.locationId,
      );
      return {
        requestId,
        status: TimeOffRequestStatus.APPROVED,
        hcmTransactionId: existing.hcmTransactionId,
        remainingDays: remaining,
      };
    }
    if (existing.status !== TimeOffRequestStatus.PENDING_APPROVAL) {
      throw requestNotApprovable('Request is not pending approval');
    }

    const bal = await this.hcmClient.getBalance(
      existing.employeeId,
      existing.locationId,
    );
    if (bal.type === 'transport') {
      await this.balancesService.recordSyncLog({
        syncType: HcmSyncType.REALTIME_BALANCE,
        status: HcmSyncLogStatus.FAILED,
        employeeId: existing.employeeId,
        locationId: existing.locationId,
        requestId,
        errorCode: bal.code,
        errorMessage: 'HCM realtime balance failed during approval',
      });
      if (bal.code === 'INVALID_RESPONSE') {
        throw hcmInvalidResponse();
      }
      throw hcmUnavailable();
    }
    if (bal.type === 'invalid_dimension') {
      await this.balancesService.recordSyncLog({
        syncType: HcmSyncType.REALTIME_BALANCE,
        status: HcmSyncLogStatus.FAILED,
        employeeId: existing.employeeId,
        locationId: existing.locationId,
        requestId,
        errorCode: 'INVALID_DIMENSION',
        errorMessage: bal.message,
      });
      throw invalidDimension(bal.message);
    }

    if (bal.availableDays < existing.requestedDays) {
      throw insufficientBalance(
        'Requested days exceed current HCM balance',
        bal.availableDays,
        existing.requestedDays,
      );
    }

    const idempotencyKey = approvalIdempotencyKey(requestId);
    const submit = await this.hcmClient.submitTimeOffUsage({
      employeeId: existing.employeeId,
      locationId: existing.locationId,
      days: existing.requestedDays,
      externalRequestId: requestId,
      idempotencyKey,
    });

    if (submit.type === 'transport') {
      await this.balancesService.recordSyncLog({
        syncType: HcmSyncType.SUBMIT_USAGE,
        status: HcmSyncLogStatus.FAILED,
        employeeId: existing.employeeId,
        locationId: existing.locationId,
        requestId,
        errorCode: submit.code,
        errorMessage: 'HCM submit usage failed',
      });
      if (submit.code === 'INVALID_RESPONSE') {
        await this.markFailedHcm(existing.id, managerId);
        throw hcmInvalidResponse();
      }
      throw hcmUnavailable();
    }

    if (submit.type === 'insufficient_balance') {
      existing.managerId = managerId;
      existing.status = TimeOffRequestStatus.FAILED_HCM_SUBMISSION;
      await this.requestRepo.save(existing);
      await this.balancesService.recordSyncLog({
        syncType: HcmSyncType.SUBMIT_USAGE,
        status: HcmSyncLogStatus.FAILED,
        employeeId: existing.employeeId,
        locationId: existing.locationId,
        requestId,
        errorCode: 'INSUFFICIENT_BALANCE',
        errorMessage: submit.message,
      });
      throw insufficientBalance(
        submit.message,
        submit.currentBalance,
        existing.requestedDays,
      );
    }

    existing.status = TimeOffRequestStatus.APPROVED;
    existing.managerId = managerId;
    existing.hcmTransactionId = submit.hcmTransactionId;
    existing.idempotencyKey = idempotencyKey;
    await this.requestRepo.save(existing);

    await this.balancesService.upsertBalanceCache(
      existing.employeeId,
      existing.locationId,
      submit.remainingDays,
    );
    await this.balancesService.recordSyncLog({
      syncType: HcmSyncType.SUBMIT_USAGE,
      status: HcmSyncLogStatus.SUCCESS,
      employeeId: existing.employeeId,
      locationId: existing.locationId,
      requestId,
    });

    return {
      requestId,
      status: TimeOffRequestStatus.APPROVED,
      hcmTransactionId: submit.hcmTransactionId,
      remainingDays: submit.remainingDays,
    };
  }

  async reject(requestId: string, managerId: string, reason?: string) {
    const existing = await this.requestRepo.findOne({ where: { requestId } });
    if (!existing) {
      throw requestNotFound();
    }
    if (existing.status !== TimeOffRequestStatus.PENDING_APPROVAL) {
      throw requestNotApprovable('Request is not pending approval');
    }
    existing.status = TimeOffRequestStatus.REJECTED;
    existing.managerId = managerId;
    existing.rejectionReason = reason ?? null;
    await this.requestRepo.save(existing);
    return {
      requestId,
      status: TimeOffRequestStatus.REJECTED,
    };
  }

  /**
   * Employee cancels a pending request. `CANCELLED` is terminal; only
   * `PENDING_APPROVAL` is allowed.
   */
  async cancel(requestId: string, employeeId: string) {
    const existing = await this.requestRepo.findOne({ where: { requestId } });
    if (!existing) {
      throw requestNotFound();
    }
    if (existing.employeeId !== employeeId) {
      throw employeeMismatch();
    }
    if (existing.status !== TimeOffRequestStatus.PENDING_APPROVAL) {
      throw requestNotCancellable(
        'Only pending requests can be cancelled; this status is final',
      );
    }
    existing.status = TimeOffRequestStatus.CANCELLED;
    await this.requestRepo.save(existing);
    return {
      requestId,
      status: TimeOffRequestStatus.CANCELLED,
    };
  }

  private async getCachedBalance(
    employeeId: string,
    locationId: string,
  ): Promise<number> {
    const row = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });
    return row?.availableDays ?? 0;
  }

  private async markFailedHcm(id: number, managerId: string): Promise<void> {
    await this.requestRepo.update(
      { id },
      {
        status: TimeOffRequestStatus.FAILED_HCM_SUBMISSION,
        managerId,
      },
    );
  }
}
