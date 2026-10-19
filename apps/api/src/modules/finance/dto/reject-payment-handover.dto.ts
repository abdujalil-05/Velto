import { ReverseReasonDto } from '../../../common/dto/reverse-reason.dto';

/** ADR-029: body of POST /payments/:id/handover/reject — same mandatory, trimmed, audited reason as a reversal. */
export class RejectPaymentHandoverDto extends ReverseReasonDto {}
