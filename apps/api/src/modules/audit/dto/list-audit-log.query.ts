import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';

// 9.2 /audit is a plain list for MVP — filter/search UI is [v1.1], so this
// query DTO deliberately carries no filter fields yet, only pagination.
export class ListAuditLogQueryDto extends PaginationQueryDto {}
