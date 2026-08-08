import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { ListInvoicesQueryDto } from '../dto/list-invoices.query';
import { InvoicesService } from './invoices.service';

/** 6.6 / 7.2: invoices are read-only from the API — created only as a side effect of SalesService.deliver. */
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequirePermission('invoices.read')
  list(@Query() query: ListInvoicesQueryDto) {
    return this.invoices.list(query);
  }

  @Get(':id')
  @RequirePermission('invoices.read')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.getById(id);
  }
}
