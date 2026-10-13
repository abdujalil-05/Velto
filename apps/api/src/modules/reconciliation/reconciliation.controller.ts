import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { ListReconciliationFindingsQueryDto } from './dto/list-findings.query';
import { ListReconciliationRunsQueryDto } from './dto/list-runs.query';
import { ReconciliationAdminService } from './reconciliation-admin.service';
import { ReconciliationService } from './reconciliation.service';

@Controller('reconciliation')
export class ReconciliationController {
  constructor(
    private readonly admin: ReconciliationAdminService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Get('runs')
  @RequirePermission('reconciliation.read')
  runs(@Query() q: ListReconciliationRunsQueryDto) {
    return this.admin.listRuns(q);
  }

  @Get('findings')
  @RequirePermission('reconciliation.read')
  findings(@Query() q: ListReconciliationFindingsQueryDto) {
    return this.admin.listFindings(q);
  }

  @Post('run')
  @Idempotent()
  @RequirePermission('reconciliation.fix')
  run(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.runManual(user);
  }

  @Post('findings/:id/fix')
  @Idempotent()
  @RequirePermission('reconciliation.fix')
  fix(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reconciliation.fix(id, user);
  }
}
