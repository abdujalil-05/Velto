import { randomBytes } from 'node:crypto';

// ADR-058: tests never use a real key; a fresh random one per test process unless the env already provides one.
process.env.MFA_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
