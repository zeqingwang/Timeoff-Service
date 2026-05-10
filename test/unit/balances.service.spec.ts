import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BalancesService } from '../../src/balances/balances.service';
import { ReadyOnBalance } from '../../src/balances/balance.entity';
import { HcmSyncLog } from '../../src/hcm/hcm-sync-log.entity';
import { HCM_CLIENT } from '../../src/hcm/hcm-client.interface';
import type { HcmClient } from '../../src/hcm/hcm-client.interface';
import { HcmSyncType } from '../../src/hcm/hcm-sync-types';
import { HttpException, UnprocessableEntityException } from '@nestjs/common';

describe('BalancesService', () => {
  let service: BalancesService;
  let hcm: jest.Mocked<HcmClient>;
  let balanceRepo: jest.Mocked<
    Pick<Repository<ReadyOnBalance>, 'findOne' | 'save' | 'create'>
  >;
  let syncRepo: jest.Mocked<Pick<Repository<HcmSyncLog>, 'create' | 'save'>>;

  beforeEach(async () => {
    hcm = {
      getBalance: jest.fn(),
      submitTimeOffUsage: jest.fn(),
      getBatchBalances: jest.fn(),
    };
    balanceRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((x) => x as ReadyOnBalance),
    };
    syncRepo = {
      create: jest.fn((x) => x as HcmSyncLog),
      save: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BalancesService,
        { provide: getRepositoryToken(ReadyOnBalance), useValue: balanceRepo },
        { provide: getRepositoryToken(HcmSyncLog), useValue: syncRepo },
        { provide: HCM_CLIENT, useValue: hcm },
      ],
    }).compile();

    service = moduleRef.get(BalancesService);
  });

  it('returns cached balance when refresh is false and row exists', async () => {
    const last = new Date('2026-01-01T00:00:00.000Z');
    balanceRepo.findOne.mockResolvedValue({
      id: 1,
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 5,
      lastSyncedAt: last,
      createdAt: last,
      updatedAt: last,
    });

    const res = await service.getBalances('E1', 'L1', false);
    expect(res.availableDays).toBe(5);
    expect(res.source).toBe('HCM_CACHE');
    expect(hcm.getBalance).not.toHaveBeenCalled();
  });

  it('calls HCM when refresh is true', async () => {
    balanceRepo.findOne.mockResolvedValue(null);
    hcm.getBalance.mockResolvedValue({
      type: 'balance',
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 10,
      version: 2,
    });
    balanceRepo.save.mockImplementation(async (x) => x as ReadyOnBalance);

    const res = await service.getBalances('E1', 'L1', true);
    expect(hcm.getBalance).toHaveBeenCalledWith('E1', 'L1');
    expect(res.availableDays).toBe(10);
    expect(syncRepo.save).toHaveBeenCalled();
  });

  it('throws when HCM transport fails on refresh path', async () => {
    balanceRepo.findOne.mockResolvedValue(null);
    hcm.getBalance.mockResolvedValue({
      type: 'transport',
      code: 'UNAVAILABLE',
    });

    await expect(service.getBalances('E1', 'L1', false)).rejects.toBeDefined();
    expect(syncRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        syncType: HcmSyncType.REALTIME_BALANCE,
      }),
    );
  });

  it('batch sync upserts all balances', async () => {
    hcm.getBatchBalances.mockResolvedValue({
      type: 'ok',
      balances: [
        {
          employeeId: 'E1',
          locationId: 'L1',
          availableDays: 3,
          version: 1,
        },
      ],
    });
    balanceRepo.findOne.mockResolvedValue(null);
    balanceRepo.save.mockImplementation(async (x) => x as ReadyOnBalance);

    const res = await service.syncFromHcm();
    expect(res.recordsUpserted).toBe(1);
    expect(res.recordsReceived).toBe(1);
    expect(balanceRepo.save).toHaveBeenCalled();
  });

  it('batch sync logs failure when HCM transport fails', async () => {
    hcm.getBatchBalances.mockResolvedValue({
      type: 'transport',
      code: 'UNAVAILABLE',
    });

    await expect(service.syncFromHcm()).rejects.toBeDefined();
    expect(syncRepo.save).toHaveBeenCalled();
  });

  it('getBalances throws invalidDimension when HCM returns invalid dimension', async () => {
    balanceRepo.findOne.mockResolvedValue(null);
    hcm.getBalance.mockResolvedValue({
      type: 'invalid_dimension',
      message: 'bad combo',
    });

    await expect(service.getBalances('E1', 'L1', false)).rejects.toThrow(
      UnprocessableEntityException,
    );
    expect(syncRepo.save).toHaveBeenCalled();
  });

  it('getBalances throws hcmInvalidResponse when transport is INVALID_RESPONSE', async () => {
    balanceRepo.findOne.mockResolvedValue(null);
    hcm.getBalance.mockResolvedValue({
      type: 'transport',
      code: 'INVALID_RESPONSE',
    });

    await expect(service.getBalances('E1', 'L1', true)).rejects.toThrow(
      HttpException,
    );
  });

  it('syncFromHcm throws hcmInvalidResponse when batch transport INVALID_RESPONSE', async () => {
    hcm.getBatchBalances.mockResolvedValue({
      type: 'transport',
      code: 'INVALID_RESPONSE',
    });

    await expect(service.syncFromHcm()).rejects.toThrow(HttpException);
  });

  it('syncFromHcm increments recordsFailed when upsert throws', async () => {
    hcm.getBatchBalances.mockResolvedValue({
      type: 'ok',
      balances: [
        {
          employeeId: 'E1',
          locationId: 'L1',
          availableDays: 1,
          version: 1,
        },
      ],
    });
    balanceRepo.findOne.mockResolvedValue(null);
    balanceRepo.save.mockRejectedValueOnce(new Error('db'));

    const res = await service.syncFromHcm();
    expect(res.recordsFailed).toBe(1);
    expect(res.recordsUpserted).toBe(0);
  });

  it('fetches from HCM when no cache and refresh is false', async () => {
    balanceRepo.findOne.mockResolvedValue(null);
    hcm.getBalance.mockResolvedValue({
      type: 'balance',
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 7,
      version: 1,
    });
    balanceRepo.save.mockImplementation(async (x) => x as ReadyOnBalance);

    const res = await service.getBalances('E1', 'L1', false);
    expect(res.availableDays).toBe(7);
    expect(hcm.getBalance).toHaveBeenCalled();
  });
});
