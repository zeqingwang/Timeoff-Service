import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { TimeOffRequestStatus } from '../timeoff/time-off-status';

@Entity('time_off_requests')
@Unique(['requestId'])
export class TimeOffRequest {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'request_id', type: 'varchar' })
  requestId: string;

  @Column({ name: 'employee_id', type: 'varchar' })
  employeeId: string;

  @Column({ name: 'location_id', type: 'varchar' })
  locationId: string;

  @Column({
    name: 'requested_days',
    type: 'decimal',
    precision: 14,
    scale: 4,
    transformer: {
      to: (v: number | string) => v,
      from: (v: string | null) => (v === null ? null : parseFloat(v)),
    },
  })
  requestedDays: number;

  @Column({ name: 'status', type: 'varchar' })
  status: TimeOffRequestStatus;

  @Column({ name: 'manager_id', type: 'varchar', nullable: true })
  managerId: string | null;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason: string | null;

  @Column({ name: 'hcm_transaction_id', type: 'varchar', nullable: true })
  hcmTransactionId: string | null;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    nullable: true,
    unique: true,
  })
  idempotencyKey: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}
