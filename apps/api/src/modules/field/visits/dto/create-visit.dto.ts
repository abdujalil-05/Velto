import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { VisitOutcome } from '@velto/database';

/** 9.4 "Ekran 3 — Tashrif": GPS auto-captured client-side, submitted with the visit once the agent leaves the outlet. */
export class CreateVisitDto {
  @IsUUID()
  outletId!: string;

  // Agent-facing (mobile) calls omit this — the caller is the agent. A
  // supervisor logging a visit on an agent's behalf supplies it explicitly.
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsDateString()
  startedAt!: string;

  @IsOptional()
  @IsDateString()
  endedAt?: string;

  // F3: GPS fields are all optional — the server derives gpsStatus itself
  // (geo.ts evaluateGps); a client-sent gpsOk/gpsStatus is rejected as unknown.
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100000)
  accuracyM?: number;

  @IsOptional()
  @IsDateString()
  capturedAt?: string;

  @IsOptional()
  @IsBoolean()
  permissionDenied?: boolean;

  @IsEnum(VisitOutcome)
  outcome!: VisitOutcome;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  noOrderReason?: string;

  // Required (non-blank) iff outcome === SKIPPED, enforced in VisitsService.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  skipReason?: string;

  // Offline idempotency key (10.3) — maps 1:1 to Visit.clientId.
  @IsOptional()
  @IsUUID()
  clientId?: string;
}
