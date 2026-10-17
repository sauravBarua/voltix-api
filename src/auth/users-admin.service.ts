import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './auth.types';
import { hashPassword } from './password';
import type { CreateUserDto, ListUsersDto, UpdateUserDto } from './users.dto';
import { toUserView, userSelect } from './user.mapper';

@Injectable()
export class UsersAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: ListUsersDto) {
    const where: Prisma.UserWhereInput = {
      role: q.role,
      isActive: q.isActive === undefined ? undefined : q.isActive === 'true',
      OR: q.q
        ? [
            { email: { contains: q.q, mode: 'insensitive' } },
            { name: { contains: q.q, mode: 'insensitive' } },
          ]
        : undefined,
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: userSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      items: rows.map(toUserView),
      meta: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize),
      },
    };
  }

  async create(dto: CreateUserDto, actor: AuthUser, ip?: string) {
    const passwordHash = await hashPassword(dto.password);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: dto.email, name: dto.name, role: dto.role, passwordHash },
        select: userSelect,
      }); // duplicate email -> unique violation -> 409
      await this.audit.recordIn(tx, {
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        action: 'user.create',
        entityType: 'user',
        entityId: user.id,
        ip,
        metadata: { role: user.role },
      });
      return toUserView(user);
    });
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser, ip?: string) {
    return this.prisma.$transaction(async (tx) => {
      // Serialize concurrent admin changes: two admins demoting each other cannot both succeed
      await tx.$queryRaw`SELECT id FROM users WHERE role = 'ADMIN' AND is_active = true ORDER BY id FOR UPDATE`;

      const current = await tx.user.findUnique({
        where: { id: actor.id },
        select: { role: true, isActive: true },
      });
      if (current?.role !== 'ADMIN' || !current.isActive) {
        throw new ForbiddenException('Your role cannot access this resource');
      }
      const target = await tx.user.findUnique({
        where: { id },
        select: { id: true, role: true, isActive: true },
      });
      if (!target) throw new NotFoundException('User not found');

      const changesRole = dto.role !== undefined && dto.role !== target.role;
      if (id === actor.id && (changesRole || dto.isActive === false)) {
        throw new ConflictException('You cannot change your own role or deactivate yourself');
      }
      const losesAdmin =
        target.role === 'ADMIN' && target.isActive && (changesRole || dto.isActive === false);
      if (losesAdmin && (await tx.user.count({ where: { role: 'ADMIN', isActive: true } })) <= 1) {
        throw new ConflictException('At least one active administrator is required');
      }

      const updated = await tx.user.update({
        where: { id },
        data: { role: dto.role, isActive: dto.isActive },
        select: userSelect,
      });
      if (dto.isActive === false) {
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await this.audit.recordIn(tx, {
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        ip,
        metadata: {
          from: { role: target.role, isActive: target.isActive },
          to: { role: updated.role, isActive: updated.isActive },
        },
      });
      return toUserView(updated);
    });
  }
}
