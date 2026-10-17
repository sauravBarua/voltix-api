import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { bearerToken } from '../auth/access.guard';
import { TokensService } from '../auth/tokens.service';
import type { Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_NAMESPACE } from './realtime.constants';
import { roomsFor } from './realtime.messages';

type SocketData = { userId: string; role: Role; expiresAt: number };

@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer() server?: Namespace;

  constructor(
    private readonly tokens: TokensService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(namespace: Namespace) {
    // Runs before the connection exists: a failure here means the client never connects
    namespace.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (error: unknown) => {
          if (!(error instanceof UnauthorizedException)) {
            this.logger.error(
              `Handshake failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          next(new Error('unauthorized')); // same answer for every cause
        },
      );
    });
  }

  async handleConnection(socket: Socket) {
    const { userId, role, expiresAt } = socket.data as SocketData;
    const rooms = roomsFor(userId, role);
    await socket.join(rooms);
    if (!socket.connected) return; // left while joining

    // The access token lives 15 minutes: end the session when it expires. The client reconnects
    // with a fresh token (the Socket.IO client does NOT reconnect after a server-side disconnect).
    const timer = setTimeout(
      () => {
        socket.emit('auth:expired');
        socket.disconnect(true);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    socket.once('disconnect', () => clearTimeout(timer));

    socket.emit('ready', { rooms });
  }

  private async authenticate(socket: Socket): Promise<void> {
    const fromAuth: unknown = socket.handshake.auth.token;
    const token =
      typeof fromAuth === 'string' ? fromAuth : bearerToken(socket.handshake.headers.authorization);
    if (!token) throw new UnauthorizedException('Missing token');

    const { userId, expiresAt } = await this.tokens.verifyAccessDetailed(token);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, isActive: true },
    });
    if (!user?.isActive) throw new UnauthorizedException('Invalid token');

    const data: SocketData = { userId: user.id, role: user.role, expiresAt };
    socket.data = data;
  }
}
