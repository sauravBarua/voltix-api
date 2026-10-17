import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditController } from '../audit/audit.controller';
import { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JWT_ISSUER, TokensService } from './tokens.service';
import { UsersAdminController } from './users-admin.controller';
import { UsersAdminService } from './users-admin.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: {
          algorithm: 'HS256' as const,
          issuer: JWT_ISSUER,
          expiresIn: config.get('ACCESS_TOKEN_TTL_MINUTES', { infer: true }) * 60,
        },
        verifyOptions: { algorithms: ['HS256' as const], issuer: JWT_ISSUER },
      }),
    }),
  ],
  controllers: [AuthController, UsersAdminController, AuditController],
  providers: [TokensService, AuthService, UsersAdminService, AuditService],
  exports: [TokensService, AuditService],
})
export class AuthModule {}
