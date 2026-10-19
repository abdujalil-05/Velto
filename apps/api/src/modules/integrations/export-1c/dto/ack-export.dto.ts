import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** ADR-030 manual ACK: the accountant confirms the exact file (SHA-256) was accepted into / rejected by 1C. */
export class AckExportDto {
  @IsIn(['ACCEPTED', 'REJECTED'])
  result!: 'ACCEPTED' | 'REJECTED';

  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/)
  checksum!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
