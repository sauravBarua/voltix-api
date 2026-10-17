import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ConfirmChannel, type ConsumeMessage, connect } from 'amqplib';
import type { Env } from '../config/env';
import { backoffDelayMs } from './backoff';
import { EVENTS_EXCHANGE } from './messaging.constants';

export type RabbitConnection = Awaited<ReturnType<typeof connect>>;
type Setup = (connection: RabbitConnection) => Promise<void>;

const RECONNECT = { baseMs: 1_000, capMs: 30_000 };

/**
 * One connection, reconnected forever with backoff. Consumers register a `setup` that is re-run after
 * every reconnect. `isReady()` turns true only once the exchange and every consumer queue exist, so the
 * outbox publisher never publishes into a topology that is not there yet.
 */
@Injectable()
export class RabbitMqService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqService.name);
  private readonly url: string;
  private readonly setups: Setup[] = [];
  private readonly returned = new Set<string>(); // ids of messages the broker could not route
  private connection: RabbitConnection | null = null;
  private publishChannel: ConfirmChannel | null = null;
  private ready = false;
  private closing = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(config: ConfigService<Env, true>) {
    this.url = config.get('RABBITMQ_URL', { infer: true });
  }

  onModuleInit() {
    this.loop = this.run(); // not awaited: the app starts even if the broker is down
  }

  async onApplicationShutdown() {
    this.closing = true;
    this.wake?.();
    await this.connection?.close().catch(() => undefined);
    await this.loop;
  }

  isReady(): boolean {
    return this.ready;
  }

  async waitUntilReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ready) {
      if (Date.now() > deadline) throw new Error('RabbitMQ did not become ready in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Runs now when already connected, and again after every reconnect. */
  async registerSetup(setup: Setup): Promise<void> {
    this.setups.push(setup);
    if (this.ready && this.connection) await setup(this.connection);
  }

  /** Publishes with a broker confirmation. Rejects if the broker did not confirm or could not route it. */
  async publishEvent(event: {
    messageId: string;
    routingKey: string;
    type: string;
    body: Buffer;
  }): Promise<void> {
    const channel = this.publishChannel;
    if (!channel || !this.ready) throw new Error('RabbitMQ is not connected');

    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EVENTS_EXCHANGE,
        event.routingKey,
        event.body,
        {
          persistent: true,
          mandatory: true, // an unroutable event comes back instead of vanishing
          contentType: 'application/json',
          messageId: event.messageId,
          type: event.type,
          timestamp: Math.floor(Date.now() / 1000),
        },
        (error) =>
          error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(),
      );
    });
    // basic.return arrives before the confirm, so the set is already filled here
    if (this.returned.delete(event.messageId)) {
      throw new Error('Event is unroutable: no queue is bound to its routing key');
    }
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.closing) {
      let connection: RabbitConnection | null = null;
      try {
        connection = await connect(this.url);
        const current = connection;
        const closed = new Promise<void>((resolve) => current.on('close', () => resolve()));
        current.on('error', (error: Error) =>
          this.logger.error(`RabbitMQ connection error: ${error.message}`),
        );
        this.connection = current;

        const channel = await current.createConfirmChannel();
        channel.on('error', (error: Error) =>
          this.logger.error(`RabbitMQ publish channel error: ${error.message}`),
        );
        channel.on('return', (message: ConsumeMessage) => {
          const id: unknown = message.properties.messageId;
          if (typeof id === 'string') this.returned.add(id);
        });
        await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
        this.publishChannel = channel;

        for (const setup of this.setups) await setup(current);
        this.ready = true;
        failures = 0;
        this.logger.log('RabbitMQ connected, topology ready');
        await closed;
        this.logger.warn('RabbitMQ connection closed');
      } catch (error) {
        this.logger.error(
          `RabbitMQ setup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await connection?.close().catch(() => undefined);
      }

      this.ready = false;
      this.publishChannel = null;
      this.connection = null;
      this.returned.clear();
      if (this.closing) break;
      failures += 1;
      await this.sleep(backoffDelayMs(failures, RECONNECT));
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
