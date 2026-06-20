/**
 * Minimal RFC 6238 TOTP — no external dep.
 * Uses Node crypto: HMAC-SHA1, 6-digit, 30s window ±1 step tolerance.
 */
import crypto from "crypto";

const STEP = 30;
const DIGITS = 6;

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // Write 64-bit big-endian counter
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  buf.writeUInt32BE(high, 0);
  buf.writeUInt32BE(low, 4);
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    Math.pow(10, DIGITS);
  return code.toString().padStart(DIGITS, "0");
}

function counter(ts = Date.now()): number {
  return Math.floor(ts / 1000 / STEP);
}

/** Generate a random 20-byte base32 secret for a new enrollment. */
export function generateTotpSecret(): string {
  return crypto.randomBytes(20).toString("base64url");
}

/**
 * Build the otpauth:// URI for QR-code enrollment.
 * secret is the raw base64url string from generateTotpSecret().
 */
export function totpUri(
  account: string,
  secret: string,
  issuer = process.env.NEXT_PUBLIC_APP_NAME || "OpsPanel"
): string {
  const enc = encodeURIComponent;
  // Convert base64url → base32 for standard authenticator compatibility.
  const b32 = base64urlToBase32(secret);
  return `otpauth://totp/${enc(issuer)}:${enc(account)}?secret=${b32}&issuer=${enc(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

/** Verify a 6-digit code within ±1 time step of now (allows clock skew). */
export function verifyTotp(secret: string, code: string): boolean {
  if (!code || code.length !== DIGITS) return false;
  const secretBuf = Buffer.from(secret, "base64url");
  const t = counter();
  for (const delta of [-1, 0, 1]) {
    if (hotp(secretBuf, t + delta) === code) return true;
  }
  return false;
}

/** Current TOTP code (useful for testing). */
export function currentTotp(secret: string): string {
  return hotp(Buffer.from(secret, "base64url"), counter());
}

// ── base64url → base32 conversion ────────────────────────────────────────────
const B32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base64urlToBase32(b64url: string): string {
  const bytes = Buffer.from(b64url, "base64url");
  let bits = 0;
  let val = 0;
  let out = "";
  for (const byte of Array.from(bytes)) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_CHARS[(val >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_CHARS[(val << (5 - bits)) & 0x1f];
  while (out.length % 8 !== 0) out += "=";
  return out;
}
