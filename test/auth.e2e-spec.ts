import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { Env } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';
import { TestAuth } from './helpers/auth';

jest.setTimeout(30_000);

type TokenBody = {
  tokenType: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; role: string; isActive: boolean };
};

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: TestAuth;
  let secret: string;
  let counter = 0;
  const suffix = Date.now().toString(36);
  const password = 'Correct-Horse-9!';
  const address = () => `auth-${suffix}-${++counter}@voltix.test`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    auth = await TestAuth.create(app);
    secret = app
      .get<ConfigService<Env, true>>(ConfigService)
      .get('JWT_ACCESS_SECRET', { infer: true });
  });

  afterAll(async () => {
    await app.close();
  });

  const api = (who?: string) => auth.api(who);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const register = (email = address(), pass = password) =>
    api('anon').post('/auth/register').send({ email, password: pass, name: 'Auth Test' });
  const registered = async () => {
    const email = address();
    const body = (await register(email).expect(201)).body as TokenBody;
    return { email, body };
  };
  const login = (email: string, pass = password) =>
    api('anon').post('/auth/login').send({ email, password: pass });
  const refresh = (token: string) =>
    api('anon').post('/auth/refresh').send({ refreshToken: token });

  it('registers a customer and stores only hashes', async () => {
    const { email, body } = await registered();
    expect(body).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { email, role: 'CUSTOMER', isActive: true },
    });
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|Correct-Horse/);

    const row = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { passwordHash: true },
    });
    expect(row.passwordHash?.startsWith('scrypt$')).toBe(true);
    expect(
      await prisma.refreshToken.findFirst({ where: { tokenHash: body.refreshToken } }),
    ).toBeNull(); // only the hash is stored

    const me = await api('anon').get('/auth/me').set(bearer(body.accessToken)).expect(200);
    expect(me.body).toMatchObject({ email, role: 'CUSTOMER' });
  });

  it('validates registration and refuses duplicate emails case-insensitively', async () => {
    const { email } = await registered();
    await register(address(), 'short').expect(400);
    await register('not-an-email').expect(400);
    await api('anon').post('/auth/register').send({ email: address(), password }).expect(400); // no name
    await register(email.toUpperCase()).expect(409);
  });

  it('logs in, and answers every failure identically', async () => {
    const { email, body } = await registered();
    const ok = await login(email).expect(200);
    expect((ok.body as TokenBody).user.id).toBe(body.user.id);

    const wrong = await login(email, 'Wrong-Password-1!').expect(401);
    const unknown = await login(address()).expect(401);
    await prisma.user.update({ where: { email }, data: { isActive: false } });
    const inactive = await login(email).expect(401);
    expect((wrong.body as { message: string }).message).toBe('Invalid email or password');
    expect(unknown.body).toEqual(wrong.body);
    expect(inactive.body).toEqual(wrong.body);

    expect(
      await prisma.auditLog.count({
        where: { actorId: body.user.id, action: 'auth.login', outcome: 'SUCCESS' },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { actorId: body.user.id, action: 'auth.login', outcome: 'FAILURE' },
      }),
    ).toBe(2);
  });

  it('rejects missing, forged, expired, issuer-less and malformed tokens (401)', async () => {
    const { body } = await registered();
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      new JwtService({ secret: 'x'.repeat(48) }).sign(
        { sub: body.user.id },
        { issuer: 'voltix-api', expiresIn: 60 },
      ),
      new JwtService({ secret }).sign(
        { sub: body.user.id, exp: now - 60 },
        { issuer: 'voltix-api' },
      ),
      new JwtService({ secret }).sign({ sub: body.user.id }, { expiresIn: 60 }), // no issuer
      new JwtService({ secret }).sign(
        { sub: 'not-a-uuid' },
        { issuer: 'voltix-api', expiresIn: 60 },
      ),
      'not-a-jwt',
    ];
    for (const token of bad) await api('anon').get('/auth/me').set(bearer(token)).expect(401);
    await api('anon').get('/auth/me').expect(401);
    await api('anon')
      .get('/auth/me')
      .set({ Authorization: `Basic ${body.accessToken}` })
      .expect(401);
  });

  it('reads the role and active flag from the database on every request', async () => {
    const { body } = await registered();
    const get = () => api('anon').get('/admin/users').set(bearer(body.accessToken));
    await get().expect(403);
    await prisma.user.update({ where: { id: body.user.id }, data: { role: 'ADMIN' } });
    await get().expect(200); // same token, new role
    await prisma.user.update({ where: { id: body.user.id }, data: { isActive: false } });
    await get().expect(401);
  });

  it('rotates refresh tokens and revokes the whole family when an old one is reused', async () => {
    const { body } = await registered();
    const second = (await refresh(body.refreshToken).expect(200)).body as TokenBody;
    expect(second.refreshToken).not.toBe(body.refreshToken);
    await api('anon').get('/auth/me').set(bearer(second.accessToken)).expect(200);

    await refresh(body.refreshToken).expect(401); // reuse of the consumed token
    await refresh(second.refreshToken).expect(401); // ...killed the session, including the newest token
    expect(
      await prisma.auditLog.count({
        where: { actorId: body.user.id, action: 'auth.refresh_reuse_detected' },
      }),
    ).toBe(1);

    await refresh('definitely-not-a-valid-refresh-token').expect(401);
  });

  it('refuses a refresh for a deactivated user', async () => {
    const { body } = await registered();
    await prisma.user.update({ where: { id: body.user.id }, data: { isActive: false } });
    await refresh(body.refreshToken).expect(401);
  });

  it('logs out one session, idempotently, and logs out everywhere', async () => {
    const { email, body } = await registered();
    await api('anon').post('/auth/logout').send({ refreshToken: body.refreshToken }).expect(204);
    await api('anon').post('/auth/logout').send({ refreshToken: body.refreshToken }).expect(204);
    await api('anon')
      .post('/auth/logout')
      .send({ refreshToken: 'unknown-token-unknown-token' })
      .expect(204);
    await refresh(body.refreshToken).expect(401);

    const a = (await login(email).expect(200)).body as TokenBody;
    const b = (await login(email).expect(200)).body as TokenBody;
    await api('anon').post('/auth/logout-all').set(bearer(a.accessToken)).expect(204);
    await refresh(a.refreshToken).expect(401);
    await refresh(b.refreshToken).expect(401);
  });

  it('changes the password and ends every session', async () => {
    const { email, body } = await registered();
    const change = (current: string, next: string) =>
      api('anon')
        .post('/auth/change-password')
        .set(bearer(body.accessToken))
        .send({ currentPassword: current, newPassword: next });

    await change('Wrong-Password-1!', 'Brand-New-Pass-77!').expect(400);
    await change(password, 'short').expect(400);
    await change(password, password).expect(400);
    await change(password, 'Brand-New-Pass-77!').expect(204);

    await refresh(body.refreshToken).expect(401);
    await login(email).expect(401);
    await login(email, 'Brand-New-Pass-77!').expect(200);
  });
});
