import crypto from "crypto";

/**
 * Secrets at rest: AES-256-GCM with a key derived from PANEL_MASTER_KEY.
 * Stored format: v1:<saltHex>:<ivHex>:<tagHex>:<cipherHex>
 * Never log plaintext. Decrypt only at point of use.
 */
const MASTER = process.env.PANEL_MASTER_KEY || "";

// Fail closed in production: a defaulted/missing master key means every secret
// at rest (SSH keys, TOTP secrets, integration creds) is either undecryptable
// or, worse, protected by a publicly-known key. Allow an unset key only in dev/
// test so local work without secrets still boots.
if (
  process.env.NODE_ENV === "production" &&
  MASTER.length < 16
) {
  throw new Error(
    "PANEL_MASTER_KEY must be set (>=16 chars) in production. Refusing to start with a default/empty master key."
  );
}

export function masterKeyConfigured(): boolean {
  return MASTER.length >= 16;
}

function deriveKey(salt: Buffer): Buffer {
  if (!masterKeyConfigured())
    throw new Error(
      "PANEL_MASTER_KEY is not set (>=16 chars) — cannot encrypt/decrypt secrets"
    );
  return crypto.scryptSync(MASTER, salt, 32);
}

export function encryptSecret(plain: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(salt);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `v1:${salt.toString("hex")}:${iv.toString("hex")}:${tag.toString(
    "hex"
  )}:${enc.toString("hex")}`;
}

export function decryptSecret(blob: string): string {
  const [v, saltH, ivH, tagH, dataH] = blob.split(":");
  if (v !== "v1" || !saltH || !ivH || !tagH || !dataH)
    throw new Error("Malformed encrypted secret");
  const key = deriveKey(Buffer.from(saltH, "hex"));
  const d = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivH, "hex")
  );
  d.setAuthTag(Buffer.from(tagH, "hex"));
  return Buffer.concat([
    d.update(Buffer.from(dataH, "hex")),
    d.final(),
  ]).toString("utf8");
}

export function isEncrypted(s: string | null | undefined): boolean {
  return !!s && s.startsWith("v1:") && s.split(":").length === 5;
}

/** Mask a secret for UI display (never returns plaintext). */
export function maskSecret(s: string | null | undefined): string {
  if (!s) return "";
  return s.length <= 4 ? "••••" : `${s.slice(0, 2)}••••${s.slice(-2)}`;
}
