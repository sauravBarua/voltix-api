import { type ScryptOptions, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// OWASP-listed scrypt parameters: N=2^15, r=8, p=3 (about 32 MiB and ~200 ms per hash)
const N = 2 ** 15;
const R = 8;
const P = 3;
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * 1024 * 1024;

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  keyLength: number,
) {
  const options: ScryptOptions = { N: n, r, p, maxmem: MAX_MEMORY };
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Format: scrypt$N$r$p$salt(base64)$hash(base64), so parameters can be raised later. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(plain, salt, N, R, P, KEY_LENGTH);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword('dummy-password-used-for-timing'));

/** With stored = null (unknown user) it still burns one hash, so response time does not reveal the account. */
export async function verifyPassword(plain: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? (await dummyHash())).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const expected = Buffer.from(parts[5], 'base64');
  if (![n, r, p].every(Number.isInteger) || expected.length === 0) return false;

  const actual = await derive(plain, Buffer.from(parts[4], 'base64'), n, r, p, expected.length);
  return timingSafeEqual(actual, expected) && stored !== null;
}
