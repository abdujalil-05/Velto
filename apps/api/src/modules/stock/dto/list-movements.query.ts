import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { StockMovementType } from '@velto/database';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

export class ListMovementsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsEnum(StockMovementType)
  type?: StockMovementType;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
