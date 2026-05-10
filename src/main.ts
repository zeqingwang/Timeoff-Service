import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: false,
    }),
  );
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  process.env.PORT = String(port);
  if (!process.env.HCM_BASE_URL) {
    process.env.HCM_BASE_URL = `http://127.0.0.1:${port}/mock-hcm`;
  }
}
void bootstrap();
