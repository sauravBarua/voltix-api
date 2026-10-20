import { randomUUID } from 'node:crypto';
import type { TestAuth } from './auth';

type Ref = { id: string; slug: string };
export type OrderBody = { id: string; orderNumber: string; status: string; totalMinor: number };
export type PayBody = { paymentId: string; sessionId: string; url: string; expiresAt: string };

export const address = {
  fullName: 'Test Customer',
  line1: '1 Rue de Test',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};
const specs = { cpu: 'Test CPU', screenSizeInch: 15.6, os: 'Windows 11' };

/** Test data through the real API: variants (price 1000, shipping 990), customers, carts, orders, payments. */
export class Shop {
  private n = 0;
  private readonly suffix = Date.now().toString(36).toUpperCase();

  private constructor(
    private readonly auth: TestAuth,
    private readonly brandId: string,
    private readonly categoryId: string,
  ) {}

  static async create(auth: TestAuth): Promise<Shop> {
    const brands = (await auth.api().get('/brands').expect(200)).body as Ref[];
    const categories = (await auth.api().get('/categories').expect(200)).body as Ref[];
    return new Shop(
      auth,
      brands.find((b) => b.slug === 'dell')!.id,
      categories.find((c) => c.slug === 'laptops')!.id,
    );
  }

  customer() {
    return this.auth.createUser('CUSTOMER');
  }

  async variant(stock: number): Promise<string> {
    const n = ++this.n;
    const product = (
      await this.auth
        .api()
        .post('/products')
        .field(
          'data',
          JSON.stringify({
            name: `Shop Laptop ${this.suffix}-${n}`,
            brandId: this.brandId,
            categoryId: this.categoryId,
            specs,
          }),
        )
        .expect(201)
    ).body as { id: string };
    const variant = (
      await this.auth
        .api()
        .post(`/products/${product.id}/variants`)
        .field(
          'data',
          JSON.stringify({
            sku: `SHP-${this.suffix}-${n}`,
            name: 'Shop variant',
            priceMinor: 1000,
          }),
        )
        .expect(201)
    ).body as { id: string };
    if (stock > 0)
      await this.auth
        .api()
        .post(`/inventory/variants/${variant.id}/stock-in`)
        .send({ quantity: stock })
        .expect(201);
    return variant.id;
  }

  async addToCart(userId: string, variantId: string, quantity = 1) {
    await this.auth.api(userId).post('/cart/items').send({ variantId, quantity }).expect(200);
  }

  checkout(userId: string, key: string = randomUUID()) {
    return this.auth
      .api(userId)
      .post('/orders/checkout')
      .set('Idempotency-Key', key)
      .send({ shippingAddress: address });
  }

  async order(userId: string, variantId: string, quantity = 1): Promise<OrderBody> {
    await this.addToCart(userId, variantId, quantity);
    const res = await this.checkout(userId).expect(201);
    return (res.body as { order: OrderBody }).order;
  }

  async pay(userId: string, orderId: string): Promise<PayBody> {
    return (await this.auth.api(userId).post(`/orders/${orderId}/pay`).expect(200)).body as PayBody;
  }
}
