import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { API_PREFIX, configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

type EventBody = {
  id: string;
  status: string;
  attempts: number;
  lastError: string | null;
  type: string;
};

describe('Outbox admin (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const type = `e2e.admin.${Date.now().toString(36)}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'e2e-test' } });
    await app.close();
  });

  const url = (p: string) => `/${API_PREFIX}/admin/outbox${p}`;
  const failedRow = () =>
    prisma.outboxEvent.create({
      data: {
        aggregateType: 'e2e-test',
        aggregateId: randomUUID(),
        type,
        payload: {},
        status: 'FAILED',
        attempts: 10,
        lastError: 'boom',
      },
      select: { id: true },
    });

  it('summarizes the outbox', async () => {
    await failedRow();
    const res = await request(app.getHttpServer()).get(url('/summary')).expect(200);
    const body = res.body as {
      pending: number;
      published: number;
      failed: number;
      oldestPendingAgeSeconds: number | null;
    };
    expect(body.failed).toBeGreaterThanOrEqual(1);
    expect(typeof body.pending).toBe('number');
    expect(typeof body.published).toBe('number');
  });

  it('lists events with filters and validates the query', async () => {
    const row = await failedRow();
    const res = await request(app.getHttpServer())
      .get(url(''))
      .query({ status: 'FAILED', type })
      .expect(200);
    const items = (res.body as { items: EventBody[] }).items;
    expect(items.map((i) => i.id)).toContain(row.id);
    expect(items.every((i) => i.status === 'FAILED' && i.type === type)).toBe(true);
    expect(items.find((i) => i.id === row.id)?.lastError).toBe('boom');

    await request(app.getHttpServer()).get(url('')).query({ status: 'NOPE' }).expect(400);
  });

  it('retries a FAILED event once, refuses others, and 404s unknown ids', async () => {
    const row = await failedRow();

    const res = await request(app.getHttpServer())
      .post(url(`/${row.id}/retry`))
      .expect(200);
    expect(res.body).toMatchObject({ id: row.id, status: 'PENDING', attempts: 0, lastError: null });

    await request(app.getHttpServer())
      .post(url(`/${row.id}/retry`))
      .expect(409); // no longer FAILED
    await request(app.getHttpServer())
      .post(url(`/${randomUUID()}/retry`))
      .expect(404);
    await request(app.getHttpServer()).post(url('/not-a-uuid/retry')).expect(400);
  });
});
