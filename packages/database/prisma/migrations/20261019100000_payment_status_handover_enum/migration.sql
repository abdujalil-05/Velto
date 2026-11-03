-- F8.1 / ADR-029 (TZ §6.5, §6.7.2): agent-collected cash is PENDING_HANDOVER
-- until a cashier accepts it (-> POSTED) or rejects it (-> REJECTED).
-- Separate migration on purpose: a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the same transaction, and the next migration's CHECK
-- constraint references both values. Additive only; no existing row changes.

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PENDING_HANDOVER' BEFORE 'POSTED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REJECTED' AFTER 'POSTED';
