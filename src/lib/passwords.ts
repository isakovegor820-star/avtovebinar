import crypto from 'node:crypto';

const SCRYPT_KEY_LENGTH = 64;

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('base64url');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string) {
  const [algorithm, salt, expectedHash] = storedHash.split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHash) {
    return false;
  }

  const actualHash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('base64url');
  const actual = Buffer.from(actualHash);
  const expected = Buffer.from(expectedHash);

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
