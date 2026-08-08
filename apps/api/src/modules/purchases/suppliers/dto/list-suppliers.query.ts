import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination.dto';

export class ListSuppliersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  search?: string;
}
