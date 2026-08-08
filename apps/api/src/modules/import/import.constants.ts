export const IMPORT_QUEUE = 'import-commit';

export type ImportType = 'customers' | 'products';

export interface ImportJobData {
  importJobId: string;
  companyId: string;
}

/** Shared shape for a single row's problems, regardless of import type. */
export interface RowError {
  row: number; // 1-based, matching the spreadsheet's visible row number (header = row 1)
  messages: string[];
}

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
}
