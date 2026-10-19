import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsObject, IsUUID, ValidateNested } from 'class-validator';

/** 10.1: the three document types a mobile client generates offline. */
export enum SyncDocType {
  ORDER = 'order',
  VISIT = 'visit',
  PAYMENT = 'payment',
}

/**
 * 10.3: one queued offline document. `payload` shape depends on `type` — it
 * is re-validated inside SyncService against the matching Create*Dto
 * (CreateOrderDto / CreateVisitDto / CreatePaymentDto), the same way each
 * document's own dedicated endpoint validates it. Kept loose here
 * (`Record<string, unknown>`) because class-validator has no built-in
 * discriminated-union support for nested DTOs.
 */
export class SyncPushDocumentDto {
  @IsEnum(SyncDocType)
  type!: SyncDocType;

  // Also present inside `payload` (every Create*Dto carries its own
  // clientId) — duplicated here too so results can be keyed by it even when
  // payload validation itself fails.
  @IsUUID()
  clientId!: string;

  @IsObject()
  payload!: Record<string, unknown>;
}

/**
 * Absolute ceiling for one push batch; also the upper bound of the
 * SYNC_PUSH_MAX_BATCH env var (env.schema.ts). The effective, configurable
 * limit (default 20) is enforced in SyncService.push() — decorators are
 * evaluated at class-definition time and can't read ConfigService.
 */
export const SYNC_PUSH_HARD_MAX_BATCH = 100;

/** 7.3 / 10.3: "20 tadan guruhlangan hujjatlar" — up to SYNC_PUSH_MAX_BATCH (default 20) documents per push. */
export class SyncPushDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SYNC_PUSH_HARD_MAX_BATCH)
  @ValidateNested({ each: true })
  @Type(() => SyncPushDocumentDto)
  documents!: SyncPushDocumentDto[];
}

/**
 * Per-document push outcome (F4). Client handling:
 * - ACCEPTED / DUPLICATE: done; `id` = server id (DUPLICATE: the existing doc's id).
 * - CONFLICT: not written; needs user action on the device (e.g. `PRICE_CHANGED`
 *   — re-confirm at the new price, then re-push with a *new* clientId or the same one).
 * - REJECTED: permanently refused (validation, blocked customer, permission) — surface `error`.
 * - RETRY: transient server-side failure (serialization/deadlock/lock timeout/infra);
 *   keep the item PENDING and retry later with backoff, same clientId.
 */
export type SyncDocStatus = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'CONFLICT' | 'RETRY';

export interface SyncLocalizedMessage {
  uz: string;
  ru: string;
  en: string;
}

export interface SyncPushError {
  /** Stable machine code, e.g. PRICE_CHANGED, SALES_CUSTOMER_BLOCKED, SYNC_VALIDATION_FAILED, SYNC_RETRY. */
  code: string;
  /** Uzbek message (kept a plain string for backward compatibility). */
  message: string;
  /** Trilingual message (new, optional). */
  messages?: SyncLocalizedMessage;
  /** Structured details, e.g. PriceChangedDetails for PRICE_CHANGED. */
  details?: unknown;
}

/** `error.details` shape when `error.code === 'PRICE_CHANGED'`. Money as decimal strings (2 dp). */
export interface PriceChangedDetails {
  lines: {
    lineIndex: number;
    productId: string;
    packagingId: string;
    expectedUnitPrice: string;
    serverUnitPrice: string;
  }[];
  expectedTotal: string;
  serverTotal: string;
}

export interface SyncPushResultItem {
  clientId: string;
  status: SyncDocStatus;
  id?: string;
  /** Visit entries only: server-computed GPS verdict (stored value for DUPLICATE). */
  gpsStatus?: string;
  /** Visit entries only: decimal string metres from the outlet, null when not computable. */
  distanceM?: string | null;
  /** Payment entries only (ADR-029): PENDING_HANDOVER for agent cash, POSTED otherwise. */
  paymentStatus?: string;
  error?: SyncPushError;
}

export interface SyncPushResponse {
  results: SyncPushResultItem[];
}
