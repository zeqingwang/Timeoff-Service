import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateTimeOffRequestDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001, { message: 'Requested days must be greater than 0' })
  requestedDays: number;
}

export class ApproveTimeOffDto {
  @IsString()
  managerId: string;
}

export class RejectTimeOffDto {
  @IsString()
  managerId: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

/** Employee must match the request owner (stub auth for take-home). */
export class CancelTimeOffDto {
  @IsString()
  employeeId: string;
}
