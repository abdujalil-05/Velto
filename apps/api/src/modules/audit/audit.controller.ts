import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AuditService } from './audit.service';
import { ListAuditLogQueryDto } from './dto/list-audit-log.query';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit.read')
  list(@Query() query: ListAuditLogQueryDto) {
    return this.audit.list(query);
  }
}
