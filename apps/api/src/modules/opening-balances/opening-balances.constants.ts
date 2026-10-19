import type { OpeningBalanceKind } from '@velto/database';
import type { RowError, RowMessage } from '../import/import.constants';

/** ADR-041: one batch = one all-or-nothing transaction, so the file is capped. */
export const OPENING_MAX_ROWS = 5000;

/** Post/void write ≤5000 rows in ONE transaction (never chunked) — longer than the 5 s request default. */
export const OPENING_TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 };

/** StockMovement.refType of opening stock rows (DB CHECK StockMovement_opening_shape_check). */
export const OPENING_REF_TYPE = 'OpeningBalance';

/** ImportJob.type holding the uploaded file + validated rows of a batch (kept out of /import). */
export const OPENING_IMPORT_TYPE: Record<OpeningBalanceKind, string> = {
  CUSTOMER_BALANCE: 'opening-customers',
  STOCK: 'opening-stock',
};

/** One open 1C document (DEBT -> OPENING invoice) or the customer's advance (CREDIT -> OPENING payment). */
export interface OpeningCustomerRow {
  rowNumber: number;
  customerId: string;
  customerCode: string;
  side: 'DEBT' | 'CREDIT';
  amount: string; // Decimal(18,2) as exact string
  docRef: string | null;
  docDate: string | null; // YYYY-MM-DD
}

export interface OpeningStockRow {
  rowNumber: number;
  productId: string;
  sku: string;
  warehouseId: string;
  warehouseName: string;
  qty: string; // Decimal(18,3) as exact string
}

export interface OpeningWarning {
  code: string;
  message: RowMessage;
  batchIds: string[];
}

/** Stored as ImportJob.errorLog of the batch's ImportJob; `rows` are what post() writes. */
export interface OpeningReport<T> {
  totalRows: number;
  validCount: number;
  invalidCount: number;
  errors: RowError[];
  warnings: OpeningWarning[];
  rows: T[];
}
