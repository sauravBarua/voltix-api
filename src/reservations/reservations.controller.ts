import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ExpireResultDto, ListReservationsDto, ReservationListDto } from './reservations.dto';
import { ReservationsService } from './reservations.service';

@ApiTags('Reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly service: ReservationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List reservations, newest first (admin / inventory operator from Phase 13)',
  })
  @ApiOkResponse({ type: ReservationListDto })
  @ApiBadRequestResponse({ description: 'Invalid filter' })
  list(@Query() query: ListReservationsDto) {
    return this.service.list(query);
  }

  @Post('expire-due')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Expire all due reservations now (admin; the scheduled job takes over in Phase 15)',
  })
  @ApiOkResponse({ type: ExpireResultDto })
  expireDue() {
    return this.service.expireDue();
  }
}
