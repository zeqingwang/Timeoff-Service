import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReadyOnBalance } from './balance.entity';
import { HcmSyncLog } from '../hcm/hcm-sync-log.entity';
import { BalancesController } from './balances.controller';
import { BalancesService } from './balances.service';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [TypeOrmModule.forFeature([ReadyOnBalance, HcmSyncLog]), HcmModule],
  controllers: [BalancesController],
  providers: [BalancesService],
  exports: [BalancesService],
})
export class BalancesModule {}
