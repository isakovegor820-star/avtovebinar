import crypto from 'node:crypto';
import { env } from './env.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

function base32Encode(value: Buffer) {
  let bits = '';
  for (const byte of value) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let index = 0; index < bits.length; index += 5) {
    output += BASE32_ALPHABET[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  }
  return output;
}

function base32Decode(value: string) {
  const normalized = value.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = '';
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Invalid base32 secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function encryptionKey() {
  return crypto.createHash('sha256').update(`aspb-admin-mfa:${env.ADMIN_COOKIE_SECRET}`).digest();
}

export function encryptMfaSecret(secret: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptMfaSecret(value: string) {
  const [version, ivEncoded, tagEncoded, encryptedEncoded] = value.split('.');
  if (version !== 'v1' || !ivEncoded || !tagEncoded || !encryptedEncoded) {
    throw new Error('Invalid encrypted MFA secret');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivEncoded, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedEncoded, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}

function totpAt(secret: string, counter: number) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function generateTotp(secret: string, now = new Date()) {
  return totpAt(secret, Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS));
}

export function verifyTotp(secret: string, submittedCode: string, now = new Date()) {
  if (!/^\d{6}$/.test(submittedCode)) return false;
  const counter = Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
  return [-1, 0, 1].some(offset => {
    const expected = Buffer.from(totpAt(secret, counter + offset));
    const submitted = Buffer.from(submittedCode);
    return expected.length === submitted.length && crypto.timingSafeEqual(expected, submitted);
  });
}

export function createMfaEnrollment(email: string) {
  const secret = base32Encode(crypto.randomBytes(20));
  const issuer = 'ASPB';
  const label = `${issuer}:${email}`;
  const otpauthUrl =
    `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}` +
    `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
  return { secret, otpauthUrl, encryptedSecret: encryptMfaSecret(secret) };
}
