import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { decimalColumnTransformer } from '../common/decimal-column.transformer';

@Entity('readyon_balances')
@Unique(['employeeId', 'locationId'])
export class ReadyOnBalance {
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
    transformer: decimalColumnTransformer,
  })
  availableDays: number;

  @Column({ name: 'last_synced_at', type: 'datetime' })
  lastSyncedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}
