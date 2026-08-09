import { IsMoneyAmount } from '../../../common/validators/numeric-bounds';

/** 9.2 "/cash ... yopish". */
export class CloseCashSessionDto {
  @IsMoneyAmount({ allowZero: true })
  closeAmount!: number;
}
