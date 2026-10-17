import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { TestAuth } from './helpers/auth';

jest.setTimeout(30_000);

type UserBody = { id: string; email: string; role: string; isActive: boolean };
type TokenBody = { accessToken: string; refreshToken: string; user: UserBody };

describe('Admin users and audit log (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: TestAuth;
  let counter = 0;
  const suffix = Date.now().toString(36);
  const password = 'Another-Pass-77!';
  const address = () => `staff-${suffix}-${++counter}@voltix.test`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    auth = await TestAuth.create(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const api = (who?: string) => auth.api(who);
  const createStaff = (extra: Record<string, unknown> = {}) =>
    api()
      .post('/admin/users')
      .send({
        email: address(),
        name: 'Staff Test',
        password,
        role: 'INVENTORY_OPERATOR',
        ...extra,
      });
  const login = async (email: string) =>
    (await api('anon').post('/auth/login').send({ email, password }).expect(200)).body as TokenBody;

  it('creates a staff user who can log in, and never returns the password hash', async () => {
    const email = address();
    const res = await createStaff({ email }).expect(201);
    const user = res.body as UserBody;
    expect(user).toMatchObject({ email, role: 'INVENTORY_OPERATOR', isActive: true });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);

    expect((await login(email)).user.role).toBe('INVENTORY_OPERATOR');
    await createStaff({ email }).expect(409);
    await createStaff({ password: 'short' }).expect(400);
    await createStaff({ role: 'SUPERUSER' }).expect(400);
  });

  it('lists and filters users', async () => {
    const email = address();
    await createStaff({ email }).expect(201);
    const res = await api()
      .get('/admin/users')
      .query({ q: email, role: 'INVENTORY_OPERATOR', isActive: 'true' })
      .expect(200);
    const items = (res.body as { items: UserBody[] }).items;
    expect(items.map((u) => u.email)).toEqual([email]);
    await api().get('/admin/users').query({ role: 'NOPE' }).expect(400);
  });

  it('changes a role, takes effect at once, and audits before and after', async () => {
    const email = address();
    const user = (await createStaff({ email }).expect(201)).body as UserBody;
    const session = await login(email);
    const asUser = () =>
      api('anon')
        .get('/admin/users')
        .set({ Authorization: `Bearer ${session.accessToken}` });
    await asUser().expect(403);

    const admin = await auth.createUser('ADMIN');
    const updated = await api(admin)
      .patch(`/admin/users/${user.id}`)
      .send({ role: 'ADMIN' })
      .expect(200);
    expect((updated.body as UserBody).role).toBe('ADMIN');
    await asUser().expect(200); // same token, new role

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.update', entityId: user.id },
    });
    expect(entry).toMatchObject({ actorId: admin, actorRole: 'ADMIN', outcome: 'SUCCESS' });
    expect(entry.metadata).toMatchObject({
      from: { role: 'INVENTORY_OPERATOR', isActive: true },
      to: { role: 'ADMIN', isActive: true },
    });
    await api().patch(`/admin/users/${user.id}`).send({}).expect(400);
  });

  it('never lets an admin change their own role or deactivate themselves', async () => {
    const admin = await auth.createUser('ADMIN');
    await api(admin).patch(`/admin/users/${admin}`).send({ role: 'CUSTOMER' }).expect(409);
    await api(admin).patch(`/admin/users/${admin}`).send({ isActive: false }).expect(409);
    await api(admin).patch(`/admin/users/${admin}`).send({ role: 'ADMIN' }).expect(200); // no change is fine
  });

  it('deactivation ends access and refresh immediately', async () => {
    const email = address();
    const user = (await createStaff({ email }).expect(201)).body as UserBody;
    const session = await login(email);
    await api().patch(`/admin/users/${user.id}`).send({ isActive: false }).expect(200);

    await api('anon')
      .get('/auth/me')
      .set({ Authorization: `Bearer ${session.accessToken}` })
      .expect(401);
    await api('anon')
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    await api()
      .patch(`/admin/users/${'0192f5c4-0000-7000-8000-00000000dead'}`)
      .send({ isActive: false })
      .expect(404);
  });

  it('audits staff writes, access denials and filters the trail', async () => {
    const admin = await auth.createUser('ADMIN');
    const category = (
      await api(admin)
        .post('/categories')
        .send({ name: `Audit Cat ${suffix}-${++counter}` })
        .expect(201)
    ).body as { id: string };

    const write = await prisma.auditLog.findFirstOrThrow({
      where: { actorId: admin, action: { contains: '/categories' }, entityId: category.id },
    });
    expect(write).toMatchObject({
      actorRole: 'ADMIN',
      entityType: 'categories',
      outcome: 'SUCCESS',
    });
    expect(JSON.stringify(write.metadata)).not.toContain('Audit Cat'); // request bodies are never stored

    const customer = await auth.createUser('CUSTOMER');
    await api(customer).get('/admin/users').expect(403);
    const denied = await prisma.auditLog.findFirstOrThrow({
      where: { actorId: customer, action: 'access.denied' },
    });
    expect(denied).toMatchObject({ outcome: 'FAILURE', actorRole: 'CUSTOMER' });

    const res = await api()
      .get('/admin/audit-logs')
      .query({ actorId: customer, action: 'access.denied' })
      .expect(200);
    expect((res.body as { items: { id: string }[] }).items.map((i) => i.id)).toContain(denied.id);
    await api(customer).get('/admin/audit-logs').expect(403);
    await api()
      .get('/admin/audit-logs')
      .query({ from: '2026-12-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })
      .expect(400);
    await api(admin).delete(`/categories/${category.id}`).expect(204);
  });

  it('keeps the audit log append-only at the database level', async () => {
    await expect(prisma.$executeRaw`UPDATE audit_logs SET action = 'tampered'`).rejects.toThrow();
    await expect(
      prisma.$executeRaw`DELETE FROM audit_logs WHERE action = 'access.denied'`,
    ).rejects.toThrow();
  });
});
