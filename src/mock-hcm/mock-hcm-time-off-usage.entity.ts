import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('mock_hcm_time_off_usages')
@Unique(['externalRequestId'])
@Unique(['idempotencyKey'])
export class MockHcmTimeOffUsage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'hcm_transaction_id', type: 'varchar' })
  hcmTransactionId: string;

  @Column({ name: 'external_request_id', type: 'varchar' })
  externalRequestId: string;

  @Column({ name: 'employee_id', type: 'varchar' })
  employeeId: string;

  @Column({ name: 'location_id', type: 'varchar' })
  locationId: string;

  @Column({
    name: 'days',
    type: 'decimal',
    precision: 14,
    scale: 4,
    transformer: {
      to: (v: number | string) => v,
      from: (v: string | null) => (v === null ? null : parseFloat(v)),
    },
  })
  days: number;

  @Column({ name: 'idempotency_key', type: 'varchar' })
  idempotencyKey: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
}
