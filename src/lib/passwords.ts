import crypto from 'node:crypto';
import { promisify } from 'node:util';

const SCRYPT_KEY_LENGTH = 64;
const scryptAsync = promisify(crypto.scrypt);

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = (await scryptAsync(password, salt, SCRYPT_KEY_LENGTH) as Buffer).toString('base64url');
  return `scrypt:${salt}:${hash}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [algorithm, salt, expectedHash] = storedHash.split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHash) {
    return false;
  }

  const actualHash = (await scryptAsync(password, salt, SCRYPT_KEY_LENGTH) as Buffer).toString('base64url');
  const actual = Buffer.from(actualHash);
  const expected = Buffer.from(expectedHash);

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
