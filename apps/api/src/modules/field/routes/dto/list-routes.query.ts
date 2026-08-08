import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination.dto';

export class ListRoutesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  weekday?: number;
}
