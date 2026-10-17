import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { TokensService } from '../../src/auth/tokens.service';
import type { Role } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Real users and real signed tokens (no auth shortcuts). Without an argument, requests act as an
 * administrator; pass a user id for that user, or 'anon' to send no token at all.
 */
export class TestAuth {
  private readonly tokens = new Map<string, string>();
  private adminId = '';

  private constructor(private readonly app: INestApplication) {}

  static async create(app: INestApplication): Promise<TestAuth> {
    const auth = new TestAuth(app);
    auth.adminId = await auth.createUser('ADMIN');
    return auth;
  }

  async createUser(role: Role = 'CUSTOMER'): Promise<string> {
    const user = await this.app.get(PrismaService).user.create({
      data: {
        email: `e2e-${role.toLowerCase()}-${randomUUID()}@voltix.test`,
        name: `E2E ${role}`,
        role,
      },
      select: { id: true },
    });
    this.tokens.set(user.id, this.app.get(TokensService).signAccess(user.id).token);
    return user.id;
  }

  header(userId?: string): Record<string, string> {
    return { Authorization: `Bearer ${this.tokens.get(userId ?? this.adminId) ?? 'missing'}` };
  }

  api(who?: string) {
    const server = this.app.getHttpServer();
    const url = (p: string) => `/${API_PREFIX}${p}`;
    const withAuth = (t: request.Test) => (who === 'anon' ? t : t.set(this.header(who)));
    return {
      get: (p: string) => withAuth(request(server).get(url(p))),
      post: (p: string) => withAuth(request(server).post(url(p))),
      patch: (p: string) => withAuth(request(server).patch(url(p))),
      delete: (p: string) => withAuth(request(server).delete(url(p))),
    };
  }
}
