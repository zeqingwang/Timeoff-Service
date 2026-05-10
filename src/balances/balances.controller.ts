import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { BalancesService } from './balances.service';
import { GetBalancesQueryDto } from './dto/get-balances.query.dto';

@Controller()
export class BalancesController {
  constructor(private readonly balancesService: BalancesService) {}

  @Get('balances')
  async getBalances(@Query() query: GetBalancesQueryDto) {
    return this.balancesService.getBalances(
      query.employeeId,
      query.locationId,
      query.refresh,
    );
  }

  @Post('balances/sync-from-hcm')
  @HttpCode(200)
  async syncFromHcm() {
    return this.balancesService.syncFromHcm();
  }
}
