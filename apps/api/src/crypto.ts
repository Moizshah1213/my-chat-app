import { hash, verify } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';

/** Generate a random UUIDv4 (for uuid-typed DB columns like refresh family ids). */
export function generateUuid(): string {
  return randomUUID();
}

/**
 * Cryptographic primitives (blueprint §8.4).
 * - Passwords, refresh tokens, reset tokens, recovery codes: HASHED (argon2id).
 * - API secrets: hashed. - TOTP secrets, integration tokens: ENCRYPTED (AES-256-GCM).
 *
 * ENCRYPTION_KEY must be 32 bytes (hex or raw >= 32 chars). Load from KMS in prod.
 */

const encKey = () => {
  const k = process.env.ENCRYPTION_KEY ?? '';
  // Accept 64-hex-char key, else derive 32 bytes via sha256 of the provided string.
  if (/^[0-9a-f]{64}$/i.test(k)) return Buffer.from(k, 'hex');
  return createHash('sha256').update(k).digest();
};

// --- Password hashing (argon2id) -------------------------------------------
export async function hashPassword(plain: string): Promise<string> {
  // Tuned params: memoryCost 19MiB, timeCost 2, parallelism 1.
  return hash(plain, {
    algorithm: 2, // argon2id
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hashStr: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashStr, plain);
  } catch {
    return false;
  }
}

// --- Opaque tokens ----------------------------------------------------------
/** Generate a 256-bit random token (returned to the client once). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Deterministic sha256 hex for storing/looking up tokens (fast, not a secret KDF). */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Hash a bearer/opaque token for storage. */
export function hashToken(token: string): string {
  return sha256(token);
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// --- At-rest encryption (AES-256-GCM) for TOTP secrets etc. -----------------
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: iv.tag.ciphertext  (all base64url)
  return [iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
  const [ivB, tagB, dataB] = payload.split('.');
  if (!ivB || !tagB || !dataB) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encKey(),
    Buffer.from(ivB, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB, 'base64url')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

// --- Secret vault (key id + tenant-bound AAD) -------------------------------
// Format: v1.<kid>.<iv>.<tag>.<ct> (all base64url). New writes use the newest
// key id; reads select the key by id. Tenant id is bound as AAD.
const vaultKeys = (): Record<string, Buffer> => {
  const raw = process.env.ENCRYPTION_KEYS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      const out: Record<string, Buffer> = {};
      for (const [k, v] of Object.entries(parsed)) {
        out[k] = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : createHash('sha256').update(v).digest();
      }
      return out;
    } catch {
      // fall through
    }
  }
  return { '1': encKey() };
};

export function seal(plain: string, tenantId: string, kid = '1'): string {
  const keys = vaultKeys();
  const key = (keys[kid] ?? keys[Object.keys(keys)[0]!])!;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(tenantId, 'utf8'));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', kid, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function openSealed(token: string, tenantId: string): string {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('malformed sealed token');
  const [, kid, iv, tag, ct] = parts;
  const keys = vaultKeys();
  const key = keys[kid!];
  if (!key) throw new Error('unknown key id');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv!, 'base64url'));
  d.setAAD(Buffer.from(tenantId, 'utf8'));
  d.setAuthTag(Buffer.from(tag!, 'base64url'));
  const dec = Buffer.concat([d.update(Buffer.from(ct!, 'base64url')), d.final()]);
  return dec.toString('utf8');
}
