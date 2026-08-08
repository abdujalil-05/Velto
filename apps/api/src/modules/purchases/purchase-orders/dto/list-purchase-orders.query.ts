import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PurchaseOrderStatus } from '@velto/database';
import { PaginationQueryDto } from '../../../../common/pagination/pagination.dto';

export class ListPurchaseOrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsEnum(PurchaseOrderStatus)
  status?: PurchaseOrderStatus;
}
