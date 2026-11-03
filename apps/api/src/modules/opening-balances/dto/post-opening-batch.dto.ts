import { Transform } from 'class-transformer';
import { IsBoolean, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * ADR-042: post = operator sign-off against 1C control totals. Totals are
 * exact decimal STRINGS (never floats) and must equal the previewed totals
 * exactly (tolerance 0); a CUSTOMER_BALANCE batch posts with controlQty "0",
 * a STOCK batch with controlDebt/controlCredit "0".
 */
export class PostOpeningBatchDto {
  /** Opening balance date, company calendar day; not in the future. */
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
  asOfDate!: string;

  /** Origin, e.g. "1C: Buxgalteriya, oborotno-saldovaya 30.09". */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  source!: string;

  @Matches(/^\d{1,15}(\.\d{1,2})?$/)
  controlDebt!: string;

  @Matches(/^\d{1,15}(\.\d{1,2})?$/)
  controlCredit!: string;

  @Matches(/^\d{1,9}(\.\d{1,3})?$/)
  controlQty!: string;

  @IsBoolean()
  signOff!: boolean;
}
