import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ListOutboxDto } from './outbox.dto';

const select = {
  id: true,
  aggregateType: true,
  aggregateId: true,
  type: true,
  status: true,
  attempts: true,
  lastError: true,
  availableAt: true,
  publishedAt: true,
  createdAt: true,
  payload: true,
} satisfies Prisma.OutboxEventSelect;

type Row = Prisma.OutboxEventGetPayload<{ select: typeof select }>;

const toView = (r: Row) => ({
  id: r.id,
  aggregateType: r.aggregateType,
  aggregateId: r.aggregateId,
  type: r.type,
  status: r.status,
  attempts: r.attempts,
  lastError: r.lastError,
  availableAt: r.availableAt.toISOString(),
  publishedAt: r.publishedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  payload: r.payload as Record<string, unknown>,
});

@Injectable()
export class OutboxAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ListOutboxDto) {
    const where: Prisma.OutboxEventWhereInput = { status: q.status, type: q.type };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.outboxEvent.count({ where }),
      this.prisma.outboxEvent.findMany({
        where,
        select,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      items: rows.map(toView),
      meta: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize),
      },
    };
  }

  async summary() {
    const [groups, oldest] = await Promise.all([
      this.prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.outboxEvent.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    const count = (status: 'PENDING' | 'PUBLISHED' | 'FAILED') =>
      groups.find((g) => g.status === status)?._count._all ?? 0;
    return {
      pending: count('PENDING'),
      published: count('PUBLISHED'),
      failed: count('FAILED'),
      oldestPendingAgeSeconds: oldest
        ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000)
        : null,
    };
  }

  /** FAILED -> PENDING with a fresh attempt budget. The worker picks it up within a second. */
  async retry(id: string) {
    const { count } = await this.prisma.outboxEvent.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, availableAt: new Date(), lastError: null },
    });
    if (count === 0) {
      const exists = await this.prisma.outboxEvent.count({ where: { id } });
      if (!exists) throw new NotFoundException('Outbox event not found');
      throw new ConflictException('Only FAILED events can be retried');
    }
    return toView(await this.prisma.outboxEvent.findUniqueOrThrow({ where: { id }, select }));
  }
}
