import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConflictException } from '@nestjs/common';
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
