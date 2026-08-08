import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

export class ListCashSessionsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;
}
