import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('mock_hcm_balances')
@Unique(['employeeId', 'locationId'])
export class MockHcmBalance {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'employee_id', type: 'varchar' })
  employeeId: string;

  @Column({ name: 'location_id', type: 'varchar' })
  locationId: string;

  @Column({
    name: 'available_days',
    type: 'decimal',
    precision: 14,
    scale: 4,
    transformer: {
      to: (v: number | string) => v,
      from: (v: string | null) => (v === null ? null : parseFloat(v)),
    },
  })
  availableDays: number;

  @Column({ name: 'version', type: 'integer', default: 1 })
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}
