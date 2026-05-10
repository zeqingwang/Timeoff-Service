import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { TimeOffService } from './timeoff.service';
import {
  ApproveTimeOffDto,
  CreateTimeOffRequestDto,
  RejectTimeOffDto,
} from './dto/timeoff.dto';

@Controller('time-off-requests')
export class TimeOffController {
  constructor(private readonly timeOffService: TimeOffService) {}

  @Post()
  @HttpCode(200)
  async create(@Body() dto: CreateTimeOffRequestDto) {
    return this.timeOffService.createRequest(dto);
  }

  @Get(':requestId')
  async getOne(@Param('requestId') requestId: string) {
    return this.timeOffService.getRequest(requestId);
  }

  @Post(':requestId/approve')
  @HttpCode(200)
  async approve(
    @Param('requestId') requestId: string,
    @Body() dto: ApproveTimeOffDto,
  ) {
    return this.timeOffService.approve(requestId, dto.managerId);
  }

  @Post(':requestId/reject')
  @HttpCode(200)
  async reject(
    @Param('requestId') requestId: string,
    @Body() dto: RejectTimeOffDto,
  ) {
    return this.timeOffService.reject(requestId, dto.managerId, dto.reason);
  }
}

@Controller('employees')
export class EmployeeTimeOffController {
  constructor(private readonly timeOffService: TimeOffService) {}

  @Get(':employeeId/time-off-requests')
  async listForEmployee(
    @Param('employeeId') employeeId: string,
    @Query('status') status?: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.timeOffService.listForEmployee(employeeId, status, locationId);
  }
}
