import type { TraceableJobData } from '../../common/queue/trace-job';

export const COMPANY_EXPORT_QUEUE = 'company-export';
export const COMPANY_EXPORT_TYPE = 'company';

export interface CompanyExportJobData extends TraceableJobData {
  exportJobId: string;
  companyId: string;
}

/** Same retry policy as the 1C export: bounded attempts, exponential backoff (7.5). */
export const COMPANY_EXPORT_JOB_OPTS = { attempts: 3, backoff: { type: 'exponential' as const, delay: 10_000 }, removeOnComplete: 1000, removeOnFail: 5000 };

/** At most one QUEUED/PROCESSING company export per company (ADR-045). */
export const MAX_ACTIVE_COMPANY_EXPORTS = 1;

/** Bumped whenever the sheet/column layout changes. */
export const COMPANY_EXPORT_MAPPING_VERSION = 2;

/** Rows fetched per cursor page: bounded memory regardless of table size. */
export const COMPANY_EXPORT_PAGE_SIZE = 2000;

/** Excel hard limit (header included); a bigger sheet is split into name, name_2, name_3... */
export const XLSX_MAX_SHEET_ROWS = 1_048_576;

/** Liveness bump every N cursor pages inside a sheet (sweep fails PROCESSING after 15 min without updatedAt change). */
export const COMPANY_EXPORT_HEARTBEAT_EVERY_PAGES = 5;

/** One REPEATABLE READ snapshot spans the whole read phase; generous bound for very large tenants. */
export const COMPANY_EXPORT_READ_TIMEOUT_MS = 30 * 60_000;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Tenant-prefixed, deterministic key (a retry overwrites the same object). */
export function companyExportStorageKey(companyId: string, jobId: string): string {
  return `exports/company/${companyId}/${jobId}.xlsx`;
}
