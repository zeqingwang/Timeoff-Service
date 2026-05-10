import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MockHcmService } from '../../src/mock-hcm/mock-hcm.service';
import { MockHcmBalance } from '../../src/mock-hcm/mock-hcm-balance.entity';
import { MockHcmTimeOffUsage } from '../../src/mock-hcm/mock-hcm-time-off-usage.entity';

describe('MockHcmService', () => {
  let service: MockHcmService;
  let balanceRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
  };
  let usageRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };

  beforeEach(async () => {
    balanceRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((x: MockHcmBalance) => x),
      delete: jest.fn(),
    };
    usageRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((x: MockHcmTimeOffUsage) => x),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MockHcmService,
        {
          provide: getRepositoryToken(MockHcmBalance),
          useValue: balanceRepo,
        },
        {
          provide: getRepositoryToken(MockHcmTimeOffUsage),
          useValue: usageRepo,
        },
      ],
    }).compile();

    service = moduleRef.get(MockHcmService);
  });

  it('seedOrUpdateBalance deletes row when isValid is false', async () => {
    await service.seedOrUpdateBalance({
      employeeId: 'E',
      locationId: 'L',
      availableDays: 5,
      isValid: false,
    });
    expect(balanceRepo.delete).toHaveBeenCalledWith({
      employeeId: 'E',
      locationId: 'L',
    });
    expect(balanceRepo.save).not.toHaveBeenCalled();
  });

  it('submitTimeOffUsage returns replay when matching externalRequestId exists', async () => {
    usageRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      hcmTransactionId: 'OLD_TXN',
      externalRequestId: 'REQ_X',
      employeeId: 'E',
      locationId: 'L',
      days: 2,
      idempotencyKey: 'other-key',
    });
    balanceRepo.findOne.mockResolvedValue({
      availableDays: 7,
    });

    const r = await service.submitTimeOffUsage({
      employeeId: 'E',
      locationId: 'L',
      days: 2,
      externalRequestId: 'REQ_X',
      idempotencyKey: 'new-key',
    });

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.hcmTransactionId).toBe('OLD_TXN');
      expect(r.idempotentReplay).toBe(true);
      expect(r.remainingDays).toBe(7);
    }
  });

  it('submitTimeOffUsage returns insufficient when employee row missing after usage lookup', async () => {
    usageRepo.findOne.mockResolvedValue(null);
    balanceRepo.findOne.mockResolvedValue(null);

    const r = await service.submitTimeOffUsage({
      employeeId: 'E',
      locationId: 'L',
      days: 1,
      externalRequestId: 'REQ_Y',
      idempotencyKey: 'k1',
    });

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.errorCode).toBe('INSUFFICIENT_BALANCE');
      expect(r.currentBalance).toBe(0);
    }
  });
});
