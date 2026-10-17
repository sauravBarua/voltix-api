import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { enqueueOutbox } from '../outbox/outbox';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';
import { MAX_ORDER_TOTAL_MINOR } from './orders.constants';
import type { AdminListOrdersDto, CheckoutDto, ListOrdersDto } from './orders.dto';
import { adminOrderSelect, orderSelect, toAdminOrderView, toOrderView } from './orders.mapper';
import { computeShipping, generateOrderNumber } from './orders.utils';

type Tx = Prisma.TransactionClient;

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

const meta = (page: number, pageSize: number, total: number) => ({
  page,
  pageSize,
  total,
  totalPages: Math.ceil(total / pageSize),
});

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationsService,
    private readonly payments: PaymentsService,
  ) {}

  async checkout(userId: string, idempotencyKey: string, dto: CheckoutDto) {
    const existing = await this.resolveExisting(userId, idempotencyKey);
    if (existing) return { replayed: true, order: toOrderView(existing) };

    try {
      const orderId = await this.prisma.$transaction((tx) =>
        this.createOrder(tx, userId, idempotencyKey, dto),
      );
      return { replayed: false, order: toOrderView(await this.findOwned(userId, orderId)) };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost a race: either an identical parallel request won (replay) or another open order exists (409)
      const raced = await this.resolveExisting(userId, idempotencyKey);
      if (raced) return { replayed: true, order: toOrderView(raced) };
      throw error;
    }
  }

  async get(userId: string, orderId: string) {
    return toOrderView(await this.findOwned(userId, orderId));
  }

  async list(userId: string, q: ListOrdersDto) {
    const where: Prisma.OrderWhereInput = { userId, status: q.status };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        select: orderSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows.map(toOrderView), meta: meta(q.page, q.pageSize, total) };
  }

  /** Customer cancellation of an unpaid order. Idempotent; paid orders are refunded in Phase 10. */
  async cancel(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { status: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'CANCELLED') return this.get(userId, orderId);
    if (order.status !== 'PENDING_PAYMENT') {
      throw new ConflictException(`An order in status ${order.status} cannot be cancelled`);
    }

    // Close the Stripe Checkout Session first: once it is expired the customer can no longer pay.
    // Throws 409 if the payment has already completed (it is being confirmed by the webhook).
    await this.payments.expireOpenSession(orderId);

    const cancelled = await this.prisma.$transaction(async (tx) => {
      // Lock order shared with expiry and payment: reservations first, then the order row
      const released = await this.reservations.release(tx, orderId);
      const { count } = await tx.order.updateMany({
        where: { id: orderId, userId, status: 'PENDING_PAYMENT' },
        data: { status: 'CANCELLED', cancelReason: 'CUSTOMER_CANCELLED', cancelledAt: new Date() },
      });
      if (count === 0 && released.length > 0) {
        throw new Error(`Order ${orderId} had active reservations but was not pending`); // roll back
      }
      if (count > 0) {
        await enqueueOutbox(tx, {
          aggregateId: orderId,
          type: 'order.cancelled',
          payload: { orderId, reason: 'CUSTOMER_CANCELLED' },
        });
      }
      return count > 0;
    });

    if (!cancelled) {
      // Paid, or cancelled by expiry, between our read and our write
      const current = await this.findOwned(userId, orderId);
      if (current.status === 'CANCELLED') return toOrderView(current);
      throw new ConflictException(`The order changed while cancelling (status: ${current.status})`);
    }
    return this.get(userId, orderId);
  }

  // ───────── admin ─────────

  async listAll(q: AdminListOrdersDto) {
    const where: Prisma.OrderWhereInput = {
      status: q.status,
      userId: q.userId,
      OR: q.q
        ? [
            { orderNumber: { contains: q.q, mode: 'insensitive' } },
            { user: { email: { contains: q.q, mode: 'insensitive' } } },
          ]
        : undefined,
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        select: adminOrderSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows.map(toAdminOrderView), meta: meta(q.page, q.pageSize, total) };
  }

  async getAdmin(orderId: string) {
    const row = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: adminOrderSelect,
    });
    if (!row) throw new NotFoundException('Order not found');
    return toAdminOrderView(row);
  }

  /** PAID -> SHIPPED. Idempotent for orders that are already shipped. */
  async ship(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'SHIPPED') return this.getAdmin(orderId);
    if (order.status !== 'PAID') {
      throw new ConflictException(
        `Only paid orders can be shipped (current status: ${order.status})`,
      );
    }
    const shipped = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: 'PAID' },
        data: { status: 'SHIPPED', shippedAt: new Date() },
      });
      if (count > 0) {
        await enqueueOutbox(tx, {
          aggregateId: orderId,
          type: 'order.shipped',
          payload: { orderId },
        });
      }
      return count > 0;
    });
    if (!shipped) throw new ConflictException('The order status changed, please reload');
    return this.getAdmin(orderId);
  }

  // ───────── internals ─────────

  /** Order, price snapshot and reservation in ONE transaction: a stock shortage rolls everything back. */
  private async createOrder(tx: Tx, userId: string, idempotencyKey: string, dto: CheckoutDto) {
    const cart = await tx.cart.findUnique({
      where: { userId },
      select: {
        items: {
          orderBy: { createdAt: 'asc' },
          select: {
            quantity: true,
            variant: {
              select: {
                id: true,
                sku: true,
                name: true,
                priceMinor: true,
                currency: true,
                isActive: true,
                product: { select: { name: true, isActive: true } },
              },
            },
          },
        },
      },
    });
    const lines = cart?.items ?? [];
    if (lines.length === 0) throw new BadRequestException('Your cart is empty');

    const unavailable = lines.filter((l) => !l.variant.isActive || !l.variant.product.isActive);
    if (unavailable.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Some items are no longer available. Remove them from your cart.',
        unavailable: unavailable.map((l) => ({ variantId: l.variant.id, sku: l.variant.sku })),
      });
    }

    const currency = lines[0].variant.currency;
    if (lines.some((l) => l.variant.currency !== currency)) {
      throw new BadRequestException('All items in an order must use the same currency');
    }

    // Prices come from the database, never from the client
    const subtotalMinor = lines.reduce((sum, l) => sum + l.variant.priceMinor * l.quantity, 0);
    const shippingMinor = computeShipping(subtotalMinor);
    const totalMinor = subtotalMinor + shippingMinor;
    if (totalMinor > MAX_ORDER_TOTAL_MINOR) {
      throw new BadRequestException('The order total exceeds the maximum allowed amount');
    }

    const order = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        userId,
        subtotalMinor,
        shippingMinor,
        totalMinor,
        currency,
        idempotencyKey,
        shippingAddress: { ...dto.shippingAddress } as Prisma.InputJsonObject,
        items: {
          create: lines.map((l) => ({
            variantId: l.variant.id,
            skuSnapshot: l.variant.sku,
            nameSnapshot: `${l.variant.product.name} - ${l.variant.name}`,
            unitPriceMinor: l.variant.priceMinor,
            quantity: l.quantity,
          })),
        },
      },
      select: { id: true },
    });

    // All-or-nothing: a shortage throws 409 and the transaction (order included) rolls back
    await this.reservations.reserve(tx, {
      orderId: order.id,
      lines: lines.map((l) => ({ variantId: l.variant.id, quantity: l.quantity })),
    });
    await enqueueOutbox(tx, {
      aggregateId: order.id,
      type: 'order.created',
      payload: { orderId: order.id, userId, totalMinor, currency },
    });
    return order.id;
  }

  /**
   * The order this key already produced (replay), or null when checkout may proceed.
   * Throws 409 if the user has a different unpaid order.
   */
  private async resolveExisting(userId: string, key: string) {
    const byKey = await this.findByKey(userId, key);
    if (byKey) return byKey;

    const open = await this.prisma.order.findFirst({
      where: { userId, status: 'PENDING_PAYMENT' },
      select: { id: true, orderNumber: true },
    });
    if (!open) return null;

    // Re-check the key: an identical parallel request may have committed in between
    const again = await this.findByKey(userId, key);
    if (again) return again;

    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'You already have an order awaiting payment. Pay or cancel it first.',
      orderId: open.id,
      orderNumber: open.orderNumber,
    });
  }

  private findByKey(userId: string, idempotencyKey: string) {
    return this.prisma.order.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: orderSelect,
    });
  }

  private async findOwned(userId: string, orderId: string) {
    const row = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: orderSelect,
    });
    if (!row) throw new NotFoundException('Order not found');
    return row;
  }
}
