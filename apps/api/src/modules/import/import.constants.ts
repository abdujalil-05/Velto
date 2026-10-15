import type { TraceableJobData } from '../../common/queue/trace-job';

export const IMPORT_QUEUE = 'import-commit';

export type ImportType = 'customers' | 'products';

export interface ImportJobData extends TraceableJobData {
  importJobId: string;
  companyId: string;
  /** Actor who confirmed the import; used for the audit row (ImportJob.createdBy holds the uploader). */
  userId?: string;
}

/** Shared shape for a single row's problems, regardless of import type. */
export interface RowMessage {
  uz: string;
  ru: string;
  en: string;
}

export interface RowError {
  row: number; // 1-based, matching the spreadsheet's visible row number (header = row 1)
  messages: string[]; // uz text (legacy shape, kept for the web table)
  i18n?: RowMessage[]; // same messages, trilingual (parallel to `messages`)
}

/** Rows per commit transaction; progress is persisted (and visible to pollers) after each chunk. */
export const IMPORT_COMMIT_CHUNK = 200;

/** A 200-row chunk tx must not hit Prisma's 5 s default under CPU/DB load (it rolled back and failed imports); progress is still persisted per chunk. */
export const IMPORT_CHUNK_TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 };

/** Queue retry policy: exponential backoff, bounded attempts (7.5). */
export const IMPORT_JOB_OPTS = { attempts: 3, backoff: { type: 'exponential' as const, delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 };

/**
 * Stored as ImportJob.errorLog (Json?) — despite the field's name (inherited
 * from the model as originally designed), it holds the full report for both
 * phases, not only errors: after validate() it's the review data the
 * "validatsiya xatolari jadvali" screen (9.2) renders, with `rows` present
 * so confirm() has something to commit without re-reading the uploaded
 * file; after confirm() it's overwritten with the commit outcome (`rows` is
 * dropped — no longer needed once committed).
 */
export interface ImportJobReport<T> {
  totalRows: number;
  validCount: number;
  invalidCount: number;
  errors: RowError[];
  rows?: T[]; // present only between validate() and confirm()
  createdCount?: number; // present only after confirm()
  skippedCount?: number; // present only after confirm()
  commit?: ImportCommitState; // present only while PROCESSING (chunk cursor)
}

/** Abuse limits for uploaded workbooks (zip bombs / huge sheets). */
export const IMPORT_LIMITS = {
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxZipEntries: 1000,
  maxDataRows: 20_000,
  /** Physical rows scanned (incl. blank formatted rows) before giving up. */
  maxScannedRows: 100_000,
  maxColumns: 100,
};

/** Resume cursor persisted inside ImportJob.errorLog.commit, updated atomically with every committed chunk. */
export interface ImportCommitState {
  nextIndex: number;
  createdCount: number;
  skippedCount: number;
  errors: RowError[];
}
