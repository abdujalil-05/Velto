import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { TenantTx } from '../../common/tenant/tenant-tx-options.decorator';
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
  runs(@Query() q: ListReconciliationRunsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.listRuns(q, user);
  }

  @Get('findings')
  @RequirePermission('reconciliation.read')
  findings(@Query() q: ListReconciliationFindingsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.listFindings(q, user);
  }

  @Post('run')
  @RequirePermission('reconciliation.fix')
  @TenantTx({ scope: 'handler' })
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
