import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { HcmSyncLogStatus, HcmSyncType } from './hcm-sync-types';

@Entity('hcm_sync_logs')
export class HcmSyncLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'sync_type', type: 'varchar' })
  syncType: HcmSyncType;

  @Column({ name: 'status', type: 'varchar' })
  status: HcmSyncLogStatus;

  @Column({ name: 'employee_id', type: 'varchar', nullable: true })
  employeeId: string | null;

  @Column({ name: 'location_id', type: 'varchar', nullable: true })
  locationId: string | null;

  @Column({ name: 'request_id', type: 'varchar', nullable: true })
  requestId: string | null;

  @Column({ name: 'error_code', type: 'varchar', nullable: true })
  errorCode: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
}
