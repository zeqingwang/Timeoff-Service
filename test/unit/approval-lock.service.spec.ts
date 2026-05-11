import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { ApprovalLock } from '../../src/timeoff/approval-lock.entity';
import {
  ApprovalLockService,
  approvalLockKey,
} from '../../src/timeoff/approval-lock.service';
import { ErrorCodes } from '../../src/common/error-codes';

describe('ApprovalLockService', () => {
  let moduleRef: TestingModule;
  let service: ApprovalLockService;

  const originalEnv = {
    TTL: process.env.APPROVAL_LOCK_TTL_MS,
    TIMEOUT: process.env.APPROVAL_LOCK_ACQUIRE_TIMEOUT_MS,
    DELAY: process.env.APPROVAL_LOCK_RETRY_DELAY_MS,
  };

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
    process.env.APPROVAL_LOCK_TTL_MS = originalEnv.TTL;
    process.env.APPROVAL_LOCK_ACQUIRE_TIMEOUT_MS = originalEnv.TIMEOUT;
    process.env.APPROVAL_LOCK_RETRY_DELAY_MS = originalEnv.DELAY;
  });

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [ApprovalLock],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([ApprovalLock]),
      ],
      providers: [ApprovalLockService],
    }).compile();
    service = moduleRef.get(ApprovalLockService);
  });

  it('approvalLockKey joins employee and location', () => {
    expect(approvalLockKey('E1', 'L2')).toBe('E1:L2');
  });

  it('acquire and release allow a second acquire', async () => {
    await service.acquire('E1', 'L1');
    await service.release(approvalLockKey('E1', 'L1'));
    await expect(service.acquire('E1', 'L1')).resolves.toBeUndefined();
    await service.release(approvalLockKey('E1', 'L1'));
  });

  it('throws APPROVAL_IN_PROGRESS when lock held until timeout', async () => {
    process.env.APPROVAL_LOCK_ACQUIRE_TIMEOUT_MS = '60';
    process.env.APPROVAL_LOCK_RETRY_DELAY_MS = '15';
    process.env.APPROVAL_LOCK_TTL_MS = '60000';

    await service.acquire('E1', 'L1');

    try {
      await service.acquire('E1', 'L1');
      throw new Error('expected ConflictException');
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      const body = (e as ConflictException).getResponse() as {
        errorCode: string;
      };
      expect(body.errorCode).toBe(ErrorCodes.APPROVAL_IN_PROGRESS);
    }

    await service.release(approvalLockKey('E1', 'L1'));
  });

  it('allows acquire after lock expires (TTL) without release', async () => {
    process.env.APPROVAL_LOCK_TTL_MS = '15';
    process.env.APPROVAL_LOCK_ACQUIRE_TIMEOUT_MS = '5000';
    process.env.APPROVAL_LOCK_RETRY_DELAY_MS = '5';

    await service.acquire('E1', 'L1');
    await new Promise((r) => setTimeout(r, 60));

    await expect(service.acquire('E1', 'L1')).resolves.toBeUndefined();
    await service.release(approvalLockKey('E1', 'L1'));
  });
});

function uniqueConstraintQueryFailed(): QueryFailedError {
  const driverError = {
    message:
      'SQLITE_CONSTRAINT: UNIQUE constraint failed: approval_locks.lock_key',
  };
  return new QueryFailedError('INSERT', [], driverError as Error);
}

describe('ApprovalLockService (mocked repository)', () => {
  let service: ApprovalLockService;
  let save: jest.Mock;
  let findOne: jest.Mock;
  let deleteFn: jest.Mock;
  let create: jest.Mock;
  let qbExecute: jest.Mock;

  beforeEach(() => {
    save = jest.fn();
    findOne = jest.fn();
    deleteFn = jest.fn();
    create = jest.fn((x: unknown) => x as ApprovalLock);
    qbExecute = jest.fn().mockResolvedValue(undefined);
    const qb = {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: qbExecute,
    };
    const repo = {
      create,
      save,
      findOne,
      delete: deleteFn,
      createQueryBuilder: jest.fn(() => qb),
    };
    service = new ApprovalLockService(repo as never);
  });

  it('rethrows plain errors from save', async () => {
    save.mockRejectedValue(new Error('disk full'));
    await expect(service.acquire('E1', 'L1')).rejects.toThrow('disk full');
  });

  it('rethrows QueryFailedError that is not a unique violation', async () => {
    const driver = { message: 'SQLITE_ERROR: no such table' };
    save.mockRejectedValue(new QueryFailedError('x', [], driver as Error));
    await expect(service.acquire('E1', 'L1')).rejects.toBeInstanceOf(
      QueryFailedError,
    );
  });

  it('deletes expired conflicting lock and succeeds on retry', async () => {
    process.env.APPROVAL_LOCK_ACQUIRE_TIMEOUT_MS = '5000';
    process.env.APPROVAL_LOCK_RETRY_DELAY_MS = '0';
    process.env.APPROVAL_LOCK_TTL_MS = '30000';

    let saveAttempt = 0;
    save.mockImplementation(async () => {
      saveAttempt += 1;
      if (saveAttempt === 1) {
        throw uniqueConstraintQueryFailed();
      }
    });
    findOne.mockResolvedValue({
      id: 7,
      lockKey: 'E1:L1',
      employeeId: 'E1',
      locationId: 'L1',
      expiresAt: new Date(Date.now() - 1000),
    });
    deleteFn.mockResolvedValue({ affected: 1 });

    await expect(service.acquire('E1', 'L1')).resolves.toBeUndefined();

    expect(deleteFn).toHaveBeenCalledWith({ id: 7 });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('acquire still works when env values are invalid (falls back to defaults)', async () => {
    process.env.APPROVAL_LOCK_TTL_MS = 'not-a-number';
    process.env.APPROVAL_LOCK_ACQUIRE_TIMEOUT_MS = '-1';
    process.env.APPROVAL_LOCK_RETRY_DELAY_MS = 'NaN';

    save.mockResolvedValue(undefined);

    await expect(service.acquire('E9', 'L9')).resolves.toBeUndefined();
  });

  it('detects unique violation from lowercase "unique constraint" message', async () => {
    process.env.APPROVAL_LOCK_ACQUIRE_TIMEOUT_MS = '5000';
    process.env.APPROVAL_LOCK_RETRY_DELAY_MS = '0';
    process.env.APPROVAL_LOCK_TTL_MS = '30000';

    let saveAttempt = 0;
    save.mockImplementation(async () => {
      saveAttempt += 1;
      if (saveAttempt === 1) {
        throw new QueryFailedError('', [], {
          message:
            'duplicate key value violates unique constraint "approval_locks_lock_key_key"',
        } as Error);
      }
    });
    findOne.mockResolvedValue({
      id: 11,
      lockKey: 'E1:L1',
      employeeId: 'E1',
      locationId: 'L1',
      expiresAt: new Date(Date.now() - 500),
    });
    deleteFn.mockResolvedValue({ affected: 1 });

    await expect(service.acquire('E1', 'L1')).resolves.toBeUndefined();
    expect(deleteFn).toHaveBeenCalledWith({ id: 11 });
  });
});
