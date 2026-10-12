import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PurchaseOrderStatus } from '@velto/database';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';
import { IsMoneyAmount, IsQuantity } from '../../../common/validators/numeric-bounds';

export class CreatePurchaseOrderLineDto {
  @IsUUID()
  productId!: string;

  // Base unit, Decimal(18,3) — more precision would be silently rounded by
  // Postgres and break the qty − qtyReceived arithmetic, so reject it.
  @IsQuantity()
  @IsNumber({ maxDecimalPlaces: 3 })
  qty!: number;

  // Supplier's net price per base unit (excl. VAT), Decimal(18,2).
  @IsMoneyAmount({ allowZero: true })
  @IsNumber({ maxDecimalPlaces: 2 })
  unitPrice!: number;
}

export class CreatePurchaseOrderDto {
  @IsUUID()
  supplierId!: string;

  @IsUUID()
  warehouseId!: string;

  // A PO is born DRAFT (default) or directly ORDERED — never in a receipt state.
  @IsOptional()
  @IsIn([PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.ORDERED])
  status?: 'DRAFT' | 'ORDERED';

  @IsOptional()
  @IsDateString()
  expectedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderLineDto)
  lines!: CreatePurchaseOrderLineDto[];
}

export class ListPurchaseOrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(PurchaseOrderStatus)
  status?: PurchaseOrderStatus;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
