import { IsMoneyAmount } from '../../../common/validators/numeric-bounds';

/** 9.2 "/cash ... Smena ochish". */
export class OpenCashSessionDto {
  @IsMoneyAmount({ allowZero: true })
  openAmount!: number;
}
