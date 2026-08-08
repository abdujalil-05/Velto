import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsLatitude, IsLongitude, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
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

  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @IsEnum(VisitOutcome)
  outcome!: VisitOutcome;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  noOrderReason?: string;

  // Offline idempotency key (10.3) — maps 1:1 to Visit.clientId.
  @IsOptional()
  @IsUUID()
  clientId?: string;
}
