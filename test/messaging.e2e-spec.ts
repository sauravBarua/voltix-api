import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { type ConfirmChannel, type GetMessage, connect } from 'amqplib';
import type { Env } from '../src/config/env';
import type { Prisma } from '../src/generated/prisma/client';
import { ConsumerRunner } from '../src/messaging/consumer.runner';
import type { EventEnvelope } from '../src/messaging/envelope';
import { EVENTS_EXCHANGE } from '../src/messaging/messaging.constants';
import { RabbitMqService } from '../src/messaging/rabbitmq.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { WorkerModule } from '../src/worker.module';

jest.setTimeout(40_000);

const suffix = Date.now().toString(36);
const QUEUE = `e2e.${suffix}`;
const KEY = {
  ok: `e2e.${suffix}.ok`,
  retry: `e2e.${suffix}.retry`,
  dead: `e2e.${suffix}.dead`,
  unroutable: `e2e.${suffix}.unroutable`,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns something other than undefined. */
async function waitFor<T>(
  check: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(100);
  }
}

describe('Outbox publisher, RabbitMQ and consumers (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let url: string;
  const handled: EventEnvelope[] = [];
  const calls = new Map<string, number>();
  const dlq: GetMessage[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    url = moduleRef
      .get<ConfigService<Env, true>>(ConfigService)
      .get('RABBITMQ_URL', { infer: true });

    await moduleRef.get(RabbitMqService).waitUntilReady(15_000);
    await moduleRef.get(ConsumerRunner).register({
      name: QUEUE,
      routingKeys: [KEY.ok, KEY.retry, KEY.dead],
      retryDelaysMs: [150, 150, 150], // fast tiers for the test (production: 5s, 30s, 5min)
      handle: (event) => {
        const n = (calls.get(event.type) ?? 0) + 1;
        calls.set(event.type, n);
        if (event.type === KEY.dead) throw new Error('always fails');
        if (event.type === KEY.retry && n <= 2) throw new Error('transient failure');
        handled.push(event);
      },
    });
  });

  afterAll(async () => {
    if (!moduleRef) return;
    await moduleRef.close();
    await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'e2e-messaging' } });
    await prisma.processedMessage.deleteMany({ where: { consumer: QUEUE } });
    await withChannel(async (ch) => {
      for (const queue of [
        QUEUE,
        `${QUEUE}.dlq`,
        `${QUEUE}.retry.1`,
        `${QUEUE}.retry.2`,
        `${QUEUE}.retry.3`,
      ]) {
        await ch.deleteQueue(queue);
      }
    });
  });

  // ── helpers ──
  async function withChannel<T>(fn: (channel: ConfirmChannel) => Promise<T>): Promise<T> {
    const connection = await connect(url);
    try {
      return await fn(await connection.createConfirmChannel());
    } finally {
      await connection.close();
    }
  }

  const publishRaw = (routingKey: string, bodies: Buffer[], messageId: string) =>
    withChannel(async (ch) => {
      for (const body of bodies)
        ch.publish(EVENTS_EXCHANGE, routingKey, body, { persistent: true, messageId });
      await ch.waitForConfirms();
    });

  const drainDlq = () =>
    withChannel(async (ch) => {
      for (;;) {
        const message = await ch.get(`${QUEUE}.dlq`, { noAck: true });
        if (!message) break;
        dlq.push(message);
      }
    });

  const findInDlq = (messageId: string) =>
    waitFor(async () => {
      await drainDlq();
      return dlq.find((m) => m.properties.messageId === messageId);
    });

  const enqueue = (type: string, payload: Prisma.InputJsonObject = {}) =>
    prisma.outboxEvent.create({
      data: { aggregateType: 'e2e-messaging', aggregateId: randomUUID(), type, payload },
      select: { id: true, aggregateId: true },
    });

  const rowOf = (id: string) => prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
  const processedCount = (messageId: string) =>
    prisma.processedMessage.count({ where: { consumer: QUEUE, messageId } });
  const handledIds = (id: string) => handled.filter((e) => e.id === id);
  const headersOf = (m: GetMessage) => (m.properties.headers ?? {}) as Record<string, unknown>;

  // ── tests ──
  it('publishes a pending outbox row and a consumer handles it exactly once', async () => {
    const row = await enqueue(KEY.ok, { hello: 'world' });

    await waitFor(async () => ((await rowOf(row.id)).status === 'PUBLISHED' ? true : undefined));
    await waitFor(() => (handledIds(row.id).length > 0 ? true : undefined));
    await sleep(500);

    const event = handledIds(row.id);
    expect(event).toHaveLength(1);
    expect(event[0]).toMatchObject({
      id: row.id,
      type: KEY.ok,
      aggregateType: 'e2e-messaging',
      aggregateId: row.aggregateId,
      payload: { hello: 'world' },
    });
    const stored = await rowOf(row.id);
    expect(stored.publishedAt).not.toBeNull();
    expect(stored.lastError).toBeNull();
    expect(await processedCount(row.id)).toBe(1);
  });

  it('ignores a duplicate delivery of the same event (idempotent consumer)', async () => {
    const id = randomUUID();
    const envelope: EventEnvelope = {
      id,
      type: KEY.ok,
      aggregateType: 'e2e-messaging',
      aggregateId: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: {},
    };
    const body = Buffer.from(JSON.stringify(envelope));
    await publishRaw(KEY.ok, [body, body], id);

    await waitFor(() => (handledIds(id).length > 0 ? true : undefined));
    await sleep(1_500);
    expect(handledIds(id)).toHaveLength(1);
    expect(await processedCount(id)).toBe(1);
  });

  it('retries a failing handler with delays and succeeds, recording the message once', async () => {
    const row = await enqueue(KEY.retry);

    await waitFor(() => (handledIds(row.id).length > 0 ? true : undefined));
    expect(calls.get(KEY.retry)).toBe(3); // failed twice, then succeeded
    // the handler runs before its transaction commits, so wait for the dedupe row
    await waitFor(async () => ((await processedCount(row.id)) === 1 ? true : undefined));
    expect(await processedCount(row.id)).toBe(1);
    expect((await rowOf(row.id)).status).toBe('PUBLISHED');
  });

  it('dead-letters a message that keeps failing, and leaves no processed record', async () => {
    const row = await enqueue(KEY.dead);

    const message = await findInDlq(row.id);
    expect(calls.get(KEY.dead)).toBe(4); // first try + 3 retries
    expect(headersOf(message)).toMatchObject({ 'x-attempt': 4, 'x-source-queue': QUEUE });
    expect(String(headersOf(message)['x-error'])).toContain('always fails');
    expect((JSON.parse(message.content.toString()) as EventEnvelope).id).toBe(row.id);
    expect(await processedCount(row.id)).toBe(0); // the failed transaction rolled the dedupe row back
    expect((await rowOf(row.id)).status).toBe('PUBLISHED'); // the publisher's job was done
  });

  it('sends a malformed message straight to the DLQ without retrying', async () => {
    const id = randomUUID();
    await publishRaw(KEY.ok, [Buffer.from('definitely not json')], id);

    const message = await findInDlq(id);
    expect(headersOf(message)['x-attempt']).toBe(1);
    expect(String(headersOf(message)['x-error'])).toContain('not valid JSON');
  });

  it('treats an unroutable event as a failure and schedules a retry with backoff', async () => {
    const row = await enqueue(KEY.unroutable); // no queue is bound to this routing key

    const failed = await waitFor(async () => {
      const r = await rowOf(row.id);
      return r.lastError ? r : undefined;
    });
    expect(failed.status).toBe('PENDING');
    expect(failed.attempts).toBeGreaterThanOrEqual(1);
    expect(failed.lastError).toContain('unroutable');
    expect(failed.availableAt.getTime()).toBeGreaterThan(Date.now()); // backoff, not an immediate hot loop
  });
});
