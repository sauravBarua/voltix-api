import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { API_PREFIX, configureApp } from '../src/app.setup';
import { RabbitMqService } from '../src/messaging/rabbitmq.service';
import { WorkerModule } from '../src/worker.module';

jest.setTimeout(40_000);

type Ref = { id: string; slug: string };

describe('Availability invalidation through trigger, outbox, RabbitMQ and consumer (e2e)', () => {
  let app: INestApplication<App>;
  let worker: TestingModule;
  const suffix = Date.now().toString(36).toUpperCase();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await worker.init();
    await worker.get(RabbitMqService).waitUntilReady(15_000);
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
  });

  const http = () => {
    const server = app.getHttpServer();
    const url = (p: string) => `/${API_PREFIX}${p}`;
    return {
      get: (p: string) => request(server).get(url(p)),
      post: (p: string) => request(server).post(url(p)),
    };
  };

  it('shows new stock within seconds, long before the 30 s cache TTL', async () => {
    const brands = (await http().get('/brands').expect(200)).body as Ref[];
    const categories = (await http().get('/categories').expect(200)).body as Ref[];
    const product = (
      await http()
        .post('/products')
        .field(
          'data',
          JSON.stringify({
            name: `Invalidation Laptop ${suffix}`,
            brandId: brands.find((b) => b.slug === 'dell')!.id,
            categoryId: categories.find((c) => c.slug === 'laptops')!.id,
            specs: { cpu: 'Test CPU', screenSizeInch: 15.6, os: 'Windows 11' },
          }),
        )
        .expect(201)
    ).body as { id: string; slug: string };
    const variant = (
      await http()
        .post(`/products/${product.id}/variants`)
        .field(
          'data',
          JSON.stringify({ sku: `INVL-${suffix}`, name: 'Invalidation variant', priceMinor: 1000 }),
        )
        .expect(201)
    ).body as { id: string };

    const available = async () =>
      (
        (await http().get(`/products/${product.slug}`).expect(200)).body as {
          variants: { available: number }[];
        }
      ).variants[0].available;

    expect(await available()).toBe(0); // cached as 0
    await http()
      .post(`/inventory/variants/${variant.id}/stock-in`)
      .send({ quantity: 5 })
      .expect(201);

    const deadline = Date.now() + 20_000; // the TTL alone would need 30 s
    let value = await available();
    while (value !== 5 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      value = await available();
    }
    expect(value).toBe(5);
  });
});
