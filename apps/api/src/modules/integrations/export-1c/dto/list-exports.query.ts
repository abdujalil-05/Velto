import { PaginationQueryDto } from '../../../../common/pagination/pagination.dto';

/** 11.1: job history for /export/1c — lets the accountant see past export runs and their status. */
export class ListExportsQueryDto extends PaginationQueryDto {}
