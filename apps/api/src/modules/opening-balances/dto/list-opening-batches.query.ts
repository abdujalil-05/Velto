import { IsEnum, IsOptional } from 'class-validator';
import { OpeningBalanceKind, OpeningBalanceStatus } from '@velto/database';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

export class ListOpeningBatchesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(OpeningBalanceKind)
  kind?: OpeningBalanceKind;

  @IsOptional()
  @IsEnum(OpeningBalanceStatus)
  status?: OpeningBalanceStatus;
}
