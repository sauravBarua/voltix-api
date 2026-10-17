import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUserId } from '../common/auth/current-user-id.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { Authenticated, Public, SkipAudit } from './access.decorators';
import {
  AuthTokensDto,
  ChangePasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  UserDto,
} from './auth.dto';
import { AuthService, type RequestMeta } from './auth.service';

const metaOf = (req: Request): RequestMeta => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

@ApiTags('Auth')
@SkipAudit()
@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Post('register')
  @Public()
  @RateLimit('strict')
  @ApiOperation({ summary: 'Create a customer account and log in' })
  @ApiCreatedResponse({ type: AuthTokensDto })
  @ApiBadRequestResponse({ description: 'Invalid email, name or password (min 10 characters)' })
  @ApiConflictResponse({ description: 'Email already registered' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.service.register(dto, metaOf(req));
  }

  @Post('login')
  @Public()
  @RateLimit('strict')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiUnauthorizedResponse({
    description: 'Invalid email or password (same answer for every cause)',
  })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.service.login(dto, metaOf(req));
  }

  @Post('refresh')
  @Public()
  @RateLimit('strict')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a refresh token for new tokens (the old one stops working)' })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiUnauthorizedResponse({ description: 'Unknown, expired or already used refresh token' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.service.refresh(dto.refreshToken, metaOf(req));
  }

  @Post('logout')
  @Public()
  @HttpCode(204)
  @ApiOperation({ summary: 'End the session of a refresh token (always 204)' })
  @ApiNoContentResponse()
  async logout(@Body() dto: RefreshDto, @Req() req: Request) {
    await this.service.logout(dto.refreshToken, metaOf(req));
  }

  @Post('logout-all')
  @Authenticated()
  @HttpCode(204)
  @ApiOperation({ summary: 'End every session of the current user' })
  @ApiNoContentResponse()
  async logoutAll(@CurrentUserId() userId: string, @Req() req: Request) {
    await this.service.logoutAll(userId, metaOf(req));
  }

  @Post('change-password')
  @Authenticated()
  @HttpCode(204)
  @ApiOperation({ summary: 'Change the password and end every session' })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description: 'Wrong current password, or a weak or unchanged new password',
  })
  async changePassword(
    @CurrentUserId() userId: string,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    await this.service.changePassword(userId, dto, metaOf(req));
  }

  @Get('me')
  @Authenticated()
  @ApiOperation({ summary: 'The current user' })
  @ApiOkResponse({ type: UserDto })
  me(@CurrentUserId() userId: string) {
    return this.service.me(userId);
  }
}
