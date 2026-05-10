import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class MockHcmTestBalanceDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  availableDays: number;

  @IsOptional()
  @IsBoolean()
  isValid?: boolean;
}

export class MockHcmFailureModeDto {
  @IsString()
  mode: string;
}

export class MockHcmSubmitUsageDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  days: number;

  @IsString()
  externalRequestId: string;

  @IsString()
  idempotencyKey: string;
}
