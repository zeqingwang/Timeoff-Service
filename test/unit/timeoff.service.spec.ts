import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeOffService } from '../../src/timeoff/timeoff.service';
import { TimeOffRequest } from '../../src/timeoff/time-off-request.entity';
import { TimeOffRequestStatus } from '../../src/timeoff/time-off-status';
import { ReadyOnBalance } from '../../src/balances/balance.entity';
import { HCM_CLIENT } from '../../src/hcm/hcm-client.interface';
import type { HcmClient } from '../../src/hcm/hcm-client.interface';
import { BalancesService } from '../../src/balances/balances.service';
import { ApprovalLockService } from '../../src/timeoff/approval-lock.service';
import {
  HttpException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { HcmSyncLogStatus, HcmSyncType } from '../../src/hcm/hcm-sync-types';
import { ErrorCodes } from '../../src/common/error-codes';

describe('TimeOffService', () => {
  let service: TimeOffService;
  let hcm: jest.Mocked<HcmClient>;
  let requestRepo: jest.Mocked<
    Pick<
      Repository<TimeOffRequest>,
      'findOne' | 'save' | 'create' | 'find' | 'update'
    >
  >;
  let balanceRepo: jest.Mocked<Pick<Repository<ReadyOnBalance>, 'findOne'>>;
  let balancesService: jest.Mocked<
    Pick<BalancesService, 'recordSyncLog' | 'upsertBalanceCache'>
  >;
  let approvalLock: {
    acquire: jest.Mock;
    release: jest.Mock;
  };

  beforeEach(async () => {
    approvalLock = {
      acquire: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    hcm = {
      getBalance: jest.fn(),
      submitTimeOffUsage: jest.fn(),
      getBatchBalances: jest.fn(),
    };
    requestRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((x) => x as TimeOffRequest),
      find: jest.fn(),
      update: jest.fn(),
    };
    balanceRepo = {
      findOne: jest.fn(),
    };
    balancesService = {
      recordSyncLog: jest.fn(),
      upsertBalanceCache: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TimeOffService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: getRepositoryToken(ReadyOnBalance), useValue: balanceRepo },
        { provide: HCM_CLIENT, useValue: hcm },
        { provide: BalancesService, useValue: balancesService },
        { provide: ApprovalLockService, useValue: approvalLock },
      ],
    }).compile();

    service = moduleRef.get(TimeOffService);
  });

  it('creates request when HCM balance is sufficient', async () => {
    hcm.getBalance.mockResolvedValue({
      type: 'balance',
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 10,
      version: 1,
    });
    requestRepo.save.mockImplementation(async (x) => x as TimeOffRequest);

    const res = await service.createRequest({
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 2,
    });
    expect(res.status).toBe(TimeOffRequestStatus.PENDING_APPROVAL);
    expect(balancesService.upsertBalanceCache).toHaveBeenCalledWith(
      'E1',
      'L1',
      10,
    );
  });

  it('rejects create when insufficient balance', async () => {
    hcm.getBalance.mockResolvedValue({
      type: 'balance',
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 1,
      version: 1,
    });

    await expect(
      service.createRequest({
        employeeId: 'E1',
        locationId: 'L1',
        requestedDays: 5,
      }),
    ).rejects.toBeDefined();
    expect(requestRepo.save).not.toHaveBeenCalled();
  });

  it('rejects create on invalid dimension', async () => {
    hcm.getBalance.mockResolvedValue({
      type: 'invalid_dimension',
      message: 'bad',
    });

    await expect(
      service.createRequest({
        employeeId: 'E1',
        locationId: 'L1',
        requestedDays: 1,
      }),
    ).rejects.toBeDefined();
  });

  it('rejects create when HCM unavailable', async () => {
    hcm.getBalance.mockResolvedValue({
      type: 'transport',
      code: 'UNAVAILABLE',
    });

    await expect(
      service.createRequest({
        employeeId: 'E1',
        locationId: 'L1',
        requestedDays: 1,
      }),
    ).rejects.toBeDefined();
  });

  it('approves pending request and updates cache', async () => {
    const req = {
      id: 1,
      requestId: 'REQ_1',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 2,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
      managerId: null,
      rejectionReason: null,
      hcmTransactionId: null,
      idempotencyKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TimeOffRequest;
    requestRepo.findOne.mockResolvedValue(req);
    hcm.getBalance.mockResolvedValue({
      type: 'balance',
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 10,
      version: 1,
    });
    hcm.submitTimeOffUsage.mockResolvedValue({
      type: 'success',
      hcmTransactionId: 'TXN',
      remainingDays: 8,
    });
    requestRepo.save.mockImplementation(async (x) => x as TimeOffRequest);

    const res = await service.approve('REQ_1', 'M1');
    expect(res.status).toBe(TimeOffRequestStatus.APPROVED);
    expect(approvalLock.acquire).toHaveBeenCalledWith('E1', 'L1');
    expect(approvalLock.release).toHaveBeenCalledWith('E1:L1');
    expect(balancesService.upsertBalanceCache).toHaveBeenCalledWith(
      'E1',
      'L1',
      8,
    );
  });

  it('duplicate approve returns approved without second submit', async () => {
    const req = {
      id: 1,
      requestId: 'REQ_1',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 2,
      status: TimeOffRequestStatus.APPROVED,
      managerId: 'M1',
      rejectionReason: null,
      hcmTransactionId: 'TXN',
      idempotencyKey: 'REQ_1:approval',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TimeOffRequest;
    requestRepo.findOne.mockResolvedValue(req);
    balanceRepo.findOne.mockResolvedValue({
      availableDays: 8,
    } as ReadyOnBalance);

    const res = await service.approve('REQ_1', 'M1');
    expect(res.hcmTransactionId).toBe('TXN');
    expect(hcm.submitTimeOffUsage).not.toHaveBeenCalled();
    expect(approvalLock.acquire).not.toHaveBeenCalled();
  });

  it('fails approval when not pending', async () => {
    requestRepo.findOne.mockResolvedValue({
      status: TimeOffRequestStatus.REJECTED,
    } as TimeOffRequest);

    await expect(service.approve('REQ_1', 'M1')).rejects.toBeDefined();
    expect(approvalLock.acquire).not.toHaveBeenCalled();
  });

  it('rejects pending request without calling submitUsage', async () => {
    requestRepo.findOne.mockResolvedValue({
      requestId: 'REQ_1',
      status: TimeOffRequestStatus.PENDING_APPROVAL,
    } as TimeOffRequest);
    requestRepo.save.mockImplementation(async (x) => x as TimeOffRequest);

    await service.reject('REQ_1', 'M1', 'no coverage');
    expect(hcm.submitTimeOffUsage).not.toHaveBeenCalled();
    expect(requestRepo.save).toHaveBeenCalled();
  });

  it('approval fails when submit returns insufficient_balance after defensive check', async () => {
    const req = {
      id: 1,
      requestId: 'REQ_1',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 2,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
      managerId: null,
      rejectionReason: null,
      hcmTransactionId: null,
      idempotencyKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TimeOffRequest;
    requestRepo.findOne.mockResolvedValue(req);
    hcm.getBalance.mockResolvedValue({
      type: 'balance',
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 10,
      version: 1,
    });
    hcm.submitTimeOffUsage.mockResolvedValue({
      type: 'insufficient_balance',
      message: 'Insufficient balance',
      currentBalance: 0,
    });
    requestRepo.save.mockImplementation(async (x) => x as TimeOffRequest);

    await expect(service.approve('REQ_1', 'M1')).rejects.toBeDefined();
    expect(requestRepo.save).toHaveBeenCalled();
  });

  it('create throws invalidRequestDays when requestedDays is zero', async () => {
    await expect(
      service.createRequest({
        employeeId: 'E1',
        locationId: 'L1',
        requestedDays: 0,
      }),
    ).rejects.toThrow(HttpException);
  });

  it('create throws hcmInvalidResponse when transport INVALID_RESPONSE', async () => {
    hcm.getBalance.mockResolvedValue({
      type: 'transport',
      code: 'INVALID_RESPONSE',
    });

    await expect(
      service.createRequest({
        employeeId: 'E1',
        locationId: 'L1',
        requestedDays: 1,
      }),
    ).rejects.toThrow(HttpException);
  });

  it('getRequest throws when not found', async () => {
    requestRepo.findOne.mockResolvedValue(null);
    await expect(service.getRequest('missing')).rejects.toThrow(HttpException);
  });

  it('getRequest returns mapped fields', async () => {
    requestRepo.findOne.mockResolvedValue({
      requestId: 'R1',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 3,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
    } as TimeOffRequest);

    const r = await service.getRequest('R1');
    expect(r).toEqual({
      requestId: 'R1',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 3,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
    });
  });

  it('listForEmployee applies status and locationId filters', async () => {
    requestRepo.find.mockResolvedValue([]);
    await service.listForEmployee('E1', TimeOffRequestStatus.APPROVED, 'L9');
    expect(requestRepo.find).toHaveBeenCalledWith({
      where: {
        employeeId: 'E1',
        status: TimeOffRequestStatus.APPROVED,
        locationId: 'L9',
      },
      order: { createdAt: 'DESC' },
    });
  });

  it('approve throws when request id not found', async () => {
    requestRepo.findOne.mockResolvedValue(null);
    await expect(service.approve('nope', 'M1')).rejects.toThrow(HttpException);
  });

  it('approve throws invalidDimension during realtime check', async () => {
    requestRepo.findOne.mockResolvedValue({
      id: 1,
      requestId: 'REQ_1',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 1,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
      managerId: null,
      rejectionReason: null,
      hcmTransactionId: null,
      idempotencyKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    hcm.getBalance.mockResolvedValue({
      type: 'invalid_dimension',
      message: 'no dimension',
    });

    await expect(service.approve('REQ_1', 'M1')).rejects.toThrow(HttpException);
  });

  it('approve throws insufficientBalance when realtime balance too low', async () => {
    requestRepo.findOne.mockResolvedValue({
      id: 1,
      requestId: 'REQ_1',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 5,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
      managerId: null,
      rejectionReason: null,
      hcmTransactionId: null,
      idempotencyKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    hcm.getBalance.mockResolvedValue({
      type: 'balance',
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 2,
      version: 1,
    });

    await expect(service.approve('REQ_1', 'M1')).rejects.toThrow(HttpException);
    expect(hcm.submitTimeOffUsage).not.toHaveBeenCalled();
  });

  it('approve throws hcmUnavailable when realtime getBalance returns transport UNAVAILABLE', async () => {
    requestRepo.findOne.mockResolvedValue({
      id: 1,
      requestId: 'REQ_1',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 2,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
      managerId: null,
      rejectionReason: null,
      hcmTransactionId: null,
      idempotencyKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    hcm.getBalance.mockResolvedValue({
      type: 'transport',
      code: 'UNAVAILABLE',
    });

    await expect(service.approve('REQ_1', 'M1')).rejects.toThrow(HttpException);
    expect(hcm.submitTimeOffUsage).not.toHaveBeenCalled();
    expect(balancesService.recordSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        syncType: HcmSyncType.REALTIME_BALANCE,
        status: HcmSyncLogStatus.FAILED,
        employeeId: 'E1',
        locationId: 'L1',
        requestId: 'REQ_1',
        errorCode: 'UNAVAILABLE',
      }),
    );
  });

  it('approve throws hcmInvalidResponse when realtime getBalance returns transport INVALID_RESPONSE', async () => {
    requestRepo.findOne.mockResolvedValue({
      id: 2,
      requestId: 'REQ_Z',
      employeeId: 'E9',
      locationId: 'L9',
      requestedDays: 1,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
      managerId: null,
      rejectionReason: null,
      hcmTransactionId: null,
      idempotencyKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    hcm.getBalance.mockResolvedValue({
      type: 'transport',
      code: 'INVALID_RESPONSE',
    });

    await expect(service.approve('REQ_Z', 'M1')).rejects.toThrow(HttpException);
    expect(hcm.submitTimeOffUsage).not.toHaveBeenCalled();
    expect(balancesService.recordSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        syncType: HcmSyncType.REALTIME_BALANCE,
        status: HcmSyncLogStatus.FAILED,
        employeeId: 'E9',
        locationId: 'L9',
        requestId: 'REQ_Z',
        errorCode: 'INVALID_RESPONSE',
      }),
    );
  });

  it('approve throws hcmUnavailable when submit transport UNAVAILABLE', async () => {
    requestRepo.findOne.mockResolvedValue({
      id: 1,
      requestId: 'REQ_1',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 1,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
      managerId: null,
      rejectionReason: null,
      hcmTransactionId: null,
      idempotencyKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    hcm.getBalance.mockResolvedValue({
      type: 'balance',
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 10,
      version: 1,
    });
    hcm.submitTimeOffUsage.mockResolvedValue({
      type: 'transport',
      code: 'UNAVAILABLE',
    });

    await expect(service.approve('REQ_1', 'M1')).rejects.toThrow(HttpException);
  });

  it('approve marks FAILED_HCM_SUBMISSION and throws when submit INVALID_RESPONSE', async () => {
    requestRepo.findOne.mockResolvedValue({
      id: 99,
      requestId: 'REQ_1',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 1,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
      managerId: null,
      rejectionReason: null,
      hcmTransactionId: null,
      idempotencyKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    hcm.getBalance.mockResolvedValue({
      type: 'balance',
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 10,
      version: 1,
    });
    hcm.submitTimeOffUsage.mockResolvedValue({
      type: 'transport',
      code: 'INVALID_RESPONSE',
    });

    await expect(service.approve('REQ_1', 'M1')).rejects.toThrow(HttpException);
    expect(requestRepo.update).toHaveBeenCalledWith(
      { id: 99 },
      expect.objectContaining({
        status: TimeOffRequestStatus.FAILED_HCM_SUBMISSION,
      }),
    );
  });

  it('reject throws when request not found', async () => {
    requestRepo.findOne.mockResolvedValue(null);
    await expect(service.reject('x', 'M1')).rejects.toThrow(HttpException);
  });

  it('reject throws when not pending', async () => {
    requestRepo.findOne.mockResolvedValue({
      status: TimeOffRequestStatus.APPROVED,
    } as TimeOffRequest);
    await expect(service.reject('REQ_1', 'M1')).rejects.toThrow(HttpException);
  });

  it('cancel sets CANCELLED when pending and employee matches', async () => {
    const row = {
      id: 1,
      requestId: 'REQ_X',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 2,
      status: TimeOffRequestStatus.PENDING_APPROVAL,
      managerId: null,
      rejectionReason: null,
      hcmTransactionId: null,
      idempotencyKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TimeOffRequest;
    requestRepo.findOne.mockResolvedValue(row);
    requestRepo.save.mockImplementation(async (e) => e as TimeOffRequest);

    const out = await service.cancel('REQ_X', 'E1');
    expect(out).toEqual({
      requestId: 'REQ_X',
      status: TimeOffRequestStatus.CANCELLED,
    });
    expect(requestRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: TimeOffRequestStatus.CANCELLED }),
    );
  });

  it('cancel throws Forbidden when employeeId does not match', async () => {
    requestRepo.findOne.mockResolvedValue({
      requestId: 'REQ_X',
      employeeId: 'E1',
      status: TimeOffRequestStatus.PENDING_APPROVAL,
    } as TimeOffRequest);

    try {
      await service.cancel('REQ_X', 'E999');
      throw new Error('expected throw');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(ForbiddenException);
      const body = (e as ForbiddenException).getResponse() as {
        errorCode: string;
      };
      expect(body.errorCode).toBe(ErrorCodes.EMPLOYEE_MISMATCH);
    }
  });

  it('cancel throws REQUEST_NOT_CANCELLABLE when already approved', async () => {
    requestRepo.findOne.mockResolvedValue({
      employeeId: 'E1',
      status: TimeOffRequestStatus.APPROVED,
    } as TimeOffRequest);

    try {
      await service.cancel('REQ_X', 'E1');
      throw new Error('expected throw');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(ConflictException);
      const body = (e as ConflictException).getResponse() as {
        errorCode: string;
      };
      expect(body.errorCode).toBe(ErrorCodes.REQUEST_NOT_CANCELLABLE);
    }
  });

  it('cancel throws REQUEST_NOT_CANCELLABLE when rejected', async () => {
    requestRepo.findOne.mockResolvedValue({
      employeeId: 'E1',
      status: TimeOffRequestStatus.REJECTED,
    } as TimeOffRequest);

    await expect(service.cancel('REQ_X', 'E1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('cancel throws REQUEST_NOT_CANCELLABLE when already cancelled', async () => {
    requestRepo.findOne.mockResolvedValue({
      employeeId: 'E1',
      status: TimeOffRequestStatus.CANCELLED,
    } as TimeOffRequest);

    await expect(service.cancel('REQ_X', 'E1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('cancel throws when request not found', async () => {
    requestRepo.findOne.mockResolvedValue(null);
    await expect(service.cancel('missing', 'E1')).rejects.toThrow(
      HttpException,
    );
  });

  it('approve idempotent returns remainingDays 0 when cache missing', async () => {
    requestRepo.findOne.mockResolvedValue({
      requestId: 'REQ_1',
      employeeId: 'E1',
      locationId: 'L1',
      requestedDays: 1,
      status: TimeOffRequestStatus.APPROVED,
      managerId: 'M1',
      rejectionReason: null,
      hcmTransactionId: 'TXN',
      idempotencyKey: 'REQ_1:approval',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TimeOffRequest);
    balanceRepo.findOne.mockResolvedValue(null);

    const res = await service.approve('REQ_1', 'M1');
    expect(res.remainingDays).toBe(0);
  });
});
