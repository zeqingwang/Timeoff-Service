import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './time-off-request.entity';
import { ApprovalLock } from './approval-lock.entity';
import {
  TimeOffController,
  EmployeeTimeOffController,
} from './timeoff.controller';
import { TimeOffService } from './timeoff.service';
import { ApprovalLockService } from './approval-lock.service';
import { HcmModule } from '../hcm/hcm.module';
import { BalancesModule } from '../balances/balances.module';
import { ReadyOnBalance } from '../balances/balance.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, ReadyOnBalance, ApprovalLock]),
    HcmModule,
    BalancesModule,
  ],
  controllers: [TimeOffController, EmployeeTimeOffController],
  providers: [TimeOffService, ApprovalLockService],
})
export class TimeOffModule {}
