import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

type ListBody = {
  items: { slug: string; brand: { slug: string }; priceFromMinor: number }[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};
type Ref = { id: string; slug: string };

describe('Catalog (e2e)', () => {
  let app: INestApplication<App>;
  const suffix = Date.now().toString(36);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const list = async (query: Record<string, string>) =>
    (await http().get('/products').query(query).expect(200)).body as ListBody;

  describe('public reads', () => {
    it('lists seeded products with pagination meta', async () => {
      const body = await list({});
      expect(body.meta).toMatchObject({ page: 1, pageSize: 20 });
      expect(body.items.length).toBeGreaterThanOrEqual(7);
    });

    it('filters by brand', async () => {
      const body = await list({ brand: 'apple' });
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.every((p) => p.brand.slug === 'apple')).toBe(true);
    });

    it('filters by price range', async () => {
      const body = await list({ minPrice: '100000', maxPrice: '140000' });
      expect(body.items.length).toBeGreaterThan(0);
      expect(
        body.items.every((p) => p.priceFromMinor >= 100000 && p.priceFromMinor <= 140000),
      ).toBe(true);
    });

    it('sorts by price ascending', async () => {
      const prices = (await list({ sort: 'price_asc' })).items.map((p) => p.priceFromMinor);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    });

    it('filters by specs', async () => {
      const slugs = (await list({ specs: JSON.stringify({ os: 'macOS' }) })).items.map(
        (p) => p.slug,
      );
      expect(slugs).toContain('macbook-air-13-m3');
      expect(slugs).not.toContain('dell-xps-14');
    });

    it('rejects invalid filters with 400', async () => {
      await http().get('/products').query({ specs: 'not-json' }).expect(400);
      await http().get('/products').query({ minPrice: '-1' }).expect(400);
      await http().get('/products').query({ minPrice: '500', maxPrice: '100' }).expect(400);
    });

    it('returns product detail with variants, and 404 for unknown slugs', async () => {
      const res = await http().get('/products/iphone-16-pro').expect(200);
      const body = res.body as { variants: { sku: string; available: number }[] };
      expect(body.variants.length).toBe(2);
      expect(typeof body.variants[0].available).toBe('number');
      await http().get('/products/does-not-exist').expect(404);
    });
  });

  describe('admin writes', () => {
    it('creates, conflicts on, and deletes a category', async () => {
      const name = `Test Category ${suffix}`;
      const created = await http().post('/categories').send({ name }).expect(201);
      const { id } = created.body as Ref;
      await http().post('/categories').send({ name }).expect(409);
      await http().patch(`/categories/${id}`).send({}).expect(400);
      await http().delete(`/categories/${id}`).expect(204);
      await http().delete(`/categories/${id}`).expect(404);
    });

    it('refuses to delete a category that still has products', async () => {
      const categories = (await http().get('/categories').expect(200)).body as Ref[];
      const laptops = categories.find((c) => c.slug === 'laptops');
      await http().delete(`/categories/${laptops?.id}`).expect(409);
    });

    it('rejects invalid specs for the laptops category', async () => {
      const categories = (await http().get('/categories').expect(200)).body as Ref[];
      const brands = (await http().get('/brands').expect(200)).body as Ref[];
      const res = await http()
        .post('/products')
        .send({
          name: `Invalid Laptop ${suffix}`,
          brandId: brands.find((b) => b.slug === 'dell')?.id,
          categoryId: categories.find((c) => c.slug === 'laptops')?.id,
          specs: { cpu: 'Intel' },
        })
        .expect(400);
      expect((res.body as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
    });

    it('returns 404 when adding a variant to an unknown product', async () => {
      await http()
        .post('/products/0192f5c4-0000-7000-8000-000000000000/variants')
        .send({ sku: `TEST-${suffix.toUpperCase()}`, name: 'x', priceMinor: 100 })
        .expect(404);
    });
  });
});
