import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';

/**
 * CORS only restricts the polling transport, and it is not the security boundary: the bearer token
 * in the handshake is. (A token in `auth`, not a cookie, means a hostile page has nothing to ride on.)
 */
export class RealtimeAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origin: string,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const merged = {
      ...options,
      cors: { origin: this.origin, credentials: true },
      maxHttpBufferSize: 10_000, // clients send nothing meaningful: refuse big payloads
    } as ServerOptions;
    return super.createIOServer(port, merged) as Server;
  }
}
