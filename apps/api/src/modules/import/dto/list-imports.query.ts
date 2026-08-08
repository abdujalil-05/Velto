import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';
import type { ImportType } from '../import.constants';

export class ListImportsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['customers', 'products'])
  type?: ImportType;
}
