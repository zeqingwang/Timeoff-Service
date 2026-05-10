import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MockHcmBalance } from './mock-hcm-balance.entity';
import { MockHcmTimeOffUsage } from './mock-hcm-time-off-usage.entity';
import { MockHcmController } from './mock-hcm.controller';
import { MockHcmService } from './mock-hcm.service';

@Module({
  imports: [TypeOrmModule.forFeature([MockHcmBalance, MockHcmTimeOffUsage])],
  controllers: [MockHcmController],
  providers: [MockHcmService],
  exports: [MockHcmService],
})
export class MockHcmModule {}
