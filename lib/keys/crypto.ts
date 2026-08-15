// AES-256-GCM for the provider API keys users hand us (SCALE-PLAN Phase D.1).
//
// This is the only place in the codebase that holds someone else's credential.
// The rules that follow from that:
//
//  - The plaintext key exists in memory for exactly as long as one LLM call
//    needs it. It is never returned to the client, never logged, never put in
//    an error message, and never stored anywhere but the ciphertext column.
//  - GCM, not CBC: the auth tag means a tampered or truncated ciphertext fails
//    to decrypt instead of yielding garbage that gets sent to a provider.
//  - The (userId, provider) pair is bound in as additional authenticated data.
//    A ciphertext lifted out of one row and pasted into another — by a bad
//    migration, a restored backup, or someone with database access — will not
//    decrypt. Without AAD it would decrypt happily and the wrong person's key
//    would start billing the wrong person's account.
//  - A version byte leads the payload, so a future algorithm change can be
//    detected rather than silently mis-parsed as a corrupt key.
//
// ENCRYPTION_KEY is generated and owned by this project — it is not a provider
// credential and must not be reused from anywhere else. Rotating it makes every
// stored key undecryptable; there is no re-wrap path, and there deliberately
// isn't one, because the recovery is simply to ask users to re-enter a key we
// were never supposed to be able to read anyway.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = 1;
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

// Parsed once. A bad key is a deployment mistake, and it should be discovered
// the first time anything touches this module rather than on a user's request.
let cached: Buffer | null = null;
let cachedFrom: string | null = null;

/**
 * The raw 32-byte key, or null when ENCRYPTION_KEY is unset or malformed.
 *
 * Returns null rather than throwing so an unconfigured deployment degrades to
 * "BYOK unavailable" instead of taking down every route that imports this
 * transitively. Callers must handle null; `encryptionAvailable()` is the
 * readable way to ask.
 */
function encryptionKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  if (cached && cachedFrom === raw) return cached;

  // Accept hex or base64 so whichever `openssl rand` incantation someone
  // reaches for produces a usable value.
  let buf: Buffer | null = null;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else {
    try {
      const b = Buffer.from(raw, "base64");
      if (b.length === KEY_BYTES) buf = b;
    } catch {
      buf = null;
    }
  }

  if (!buf || buf.length !== KEY_BYTES) {
    console.error(
      "[keys] ENCRYPTION_KEY is set but is not 32 bytes. Expected 64 hex characters or " +
        "44 base64 characters — generate one with `openssl rand -hex 32`. " +
        "Bring-your-own-key is disabled until this is fixed.",
    );
    return null;
  }

  cached = buf;
  cachedFrom = raw;
  return buf;
}

export function encryptionAvailable(): boolean {
  return encryptionKey() !== null;
}

/** Binds a ciphertext to the row it belongs to. See the AAD note in the header. */
function aad(userId: string, provider: string): Buffer {
  return Buffer.from(`${userId}:${provider}`, "utf8");
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super("ENCRYPTION_KEY is not configured, so provider keys cannot be stored.");
  }
}

/**
 * Encrypt a user's provider key. Returns an opaque base64 payload for the
 * `ciphertext` column.
 *
 * Throws EncryptionUnavailableError when there is no usable ENCRYPTION_KEY —
 * storing a key in plaintext because encryption was unavailable would be worse
 * than refusing, so this is one of the few places that refuses rather than
 * degrading.
 */
export function encryptApiKey(plaintext: string, userId: string, provider: string): string {
  const key = encryptionKey();
  if (!key) throw new EncryptionUnavailableError();

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(userId, provider));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION]), iv, tag, body]).toString("base64");
}

/**
 * Decrypt a stored payload back into the user's key.
 *
 * Returns null on ANY failure — wrong ENCRYPTION_KEY, tampered ciphertext,
 * a payload written for a different (userId, provider), a truncated column.
 * Deliberately not an exception and deliberately not detailed: the caller's
 * only sensible response is to fall back to the shared pool, and a message
 * distinguishing "wrong key" from "tampered" is a decryption oracle.
 */
export function decryptApiKey(payload: string, userId: string, provider: string): string | null {
  const key = encryptionKey();
  if (!key) return null;

  try {
    const buf = Buffer.from(payload, "base64");
    if (buf.length < 1 + IV_BYTES + TAG_BYTES) return null;

    const version = buf[0];
    // timingSafeEqual is overkill for a version byte, but the comparison below
    // for the tag is done by GCM itself — this is just an explicit gate so an
    // unknown version can never be fed to the v1 parser.
    if (version !== VERSION) {
      console.error(`[keys] stored key has unknown payload version ${version}; ignoring it.`);
      return null;
    }

    const iv = buf.subarray(1, 1 + IV_BYTES);
    const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const body = buf.subarray(1 + IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(userId, provider));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // Never log the payload or the reason. See the doc comment.
    return null;
  }
}

/**
 * The only part of a key that may ever be shown or logged: its last four
 * characters. Short keys are masked entirely rather than partially revealed.
 */
export function maskKey(plaintext: string): string {
  const trimmed = plaintext.trim();
  return trimmed.length < 12 ? "••••" : `••••${trimmed.slice(-4)}`;
}

/**
 * Constant-time equality, for comparing a submitted key against one already
 * stored without leaking how much of it matched via timing.
 */
export function sameKey(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
