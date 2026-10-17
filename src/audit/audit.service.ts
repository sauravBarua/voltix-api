import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ListAuditDto } from './audit.dto';

export type AuditEntry = {
  actorId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  outcome?: 'SUCCESS' | 'FAILURE';
  ip?: string | null;
  metadata?: Prisma.InputJsonObject;
};

const toData = (e: AuditEntry): Prisma.AuditLogUncheckedCreateInput => ({
  actorId: e.actorId ?? null,
  actorEmail: e.actorEmail ?? null,
  actorRole: e.actorRole ?? null,
  action: e.action,
  entityType: e.entityType ?? null,
  entityId: e.entityId ?? null,
  outcome: e.outcome ?? 'SUCCESS',
  ip: e.ip ?? null,
  metadata: e.metadata ?? {},
});

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Best effort: a failing audit write is logged but never breaks the request it describes. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: toData(entry), select: { id: true } });
    } catch (error) {
      this.logger.error(
        `Audit write failed (${entry.action}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Inside the caller's transaction: the entry commits or rolls back together with the change. */
  recordIn(tx: Prisma.TransactionClient, entry: AuditEntry) {
    return tx.auditLog.create({ data: toData(entry), select: { id: true } });
  }

  async list(q: ListAuditDto) {
    const where: Prisma.AuditLogWhereInput = {
      actorId: q.actorId,
      action: q.action,
      entityType: q.entityType,
      entityId: q.entityId,
      outcome: q.outcome,
      createdAt: {
        gte: q.from ? new Date(q.from) : undefined,
        lte: q.to ? new Date(q.to) : undefined,
      },
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        actorId: r.actorId,
        actorEmail: r.actorEmail,
        actorRole: r.actorRole,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        outcome: r.outcome,
        ip: r.ip,
        metadata: r.metadata as Record<string, unknown>,
        createdAt: r.createdAt.toISOString(),
      })),
      meta: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize),
      },
    };
  }
}
