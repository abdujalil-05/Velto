import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsPositive, IsUUID, ValidateNested } from 'class-validator';

class ReceivePurchaseOrderLineDto {
  @IsUUID()
  purchaseOrderLineId!: string;

  @Type(() => Number)
  @IsPositive()
  qty!: number;
}

/** 9.2 "/purchases ... qabul qilish" — one receiving event, possibly partial across multiple calls. */
export class ReceivePurchaseOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceivePurchaseOrderLineDto)
  lines!: ReceivePurchaseOrderLineDto[];
}
