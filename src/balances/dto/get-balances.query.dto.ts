import { IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class GetBalancesQueryDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  refresh?: boolean;
}
