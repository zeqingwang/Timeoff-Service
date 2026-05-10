import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReadyOnBalance } from './balances/balance.entity';
import { TimeOffRequest } from './timeoff/time-off-request.entity';
import { HcmSyncLog } from './hcm/hcm-sync-log.entity';
import { MockHcmBalance } from './mock-hcm/mock-hcm-balance.entity';
import { MockHcmTimeOffUsage } from './mock-hcm/mock-hcm-time-off-usage.entity';
import { MockHcmModule } from './mock-hcm/mock-hcm.module';
import { HcmModule } from './hcm/hcm.module';
import { BalancesModule } from './balances/balances.module';
import { TimeOffModule } from './timeoff/timeoff.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'sqlite' as const,
        database: process.env.DATABASE_PATH ?? 'timeoff.sqlite',
        entities: [
          ReadyOnBalance,
          TimeOffRequest,
          HcmSyncLog,
          MockHcmBalance,
          MockHcmTimeOffUsage,
        ],
        synchronize: true,
        logging: process.env.TYPEORM_LOGGING === 'true',
      }),
    }),
    MockHcmModule,
    HcmModule,
    BalancesModule,
    TimeOffModule,
  ],
})
export class AppModule {}
