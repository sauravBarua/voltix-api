import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ChangePasswordDto, LoginDto, RegisterDto } from './auth.dto';
import { hashPassword, verifyPassword } from './password';
import { TokensService } from './tokens.service';
import { type UserRow, toUserView, userSelect } from './user.mapper';

export type RequestMeta = { ip?: string; userAgent?: string };
type RefreshDb = Pick<Prisma.TransactionClient, 'refreshToken'>;

const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService {
  private readonly refreshTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.refreshTtlMs = config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 86_400_000;
  }

  async register(dto: RegisterDto, meta: RequestMeta) {
    const passwordHash = await hashPassword(dto.password);
    // A duplicate email is a unique violation: the Prisma filter answers 409
    const user = await this.prisma.user.create({
      data: { email: dto.email, name: dto.name, role: 'CUSTOMER', passwordHash },
      select: userSelect,
    });
    await this.audit.record(this.actor(user, 'auth.register', meta));
    return this.issue(user, meta);
  }

  async login(dto: LoginDto, meta: RequestMeta) {
    const found = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { ...userSelect, passwordHash: true },
    });
    const valid = await verifyPassword(dto.password, found?.passwordHash ?? null); // always costs one hash
    if (!found || !valid || !found.isActive) {
      await this.audit.record({
        actorId: found?.id,
        actorEmail: found?.email,
        actorRole: found?.role,
        action: 'auth.login',
        outcome: 'FAILURE',
        ip: meta.ip,
        metadata: found
          ? { reason: found.isActive ? 'bad_password' : 'inactive' }
          : { email: dto.email },
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS); // same answer for every cause
    }
    await this.audit.record(this.actor(found, 'auth.login', meta));
    return this.issue(found, meta);
  }

  /** Rotation: the presented token is consumed and a new one issued in the same session family. */
  async refresh(token: string, meta: RequestMeta) {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefresh(token) },
      select: {
        id: true,
        familyId: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: userSelect },
      },
    });
    if (!row) throw new UnauthorizedException('Invalid refresh token');

    if (row.revokedAt) {
      // A used token came back: assume theft and end the whole session family
      const { count } = await this.prisma.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Only the first reuse ends a live session; replays of already-dead tokens are not new events
      if (count > 0) {
        await this.audit.record({
          ...this.actor(row.user, 'auth.refresh_reuse_detected', meta),
          outcome: 'FAILURE',
        });
      }
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (row.expiresAt <= new Date() || !row.user.isActive)
      throw new UnauthorizedException('Invalid refresh token');

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw new UnauthorizedException('Invalid refresh token'); // lost a parallel rotation
      return this.issue(row.user, meta, row.familyId, tx);
    });
  }

  /** Ends one session. Always succeeds, so it reveals nothing about the token. */
  async logout(token: string, meta: RequestMeta): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefresh(token) },
      select: { familyId: true, user: { select: userSelect } },
    });
    if (!row) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record(this.actor(row.user, 'auth.logout', meta));
  }

  async logoutAll(userId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({ actorId: userId, action: 'auth.logout_all', ip: meta.ip });
  }

  async changePassword(userId: string, dto: ChangePasswordDto, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...userSelect, passwordHash: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!(await verifyPassword(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('The new password must differ from the current one');
    }
    const passwordHash = await hashPassword(dto.newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
        select: { id: true },
      }),
      // Every session ends. Access tokens already issued live until they expire (15 min).
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await this.audit.record(this.actor(user, 'auth.password_changed', meta));
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!user) throw new NotFoundException('User not found');
    return toUserView(user);
  }

  private async issue(
    user: UserRow,
    meta: RequestMeta,
    familyId: string = randomUUID(),
    tx?: RefreshDb,
  ) {
    const access = this.tokens.signAccess(user.id);
    const refresh = this.tokens.newRefreshToken();
    const db: RefreshDb = tx ?? this.prisma;
    await db.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: refresh.hash,
        expiresAt: new Date(Date.now() + this.refreshTtlMs),
        userAgent: meta.userAgent?.slice(0, 200),
        ip: meta.ip,
      },
      select: { id: true },
    });
    return {
      tokenType: 'Bearer' as const,
      accessToken: access.token,
      expiresIn: access.expiresInSeconds,
      refreshToken: refresh.token,
      user: toUserView(user),
    };
  }

  private actor(user: UserRow, action: string, meta: RequestMeta) {
    return { actorId: user.id, actorEmail: user.email, actorRole: user.role, action, ip: meta.ip };
  }
}
