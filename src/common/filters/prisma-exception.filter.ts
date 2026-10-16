import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';

const MAPPED: Record<string, { status: number; message: string }> = {
  P2002: { status: 409, message: 'A record with the same unique value already exists' },
  P2003: {
    status: 409,
    message: 'Operation conflicts with a reference (resource in use or reference missing)',
  },
  P2025: { status: 404, message: 'Record not found' },
};

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const mapped = MAPPED[exception.code];
    if (!mapped) {
      this.logger.error(`Unhandled Prisma error ${exception.code}`, exception.stack);
      res.status(500).json({ statusCode: 500, message: 'Internal server error' });
      return;
    }
    res.status(mapped.status).json({ statusCode: mapped.status, message: mapped.message });
  }
}
