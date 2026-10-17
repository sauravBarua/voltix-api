import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AdjustmentDto,
  ListInventoryDto,
  ListMovementsDto,
  StockInDto,
  StockOutDto,
} from './inventory.dto';
import {
  type ItemInput,
  type StockRow,
  mapMovement,
  movementSelect,
  toItem,
  toSnapshot,
} from './inventory.mapper';
import { escapeLike } from './inventory.utils';

type Tx = Prisma.TransactionClient;

type Operation = {
  type: 'STOCK_IN' | 'STOCK_OUT' | 'ADJUSTMENT';
  variantId: string;
  delta: number;
  reason?: string;
  idempotencyKey?: string;
  actorId?: string; // set from the authenticated user in Phase 13
};

const meta = (page: number, pageSize: number, total: number) => ({
  page,
  pageSize,
  total,
  totalPages: Math.ceil(total / pageSize),
});

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  stockIn(variantId: string, dto: StockInDto) {
    return this.apply({
      type: 'STOCK_IN',
      variantId,
      delta: dto.quantity,
      reason: dto.reason,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  stockOut(variantId: string, dto: StockOutDto) {
    return this.apply({
      type: 'STOCK_OUT',
      variantId,
      delta: -dto.quantity,
      reason: dto.reason,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  adjust(variantId: string, dto: AdjustmentDto) {
    return this.apply({
      type: 'ADJUSTMENT',
      variantId,
      delta: dto.delta,
      reason: dto.reason,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  async setReorderLevel(variantId: string, reorderLevel: number) {
    await this.prisma.inventoryItem.update({ where: { variantId }, data: { reorderLevel } }); // P2025 -> 404
    return this.getItem(variantId);
  }

  async getItem(variantId: string) {
    const row = await this.prisma.inventoryItem.findUnique({
      where: { variantId },
      select: {
        onHand: true,
        reserved: true,
        reorderLevel: true,
        variant: {
          select: {
            sku: true,
            name: true,
            isActive: true,
            priceMinor: true,
            product: { select: { name: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Variant not found');
    return toItem({
      variantId,
      onHand: row.onHand,
      reserved: row.reserved,
      reorderLevel: row.reorderLevel,
      sku: row.variant.sku,
      variantName: row.variant.name,
      productName: row.variant.product.name,
      isActive: row.variant.isActive,
      priceMinor: row.variant.priceMinor,
    });
  }

  async list(q: ListInventoryDto) {
    const conds: Prisma.Sql[] = [];
    if (q.includeInactive !== 'true') conds.push(Prisma.sql`v.is_active = true`);
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      conds.push(Prisma.sql`(v.sku ILIKE ${like} OR v.name ILIKE ${like} OR p.name ILIKE ${like})`);
    }
    if (q.status === 'low') conds.push(Prisma.sql`i.on_hand - i.reserved <= i.reorder_level`);
    if (q.status === 'out') conds.push(Prisma.sql`i.on_hand - i.reserved <= 0`);

    const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
    const order =
      q.status === 'all'
        ? Prisma.sql`v.sku ASC`
        : Prisma.sql`(i.on_hand - i.reserved) ASC, v.sku ASC`;
    const offset = (q.page - 1) * q.pageSize;

    const [rows, counts] = await Promise.all([
      this.prisma.$queryRaw<ItemInput[]>`
        SELECT v.id AS "variantId", v.sku, v.name AS "variantName", p.name AS "productName",
               v.is_active AS "isActive", v.price_minor AS "priceMinor",
               i.on_hand AS "onHand", i.reserved, i.reorder_level AS "reorderLevel"
        FROM inventory_items i
        JOIN product_variants v ON v.id = i.variant_id
        JOIN products p ON p.id = v.product_id
        ${where}
        ORDER BY ${order}
        LIMIT ${q.pageSize} OFFSET ${offset}`,
      this.prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM inventory_items i
        JOIN product_variants v ON v.id = i.variant_id
        JOIN products p ON p.id = v.product_id
        ${where}`,
    ]);
    return { items: rows.map(toItem), meta: meta(q.page, q.pageSize, counts[0]?.count ?? 0) };
  }

  async listMovements(q: ListMovementsDto) {
    const where: Prisma.InventoryMovementWhereInput = {
      variantId: q.variantId,
      type: q.type,
      createdAt: {
        gte: q.from ? new Date(q.from) : undefined,
        lte: q.to ? new Date(q.to) : undefined,
      },
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.inventoryMovement.count({ where }),
      this.prisma.inventoryMovement.findMany({
        where,
        select: movementSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows.map(mapMovement), meta: meta(q.page, q.pageSize, total) };
  }

  /**
   * Guarded stock change + ledger row in ONE transaction.
   * Phase 8 reservations reuse the same pattern on the `reserved` column.
   */
  private async apply(op: Operation) {
    if (op.idempotencyKey) {
      const replay = await this.findReplay(op);
      if (replay) return this.replayResult(op.variantId, replay);
    }

    try {
      const { stock, movement } = await this.prisma.$transaction(async (tx) => {
        const rows = await this.guardedUpdate(tx, op);
        if (rows.length === 0) await this.explainFailure(tx, op); // always throws
        const created = await tx.inventoryMovement.create({
          data: {
            variantId: op.variantId,
            type: op.type,
            deltaOnHand: op.delta,
            deltaReserved: 0,
            reason: op.reason,
            referenceType: 'MANUAL',
            referenceId: op.idempotencyKey,
            actorId: op.actorId,
          },
          select: movementSelect,
        });
        return { stock: rows[0], movement: created };
      });
      return { replayed: false, movement: mapMovement(movement), stock: toSnapshot(stock) };
    } catch (error) {
      // Two concurrent requests with the same key: the loser hits the unique index and rolls back
      if (
        op.idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const replay = await this.findReplay(op);
        if (replay) return this.replayResult(op.variantId, replay);
      }
      throw error;
    }
  }

  /**
   * One statement, no read-then-write. The WHERE clause is the guard:
   * on_hand + delta >= reserved  (for a stock-out: available >= quantity).
   * Under READ COMMITTED a concurrent writer makes this statement wait for the row lock,
   * then Postgres re-evaluates the WHERE on the updated row, so two requests can never both pass.
   */
  private guardedUpdate(tx: Tx, op: Operation) {
    return tx.$queryRaw<StockRow[]>`
      UPDATE inventory_items
      SET on_hand = on_hand + ${op.delta}::int, version = version + 1, updated_at = now()
      WHERE variant_id = ${op.variantId}::uuid
        AND on_hand + ${op.delta}::int >= reserved
      RETURNING variant_id AS "variantId", on_hand AS "onHand", reserved, reorder_level AS "reorderLevel"`;
  }

  private async explainFailure(tx: Tx, op: Operation): Promise<never> {
    const item = await tx.inventoryItem.findUnique({
      where: { variantId: op.variantId },
      select: { onHand: true, reserved: true },
    });
    if (!item) throw new NotFoundException('Variant not found');
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'Not enough available stock for this operation',
      onHand: item.onHand,
      reserved: item.reserved,
      available: item.onHand - item.reserved,
      requestedDelta: op.delta,
    });
  }

  private findReplay(op: Operation) {
    return this.prisma.inventoryMovement.findFirst({
      where: {
        referenceType: 'MANUAL',
        referenceId: op.idempotencyKey,
        variantId: op.variantId,
        type: op.type,
      },
      select: movementSelect,
    });
  }

  /** The original movement, with the CURRENT stock (it may have changed since). */
  private async replayResult(variantId: string, movement: Parameters<typeof mapMovement>[0]) {
    const item = await this.getItem(variantId);
    return { replayed: true, movement: mapMovement(movement), stock: toSnapshot(item) };
  }
}
