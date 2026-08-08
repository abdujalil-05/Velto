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

/** 7.3 / 10.3: "20 tadan guruhlangan hujjatlar" — up to 20 documents per push. */
export class SyncPushDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SyncPushDocumentDto)
  documents!: SyncPushDocumentDto[];
}
