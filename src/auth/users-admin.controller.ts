import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { IdParamDto } from '../common/schemas';
import { Roles, SkipAudit } from './access.decorators';
import { UserDto } from './auth.dto';
import type { AuthUser } from './auth.types';
import { CreateUserDto, ListUsersDto, UpdateUserDto, UserListDto } from './users.dto';
import { UsersAdminService } from './users-admin.service';

@ApiTags('Admin users')
@Roles('ADMIN')
@SkipAudit() // the service writes a richer entry (role before and after) in the same transaction
@Controller('admin/users')
export class UsersAdminController {
  constructor(private readonly service: UsersAdminService) {}

  @Get()
  @ApiOperation({ summary: 'List users' })
  @ApiOkResponse({ type: UserListDto })
  list(@Query() query: ListUsersDto) {
    return this.service.list(query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a user with any role (use it to create inventory operators and admins)',
  })
  @ApiCreatedResponse({ type: UserDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse({ description: 'Email already registered' })
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthUser, @Req() req: Request) {
    return this.service.create(dto, actor, req.ip);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a role or deactivate a user (deactivation ends all their sessions)',
  })
  @ApiOkResponse({ type: UserDto })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'Own account, or the last active administrator' })
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
    @Req() req: Request,
  ) {
    return this.service.update(params.id, dto, actor, req.ip);
  }
}
