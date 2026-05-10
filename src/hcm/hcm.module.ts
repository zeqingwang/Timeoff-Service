import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { HCM_CLIENT } from './hcm-client.interface';
import { HttpHcmClient } from './http-hcm-client.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: Number(process.env.HCM_TIMEOUT_MS ?? 30000),
    }),
  ],
  providers: [
    HttpHcmClient,
    { provide: HCM_CLIENT, useExisting: HttpHcmClient },
  ],
  exports: [HCM_CLIENT, HttpHcmClient],
})
export class HcmModule {}
