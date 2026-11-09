// RFC 6238 TOTP (SHA1, 6 digits, 30 s step) for e2e scripts, plus a small on-disk cache of the HR
// account's secret so separate e2e scripts can sign the same recruiter in after 2FA is turned on.
import crypto from "node:crypto";
import fs from "node:fs";

export function base32Decode(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = alphabet.indexOf(ch);
    if (i < 0) throw new Error(`bad base32 character: ${ch}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

const currentStep = () => Math.floor(Date.now() / 1000 / 30);
const lastUsed = new Map();

/** A code the server hasn't seen yet: the backend rejects re-use of a step, so wait for the next one if needed. */
export async function freshCode(secret, persisted = null) {
  const floor = Math.max(lastUsed.get(secret) ?? -1, persisted ?? -1);
  while (currentStep() <= floor) await new Promise((r) => setTimeout(r, 500));
  const step = currentStep();
  lastUsed.set(secret, step);
  return { code: totpAt(secret, step), step };
}

export function loadSecret(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
export function saveSecret(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}
