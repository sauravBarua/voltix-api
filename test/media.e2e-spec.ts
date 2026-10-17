import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { API_PREFIX, configureApp } from '../src/app.setup';
import { CloudinaryService } from '../src/media/cloudinary.service';

class FakeCloudinary {
  uploaded: string[] = [];
  destroyed: string[] = [];

  upload(_buffer: Buffer, folder: string) {
    const publicId = `${folder}/fake-${randomUUID()}`;
    this.uploaded.push(publicId);
    return Promise.resolve({ secureUrl: `https://res.cloudinary.test/${publicId}.png`, publicId });
  }

  destroy(publicId: string) {
    this.destroyed.push(publicId);
    return Promise.resolve();
  }
}

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const png = { filename: 'image.png', contentType: 'image/png' };

type Ref = { id: string; slug: string };
type Img = { id: string; url: string; isPrimary: boolean };
type Detail = { id: string; slug: string; images: Img[] };

describe('Media (e2e)', () => {
  let app: INestApplication<App>;
  const fake = new FakeCloudinary();
  const suffix = Date.now().toString(36);
  let brandId: string;
  let categoryId: string;
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CloudinaryService)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const server = app.getHttpServer();
    const brands = (await request(server).get(`/${API_PREFIX}/brands`).expect(200)).body as Ref[];
    const categories = (await request(server).get(`/${API_PREFIX}/categories`).expect(200))
      .body as Ref[];
    brandId = brands.find((b) => b.slug === 'dell')!.id;
    categoryId = categories.find((c) => c.slug === 'laptops')!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const url = (p: string) => `/${API_PREFIX}${p}`;
  const specs = { cpu: 'Test CPU', screenSizeInch: 15.6, os: 'Windows 11' };
  const productData = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      name: `Media Laptop ${suffix}-${++counter}`,
      brandId,
      categoryId,
      specs,
      ...extra,
    });

  it('creates a product with two images, the first one primary', async () => {
    const before = fake.uploaded.length;
    const res = await request(app.getHttpServer())
      .post(url('/products'))
      .field('data', productData())
      .attach('images', PNG, png)
      .attach('images', PNG, { ...png, filename: 'second.png' })
      .expect(201);
    const body = res.body as Detail;
    expect(body.images).toHaveLength(2);
    expect(body.images[0].isPrimary).toBe(true);
    expect(body.images[1].isPrimary).toBe(false);
    expect(fake.uploaded.length - before).toBe(2);
  });

  it('accepts an AVIF image', async () => {
    const avif = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftyp'),
      Buffer.from('avif'),
      Buffer.alloc(4),
      Buffer.from('mif1'),
      Buffer.from('avif'),
    ]);
    const res = await request(app.getHttpServer())
      .post(url('/products'))
      .field('data', productData())
      .attach('images', avif, { filename: 'image.avif', contentType: 'image/avif' })
      .expect(201);
    expect((res.body as Detail).images).toHaveLength(1);
  });

  it('rejects missing or invalid data with 400', async () => {
    await request(app.getHttpServer()).post(url('/products')).field('data', '{oops').expect(400);
    await request(app.getHttpServer())
      .post(url('/products'))
      .attach('images', PNG, png)
      .expect(400);
  });

  it('rejects a wrong file field name with 400', async () => {
    await request(app.getHttpServer())
      .post(url('/products'))
      .field('data', productData())
      .attach('image', PNG, png)
      .expect(400);
  });

  it('rejects non-image files with 415 and uploads nothing', async () => {
    const before = fake.uploaded.length;
    await request(app.getHttpServer())
      .post(url('/products'))
      .field('data', productData())
      .attach('images', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' })
      .expect(415);
    // Text bytes pretending to be a PNG: caught by the magic-byte check
    await request(app.getHttpServer())
      .post(url('/products'))
      .field('data', productData())
      .attach('images', Buffer.from('not really a png at all'), png)
      .expect(415);
    expect(fake.uploaded.length).toBe(before);
  });

  it('rejects files over 5 MB with 413', async () => {
    const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(6 * 1024 * 1024)]);
    await request(app.getHttpServer())
      .post(url('/products'))
      .field('data', productData())
      .attach('images', big, png)
      .expect(413);
  });

  it('validates specs before uploading (invalid specs upload nothing)', async () => {
    const before = fake.uploaded.length;
    await request(app.getHttpServer())
      .post(url('/products'))
      .field('data', productData({ specs: { cpu: 'only' } }))
      .attach('images', PNG, png)
      .expect(400);
    expect(fake.uploaded.length).toBe(before);
  });

  it('deletes freshly uploaded assets when the DB write fails (no orphans)', async () => {
    const slug = `media-dup-${suffix}`;
    await request(app.getHttpServer())
      .post(url('/products'))
      .field('data', productData({ slug }))
      .expect(201);

    const before = fake.uploaded.length;
    await request(app.getHttpServer())
      .post(url('/products'))
      .field('data', productData({ slug }))
      .attach('images', PNG, png)
      .expect(409);
    const orphans = fake.uploaded.slice(before);
    expect(orphans).toHaveLength(1);
    expect(fake.destroyed).toContain(orphans[0]);
  });

  it('replaces an image on update and deletes the old asset after commit', async () => {
    const created = (
      await request(app.getHttpServer())
        .post(url('/products'))
        .field('data', productData())
        .attach('images', PNG, png)
        .expect(201)
    ).body as Detail;
    const old = created.images[0];

    const updated = (
      await request(app.getHttpServer())
        .patch(url(`/products/${created.id}`))
        .field('data', JSON.stringify({ removeImageIds: [old.id] }))
        .attach('images', PNG, png)
        .expect(200)
    ).body as Detail;

    expect(updated.images).toHaveLength(1);
    expect(updated.images[0].id).not.toBe(old.id);
    expect(updated.images[0].isPrimary).toBe(true);
    expect(fake.destroyed.some((publicId) => old.url.includes(publicId))).toBe(true);
  });

  it('returns 400 for an empty update and for an image of another product', async () => {
    const created = (
      await request(app.getHttpServer())
        .post(url('/products'))
        .field('data', productData())
        .expect(201)
    ).body as Detail;
    await request(app.getHttpServer())
      .patch(url(`/products/${created.id}`))
      .expect(400);
    await request(app.getHttpServer())
      .patch(url(`/products/${created.id}`))
      .field('data', JSON.stringify({ removeImageIds: [randomUUID()] }))
      .expect(400);
  });

  it('deletes a single product image and promotes the next one to primary', async () => {
    const created = (
      await request(app.getHttpServer())
        .post(url('/products'))
        .field('data', productData())
        .attach('images', PNG, png)
        .attach('images', PNG, png)
        .expect(201)
    ).body as Detail;
    const [first, second] = created.images;

    await request(app.getHttpServer())
      .delete(url(`/products/${created.id}/images/${first.id}`))
      .expect(204);
    await request(app.getHttpServer())
      .delete(url(`/products/${created.id}/images/${first.id}`))
      .expect(404);
    expect(fake.destroyed.some((publicId) => first.url.includes(publicId))).toBe(true);

    const detail = (
      await request(app.getHttpServer())
        .get(url(`/products/${created.slug}`))
        .expect(200)
    ).body as Detail;
    expect(detail.images).toHaveLength(1);
    expect(detail.images[0].id).toBe(second.id);
    expect(detail.images[0].isPrimary).toBe(true);
    expect(second.url).toContain('https://');
  });

  it('creates a variant with an image', async () => {
    const created = (
      await request(app.getHttpServer())
        .post(url('/products'))
        .field('data', productData())
        .expect(201)
    ).body as Detail;
    const before = fake.uploaded.length;
    await request(app.getHttpServer())
      .post(url(`/products/${created.id}/variants`))
      .field(
        'data',
        JSON.stringify({ sku: `MEDIA-${suffix.toUpperCase()}`, name: '16 GB', priceMinor: 99900 }),
      )
      .attach('image', PNG, png)
      .expect(201);
    expect(fake.uploaded.length - before).toBe(1);
  });
});
