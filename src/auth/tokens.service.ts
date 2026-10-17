import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import type { Env } from '../config/env';

export const JWT_ISSUER = 'voltix-api';

@Injectable()
export class TokensService {
  private readonly ttlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlSeconds = config.get('ACCESS_TOKEN_TTL_MINUTES', { infer: true }) * 60;
  }

  signAccess(userId: string) {
    return { token: this.jwt.sign({ sub: userId }), expiresInSeconds: this.ttlSeconds };
  }

  /** Returns the user id and the expiry (ms since epoch). The JwtModule options check signature, algorithm, issuer and expiry. */
  async verifyAccessDetailed(token: string): Promise<{ userId: string; expiresAt: number }> {
    let payload: { sub?: unknown; exp?: unknown };
    try {
      payload = await this.jwt.verifyAsync<{ sub?: unknown; exp?: unknown }>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const sub = z.uuid().safeParse(payload.sub);
    const exp = z.number().safeParse(payload.exp);
    if (!sub.success || !exp.success) throw new UnauthorizedException('Invalid or expired token');
    return { userId: sub.data, expiresAt: exp.data * 1000 };
  }

  async verifyAccess(token: string): Promise<string> {
    return (await this.verifyAccessDetailed(token)).userId;
  }

  /** 256 random bits; only the SHA-256 is stored, so a database leak does not leak usable tokens. */
  newRefreshToken() {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashRefresh(token) };
  }

  hashRefresh(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
