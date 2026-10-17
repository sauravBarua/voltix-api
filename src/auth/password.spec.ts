import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('Correct-Horse-9!');
    expect(hash.startsWith('scrypt$32768$8$3$')).toBe(true);
    expect(hash).not.toContain('Correct-Horse');
    await expect(verifyPassword('Correct-Horse-9!', hash)).resolves.toBe(true);
    await expect(verifyPassword('correct-horse-9!', hash)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same-password-1')).not.toBe(await hashPassword('same-password-1'));
  });

  it('rejects malformed hashes and unknown users', async () => {
    await expect(verifyPassword('x', 'plaintext')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$a$b$c$d$e')).resolves.toBe(false);
    await expect(verifyPassword('x', null)).resolves.toBe(false);
  });
});
