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

  beforeEach(async () => {
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
  });

  it('fails approval when not pending', async () => {
    requestRepo.findOne.mockResolvedValue({
      status: TimeOffRequestStatus.REJECTED,
    } as TimeOffRequest);

    await expect(service.approve('REQ_1', 'M1')).rejects.toBeDefined();
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
});
