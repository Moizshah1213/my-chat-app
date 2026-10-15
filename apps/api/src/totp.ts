import { authenticator } from 'otplib';
import { encryptSecret, decryptSecret } from './crypto.js';
import { config } from './config.js';

/**
 * TOTP 2FA (blueprint §7.1). The secret is stored ENCRYPTED at rest (AES-256-GCM).
 * Recovery codes are hashed (argon2id) by the auth service, not here.
 */
export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpUri(secret: string, email: string): string {
  return authenticator.keyuri(email, config.productName, secret);
}

export function verifyTotp(secret: string, code: string): boolean {
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}

/** Encrypt/decrypt the TOTP secret for storage/retrieval. */
export const storeTotpSecret = (secret: string) => encryptSecret(secret);
export const loadTotpSecret = (enc: string) => decryptSecret(enc);
