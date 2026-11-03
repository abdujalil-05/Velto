import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

const ISSUER = 'Velto';
/** ±30 s clock-skew tolerance (ADR-058). */
const EPOCH_TOLERANCE_SECONDS = 30;

export function newTotpSecret(): string {
  return generateSecret();
}

export async function totpEnrollmentArtifacts(secret: string, label: string): Promise<{ otpauthUri: string; qrDataUrl: string }> {
  const otpauthUri = generateURI({ issuer: ISSUER, label, secret });
  return { otpauthUri, qrDataUrl: await QRCode.toDataURL(otpauthUri) };
}

/**
 * Returns the accepted RFC 6238 time step, or null. Steps `<= lastUsedStep` are rejected (replay);
 * (otplib requires afterTimeStep >= 0; the column's -1 sentinel means "none"). The caller must still win the atomic `lastUsedStep < step` UPDATE before trusting the result.
 */
export async function checkTotp(secret: string, code: string, lastUsedStep: number): Promise<number | null> {
  try {
    const result = await verify({ secret, token: code, epochTolerance: EPOCH_TOLERANCE_SECONDS, afterTimeStep: Math.max(lastUsedStep, 0) });
    return result.valid && 'timeStep' in result ? result.timeStep : null;
  } catch {
    return null;
  }
}
