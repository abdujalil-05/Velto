import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { InvoiceStatus } from '@velto/database';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

export class ListInvoicesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;
}
