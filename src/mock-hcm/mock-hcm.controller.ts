import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Response } from 'express';
import { MockHcmService } from './mock-hcm.service';
import { MockHcmFailureMode } from './mock-hcm-failure-mode';
import {
  MockHcmFailureModeDto,
  MockHcmSubmitUsageDto,
  MockHcmTestBalanceDto,
} from './dto/mock-hcm.dto';

@Controller('mock-hcm')
export class MockHcmController {
  constructor(private readonly mockHcmService: MockHcmService) {}

  @Get('balances')
  async getBalances(
    @Query('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (this.mockHcmService.getFailureMode() === MockHcmFailureMode.TIMEOUT) {
      await new Promise(() => {});
      return;
    }
    if (
      this.mockHcmService.getFailureMode() === MockHcmFailureMode.SERVER_ERROR
    ) {
      throw new InternalServerErrorException('Simulated HCM server error');
    }
    if (
      this.mockHcmService.getFailureMode() ===
      MockHcmFailureMode.MALFORMED_RESPONSE
    ) {
      res.type('application/json').send('{not-json');
      return;
    }
    const result = await this.mockHcmService.getBalance(employeeId, locationId);
    if (!result.ok) {
      return {
        errorCode: result.errorCode,
        message: result.message,
      };
    }
    return {
      employeeId: result.data.employeeId,
      locationId: result.data.locationId,
      availableDays: result.data.availableDays,
      version: result.data.version,
    };
  }

  @Get('balances/batch')
  async getBatch(@Res({ passthrough: true }) res: Response) {
    if (this.mockHcmService.getFailureMode() === MockHcmFailureMode.TIMEOUT) {
      await new Promise(() => {});
      return;
    }
    if (
      this.mockHcmService.getFailureMode() === MockHcmFailureMode.SERVER_ERROR
    ) {
      throw new InternalServerErrorException('Simulated HCM server error');
    }
    if (
      this.mockHcmService.getFailureMode() ===
      MockHcmFailureMode.MALFORMED_RESPONSE
    ) {
      res.type('text/plain').send('not-json');
      return;
    }
    const balances = await this.mockHcmService.getBatchBalances();
    return { balances };
  }

  @Post('time-off-usages')
  @HttpCode(200)
  async submitUsage(
    @Body() body: MockHcmSubmitUsageDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (this.mockHcmService.getFailureMode() === MockHcmFailureMode.TIMEOUT) {
      await new Promise(() => {});
      return;
    }
    if (
      this.mockHcmService.getFailureMode() === MockHcmFailureMode.SERVER_ERROR
    ) {
      throw new InternalServerErrorException('Simulated HCM server error');
    }
    if (
      this.mockHcmService.getFailureMode() ===
      MockHcmFailureMode.MALFORMED_RESPONSE
    ) {
      res.type('application/json').send('{');
      return;
    }
    const result = await this.mockHcmService.submitTimeOffUsage(body);
    if (!result.success) {
      return {
        success: false,
        errorCode: result.errorCode,
        message: result.message,
        currentBalance: result.currentBalance,
      };
    }
    return {
      success: true,
      hcmTransactionId: result.hcmTransactionId,
      remainingDays: result.remainingDays,
      ...(result.idempotentReplay ? { idempotentReplay: true } : {}),
    };
  }

  @Post('test/balances')
  @HttpCode(200)
  async testBalances(@Body() body: MockHcmTestBalanceDto) {
    const isValid = body.isValid !== false;
    await this.mockHcmService.seedOrUpdateBalance({
      employeeId: body.employeeId,
      locationId: body.locationId,
      availableDays: body.availableDays,
      isValid,
    });
    return { ok: true };
  }

  @Post('test/failure-mode')
  @HttpCode(200)
  setFailureMode(@Body() body: MockHcmFailureModeDto) {
    const mode = body.mode as MockHcmFailureMode;
    if (!Object.values(MockHcmFailureMode).includes(mode)) {
      return { ok: false, message: 'Invalid mode' };
    }
    this.mockHcmService.setFailureMode(mode);
    return { ok: true, mode };
  }
}
