import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OutletInputDto } from '../outlets/dto/outlet-input.dto';

export class CreateCustomerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactPerson?: string;

  @IsOptional()
  @IsUUID()
  priceListId?: string;

  // Max is not cosmetic: the column is `integer` (schema 6.3), so an unbounded
  // @IsInt() lets 3_000_000_000 through and Postgres answers SQLSTATE 22003.
  // 10 years is far past any real payment term.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  paymentTermDays?: number;

  // A customer with no outlet isn't useful in the field (6.3) — the create
  // form can seed the first outlet(s) in the same request.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OutletInputDto)
  outlets?: OutletInputDto[];
}
