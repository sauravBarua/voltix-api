import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationHooks } from './reservation-hooks';
import type { ListReservationsDto } from './reservations.dto';
import { reservationSelect, toReservationView } from './reservations.mapper';
import { type ReserveLine, byVariantId, normalizeLines } from './reservations.utils';

type Tx = Prisma.TransactionClient;
type ResolvedLine = { variantId: string; quantity: number };
type Target = 'RELEASED' | 'EXPIRED' | 'CONSUMED';

const EXPIRY_BATCH = 100;

/**
 * Stock reservations. Every method that changes stock takes the CALLER'S transaction:
 * checkout (Phase 9) reserves inside the order-creation transaction, the Stripe webhook
 * (Phase 10) consumes inside the payment transaction. Errors must propagate so it rolls back.
 */
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    private readonly hooks: ReservationHooks,
  ) {
    this.ttlMs = config.get('RESERVATION_TTL_MINUTES', { infer: true }) * 60_000;
  }

  /**
   * Atomically reserves every line or none (409 on the first shortage, 404 for an unknown variant).
   * Idempotent per order: if the order already has reservations they are returned (check their status).
   */
  async reserve(tx: Tx, input: { orderId: string; lines: ReserveLine[] }) {
    const lines = normalizeLines(input.lines);

    const existing = await tx.stockReservation.findMany({
      where: { orderId: input.orderId },
      select: reservationSelect,
      orderBy: { variantId: 'asc' },
    });
    if (existing.length > 0)
      return { replayed: true, reservations: existing.map(toReservationView) };

    const expiresAt = new Date(Date.now() + this.ttlMs);

    for (const line of lines) {
      // The guard: only reserve what is available (on_hand - reserved), in a single statement.
      const rows = await tx.$queryRaw<{ variantId: string }[]>`
        UPDATE inventory_items
        SET reserved = reserved + ${line.quantity}::int, version = version + 1, updated_at = now()
        WHERE variant_id = ${line.variantId}::uuid
          AND on_hand - reserved >= ${line.quantity}::int
        RETURNING variant_id AS "variantId"`;
      if (rows.length === 0) await this.explainShortage(tx, line); // always throws
    }

    await tx.stockReservation.createMany({
      data: lines.map((l) => ({
        orderId: input.orderId,
        variantId: l.variantId,
        quantity: l.quantity,
        expiresAt,
      })),
    });
    await tx.inventoryMovement.createMany({
      data: lines.map((l) => ({
        variantId: l.variantId,
        type: 'RESERVE' as const,
        deltaOnHand: 0,
        deltaReserved: l.quantity,
        reason: 'Stock reserved for order',
        referenceType: 'ORDER',
        referenceId: input.orderId,
      })),
    });

    const reservations = await tx.stockReservation.findMany({
      where: { orderId: input.orderId },
      select: reservationSelect,
      orderBy: { variantId: 'asc' },
    });
    return { replayed: false, reservations: reservations.map(toReservationView) };
  }

  /** ACTIVE -> RELEASED (order cancelled). Returns the released lines; [] means nothing was active. */
  release(tx: Tx, orderId: string) {
    return this.transition(tx, orderId, 'RELEASED');
  }

  /** ACTIVE -> EXPIRED. With `dueBefore`, only reservations still due at that moment (race-safe vs extension). */
  expireOrder(tx: Tx, orderId: string, dueBefore?: Date) {
    return this.transition(tx, orderId, 'EXPIRED', dueBefore);
  }

  /**
   * Pushes the hold of an order's ACTIVE reservations out to at least `minExpiresAt` (never shortens it).
   * Returns how many reservations were extended: 0 means the hold is already gone.
   */
  async extendHold(tx: Tx, orderId: string, minExpiresAt: Date): Promise<number> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE stock_reservations
      SET expires_at = GREATEST(expires_at, ${minExpiresAt.toISOString()}::timestamptz), updated_at = now()
      WHERE order_id = ${orderId}::uuid AND status = 'ACTIVE'
      RETURNING id`;
    return rows.length;
  }

  /** ACTIVE -> CONSUMED (payment succeeded): on_hand and reserved both drop. [] means it was not active. */
  consume(tx: Tx, orderId: string) {
    return this.transition(tx, orderId, 'CONSUMED');
  }

  /**
   * Expires every due reservation, one transaction per order so a failure never blocks the rest.
   * Called by the admin endpoint now and by the scheduled job in Phase 15. Safe to run concurrently.
   */
  async expireDue(opts: { now?: Date; limit?: number } = {}) {
    const now = opts.now ?? new Date();
    const due = await this.prisma.$queryRaw<{ orderId: string }[]>`
      SELECT DISTINCT order_id AS "orderId"
      FROM stock_reservations
      WHERE status = 'ACTIVE' AND expires_at <= ${now.toISOString()}::timestamptz
      LIMIT ${opts.limit ?? EXPIRY_BATCH}`;

    let expiredOrders = 0;
    let failedOrders = 0;
    const expiredIds: string[] = [];
    for (const { orderId } of due) {
      try {
        const lines = await this.prisma.$transaction(async (tx) => {
          // Re-checks "still due" under the row lock: a concurrent extension (payment started) wins
          const resolved = await this.expireOrder(tx, orderId, now);
          if (resolved.length > 0) {
            // Conditional: a paid or already cancelled order is left alone
            await tx.order.updateMany({
              where: { id: orderId, status: 'PENDING_PAYMENT' },
              data: {
                status: 'CANCELLED',
                cancelReason: 'RESERVATION_EXPIRED',
                cancelledAt: new Date(),
              },
            });
          }
          return resolved;
        });
        if (lines.length > 0) {
          expiredOrders++;
          expiredIds.push(orderId);
        }
      } catch (error) {
        failedOrders++;
        this.logger.error(
          `Failed to expire reservations of order ${orderId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // After the commits: close the Stripe Checkout Sessions of the orders just expired
    if (expiredIds.length > 0) await this.hooks.runExpired(expiredIds);
    return { expiredOrders, failedOrders };
  }

  async list(q: ListReservationsDto) {
    const where: Prisma.StockReservationWhereInput = {
      status: q.status,
      orderId: q.orderId,
      variantId: q.variantId,
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.stockReservation.count({ where }),
      this.prisma.stockReservation.findMany({
        where,
        select: reservationSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      items: rows.map(toReservationView),
      meta: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize),
      },
    };
  }

  /**
   * The single gate for every state change. The UPDATE ... WHERE status = 'ACTIVE' RETURNING
   * hands the rows to exactly one transaction: a concurrent expiry, cancellation or payment
   * blocks on the row lock, re-checks the status, gets nothing back, and does nothing.
   */
  private async transition(
    tx: Tx,
    orderId: string,
    to: Target,
    dueBefore?: Date,
  ): Promise<ResolvedLine[]> {
    const dueClause = dueBefore
      ? Prisma.sql`AND expires_at <= ${dueBefore.toISOString()}::timestamptz`
      : Prisma.empty;
    // `to` is a typed union of constants, never user input, so injecting it as a literal is safe
    const rows = await tx.$queryRaw<ResolvedLine[]>`
      UPDATE stock_reservations
      SET status = ${Prisma.raw(`'${to}'`)}, resolved_at = now(), updated_at = now()
      WHERE order_id = ${orderId}::uuid AND status = 'ACTIVE' ${dueClause}
      RETURNING variant_id AS "variantId", quantity`;
    const lines = [...rows].sort(byVariantId); // same lock order as reserve()

    for (const line of lines) {
      const updated =
        to === 'CONSUMED'
          ? await tx.$queryRaw<unknown[]>`
              UPDATE inventory_items
              SET on_hand = on_hand - ${line.quantity}::int, reserved = reserved - ${line.quantity}::int,
                  version = version + 1, updated_at = now()
              WHERE variant_id = ${line.variantId}::uuid
                AND reserved >= ${line.quantity}::int AND on_hand >= ${line.quantity}::int
              RETURNING variant_id`
          : await tx.$queryRaw<unknown[]>`
              UPDATE inventory_items
              SET reserved = reserved - ${line.quantity}::int, version = version + 1, updated_at = now()
              WHERE variant_id = ${line.variantId}::uuid AND reserved >= ${line.quantity}::int
              RETURNING variant_id`;
      if (updated.length === 0) {
        // reserved < reservation quantity means the books are already inconsistent: abort loudly
        this.logger.error(
          `Stock invariant violated: order ${orderId}, variant ${line.variantId}, ${to}`,
        );
        throw new Error(`Stock invariant violated for variant ${line.variantId}`);
      }
    }

    if (lines.length > 0) {
      await tx.inventoryMovement.createMany({
        data: lines.map((l) =>
          to === 'CONSUMED'
            ? {
                variantId: l.variantId,
                type: 'SALE' as const,
                deltaOnHand: -l.quantity,
                deltaReserved: -l.quantity,
                reason: 'Sale completed',
                referenceType: 'ORDER',
                referenceId: orderId,
              }
            : {
                variantId: l.variantId,
                type: 'RELEASE' as const,
                deltaOnHand: 0,
                deltaReserved: -l.quantity,
                reason: to === 'EXPIRED' ? 'Reservation expired' : 'Reservation released',
                referenceType: 'ORDER',
                referenceId: orderId,
              },
        ),
      });
    }
    return lines;
  }

  private async explainShortage(tx: Tx, line: ReserveLine): Promise<never> {
    const item = await tx.inventoryItem.findUnique({
      where: { variantId: line.variantId },
      select: { onHand: true, reserved: true, variant: { select: { sku: true } } },
    });
    if (!item) throw new NotFoundException(`Variant ${line.variantId} not found`);
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'Not enough stock available',
      variantId: line.variantId,
      sku: item.variant.sku,
      available: item.onHand - item.reserved,
      requested: line.quantity,
    });
  }
}
