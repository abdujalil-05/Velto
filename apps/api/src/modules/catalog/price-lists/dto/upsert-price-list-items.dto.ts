import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsUUID, ValidateNested } from 'class-validator';
import { IsMoneyAmount } from '../../../../common/validators/numeric-bounds';

class PriceListItemInput {
  @IsUUID()
  productId!: string;

  @IsMoneyAmount()
  price!: number;
}

/** 9.2 "/price-lists ... jadval ko'rinishida narx tahrirlash" — one bulk save for the whole edited table. */
export class UpsertPriceListItemsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PriceListItemInput)
  items!: PriceListItemInput[];
}
