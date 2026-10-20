import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ACCESS_KEY } from '../src/auth/access.decorators';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { Role } from '../src/generated/prisma/client';
import { TestAuth } from './helpers/auth';

jest.setTimeout(60_000);

type Method = 'get' | 'post' | 'patch' | 'delete';
type Who = 'anon' | Role;
const ALL: Role[] = ['CUSTOMER', 'INVENTORY_OPERATOR', 'ADMIN'];
const INVENTORY: Role[] = ['INVENTORY_OPERATOR', 'ADMIN'];
const ADMIN: Role[] = ['ADMIN'];
const id = randomUUID();

// [method, path under /api/v1, who may call it]
const ROUTES: [Method, string, Role[] | 'public'][] = [
  ['get', '/products', 'public'],
  ['get', '/categories', 'public'],
  ['get', '/brands', 'public'],
  ['post', '/products', ADMIN],
  ['post', '/categories', ADMIN],
  ['delete', `/brands/${id}`, ADMIN],
  ['patch', `/variants/${id}`, ADMIN],
  ['get', '/inventory', INVENTORY],
  ['post', `/inventory/variants/${id}/stock-in`, INVENTORY],
  ['get', '/reservations', INVENTORY],
  ['post', '/reservations/expire-due', INVENTORY],
  ['get', '/cart', ALL],
  ['get', '/orders', ALL],
  ['post', '/orders/checkout', ALL],
  ['post', `/orders/${id}/pay`, ALL],
  ['get', '/admin/orders', ADMIN],
  ['post', `/admin/orders/${id}/ship`, ADMIN],
  ['post', `/admin/orders/${id}/refund`, ADMIN],
  ['get', '/admin/outbox/summary', ADMIN],
  ['get', '/admin/users', ADMIN],
  ['get', '/admin/audit-logs', ADMIN],
  ['get', '/admin/dashboard/kpis', ADMIN],
  ['get', '/admin/dashboard/recent-orders', ADMIN],
  ['get', '/admin/dashboard/inventory/summary', INVENTORY],
  ['get', '/auth/me', ALL],
  ['post', '/auth/logout-all', ALL],
];

describe('Access control (e2e)', () => {
  let app: INestApplication<App>;
  let auth: TestAuth;
  const users = {} as Record<Role, string>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    auth = await TestAuth.create(app);
    for (const role of ALL) users[role] = await auth.createUser(role);
  });

  afterAll(async () => {
    await app.close();
  });

  it('every route handler declares an access policy (default deny would otherwise refuse it)', () => {
    const reflector = app.get(Reflector);
    const missing: string[] = [];
    for (const mod of app.get(ModulesContainer).values()) {
      for (const wrapper of mod.controllers.values()) {
        const type = wrapper.metatype as (new (...args: never[]) => object) | null;
        if (!type) continue;
        const proto = type.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = proto[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue; // not a route
          if (
            reflector.getAllAndOverride(ACCESS_KEY, [handler as () => void, type]) === undefined
          ) {
            missing.push(`${type.name}.${name}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('enforces the role matrix: 401 without a token, 403 for the wrong role, through for the right one', async () => {
    const mismatches: string[] = [];
    for (const [method, path, allowed] of ROUTES) {
      for (const who of ['anon', ...ALL] as Who[]) {
        const res = await auth
          .api(who === 'anon' ? 'anon' : users[who])
          [method](path)
          .send({});
        const open = allowed === 'public' || (who !== 'anon' && allowed.includes(who));
        const expectedBlock = who === 'anon' ? 401 : 403;
        const ok = open ? res.status !== 401 && res.status !== 403 : res.status === expectedBlock;
        if (!ok) mismatches.push(`${who} ${method.toUpperCase()} ${path} -> ${res.status}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('keeps health probes and the Stripe webhook outside token authentication', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
    await request(app.getHttpServer()).post('/webhooks/stripe').send({}).expect(400); // bad signature, never 401
  });
});
