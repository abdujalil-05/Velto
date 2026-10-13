import { IsEnum, IsOptional } from 'class-validator';
import { ReconciliationFindingStatus, ReconciliationKind } from '@velto/database';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

export class ListReconciliationFindingsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ReconciliationFindingStatus)
  status?: ReconciliationFindingStatus;

  @IsOptional()
  @IsEnum(ReconciliationKind)
  kind?: ReconciliationKind;
}
