import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryFailedError } from 'typeorm';
import { ApprovalLock } from './approval-lock.entity';
import { approvalInProgress } from '../common/errors';

export function approvalLockKey(
  employeeId: string,
  locationId: string,
): string {
  return `${employeeId}:${locationId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof QueryFailedError) {
    const msg = String(err.message + (err.driverError?.message ?? ''));
    return (
      msg.includes('SQLITE_CONSTRAINT') ||
      msg.includes('UNIQUE constraint') ||
      msg.includes('unique constraint')
    );
  }
  return false;
}

function envMs(key: string, defaultVal: number): number {
  const raw = process.env[key];
  const n = Number(raw ?? defaultVal);
  return Number.isFinite(n) && n >= 0 ? n : defaultVal;
}

@Injectable()
export class ApprovalLockService {
  constructor(
    @InjectRepository(ApprovalLock)
    private readonly lockRepo: Repository<ApprovalLock>,
  ) {}

  async acquire(employeeId: string, locationId: string): Promise<void> {
    const lockKey = approvalLockKey(employeeId, locationId);
    const ttlMs = envMs('APPROVAL_LOCK_TTL_MS', 30_000);
    const timeoutMs = envMs('APPROVAL_LOCK_ACQUIRE_TIMEOUT_MS', 5000);
    const retryDelayMs = envMs('APPROVAL_LOCK_RETRY_DELAY_MS', 50);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await this.deleteExpiredForKey(lockKey);

      const expiresAt = new Date(Date.now() + ttlMs);
      const row = this.lockRepo.create({
        lockKey,
        employeeId,
        locationId,
        expiresAt,
      });

      try {
        await this.lockRepo.save(row);
        return;
      } catch (err) {
        if (!isUniqueConstraintError(err)) {
          throw err;
        }
        const existing = await this.lockRepo.findOne({ where: { lockKey } });
        const now = new Date();
        if (existing && existing.expiresAt <= now) {
          await this.lockRepo.delete({ id: existing.id });
          continue;
        }
        await sleep(retryDelayMs);
      }
    }

    throw approvalInProgress(
      'Another approval is in progress for this employee and location',
    );
  }

  async release(lockKey: string): Promise<void> {
    await this.lockRepo.delete({ lockKey });
  }

  private async deleteExpiredForKey(lockKey: string): Promise<void> {
    await this.lockRepo
      .createQueryBuilder()
      .delete()
      .from(ApprovalLock)
      .where('lock_key = :lockKey AND expires_at < :now', {
        lockKey,
        now: new Date(),
      })
      .execute();
  }
}
