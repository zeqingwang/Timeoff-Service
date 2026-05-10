import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'http';
import { AppModule } from '../../src/app.module';

export async function createE2eApp(): Promise<INestApplication> {
  process.env.DATABASE_PATH = join(tmpdir(), `e2e-${randomUUID()}.sqlite`);
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: false,
    }),
  );
  await app.init();
  await app.listen(0);
  const server = app.getHttpServer() as Server;
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('Could not determine listen port for e2e app');
  }
  const port = addr.port;
  process.env.HCM_BASE_URL = `http://127.0.0.1:${port}/mock-hcm`;
  process.env.PORT = String(port);
  return app;
}
