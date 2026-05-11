import { Test } from '@nestjs/testing';
import { BalancesController } from '../../src/balances/balances.controller';
import { BalancesService } from '../../src/balances/balances.service';
import { GetBalancesQueryDto } from '../../src/balances/dto/get-balances.query.dto';

describe('BalancesController', () => {
  let controller: BalancesController;
  let balancesService: jest.Mocked<
    Pick<BalancesService, 'getBalances' | 'syncFromHcm'>
  >;

  beforeEach(async () => {
    balancesService = {
      getBalances: jest.fn(),
      syncFromHcm: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BalancesController],
      providers: [{ provide: BalancesService, useValue: balancesService }],
    }).compile();

    controller = moduleRef.get(BalancesController);
  });

  it('getBalances forwards employeeId, locationId, and refresh to service', async () => {
    balancesService.getBalances.mockResolvedValue({
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 1,
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      source: 'HCM_CACHE',
    });

    const query = {
      employeeId: 'E1',
      locationId: 'L1',
      refresh: true,
    } as GetBalancesQueryDto;

    await controller.getBalances(query);

    expect(balancesService.getBalances).toHaveBeenCalledWith('E1', 'L1', true);
  });

  it('getBalances passes undefined refresh when omitted', async () => {
    balancesService.getBalances.mockResolvedValue({
      employeeId: 'E1',
      locationId: 'L1',
      availableDays: 2,
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      source: 'HCM_CACHE',
    });

    const query = {
      employeeId: 'E1',
      locationId: 'L1',
    } as GetBalancesQueryDto;

    await controller.getBalances(query);

    expect(balancesService.getBalances).toHaveBeenCalledWith(
      'E1',
      'L1',
      undefined,
    );
  });

  it('syncFromHcm delegates to service', async () => {
    balancesService.syncFromHcm.mockResolvedValue({
      status: 'SUCCESS',
      recordsReceived: 0,
      recordsUpserted: 0,
      recordsFailed: 0,
    });

    await controller.syncFromHcm();

    expect(balancesService.syncFromHcm).toHaveBeenCalledTimes(1);
  });
});
