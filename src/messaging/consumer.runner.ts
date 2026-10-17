import { Injectable, Logger } from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { jitteredTierDelayMs } from './backoff';
import { type EventEnvelope, PoisonMessageError, parseEnvelope } from './envelope';
import { DEFAULT_RETRY_DELAYS_MS, EVENTS_EXCHANGE } from './messaging.constants';
import { type RabbitConnection, RabbitMqService } from './rabbitmq.service';

export interface ConsumerDefinition {
  /** Queue name and idempotency scope. Changing it makes already-processed events look new. */
  name: string;
  routingKeys: string[];
  /** Runs inside the transaction that also records the message as processed. Throw to retry. */
  handle: (event: EventEnvelope, tx: Prisma.TransactionClient) => Promise<void> | void;
  retryDelaysMs?: number[];
  prefetch?: number;
}

/**
 * Topology per consumer:  <name>  <- bound to the events exchange
 *                         <name>.retry.1..N  (TTL queues that dead-letter back into <name>)
 *                         <name>.dlq         (parking lot for messages that keep failing)
 */
@Injectable()
export class ConsumerRunner {
  private readonly logger = new Logger(ConsumerRunner.name);

  constructor(
    private readonly rabbit: RabbitMqService,
    private readonly prisma: PrismaService,
  ) {}

  register(def: ConsumerDefinition): Promise<void> {
    return this.rabbit.registerSetup((connection) => this.start(connection, def));
  }

  private async start(connection: RabbitConnection, def: ConsumerDefinition) {
    const delays = def.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const channel = await connection.createConfirmChannel();
    // A broken channel would leave the consumer silently dead: drop the connection so everything restarts
    channel.on('error', (error: Error) => {
      this.logger.error(`Consumer ${def.name} channel error: ${error.message}`);
      connection.close().catch(() => undefined);
    });

    await this.declare(channel, def, delays);
    await channel.prefetch(def.prefetch ?? 10);
    await channel.consume(
      def.name,
      (msg) => {
        if (!msg) return; // consumer cancelled by the broker
        this.onMessage(channel, def, delays, msg).catch((error: unknown) =>
          this.logger.error(
            `Consumer ${def.name} crashed on a message: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      },
      { noAck: false },
    );
    this.logger.log(`Consumer ${def.name} listening (${def.routingKeys.join(', ')})`);
  }

  private async declare(channel: ConfirmChannel, def: ConsumerDefinition, delays: number[]) {
    await channel.assertQueue(def.name, { durable: true });
    for (const key of def.routingKeys) await channel.bindQueue(def.name, EVENTS_EXCHANGE, key);
    await channel.assertQueue(`${def.name}.dlq`, { durable: true });
    for (const [i, delay] of delays.entries()) {
      await channel.assertQueue(`${def.name}.retry.${i + 1}`, {
        durable: true,
        arguments: {
          'x-message-ttl': delay,
          'x-dead-letter-exchange': '', // default exchange: routes by queue name
          'x-dead-letter-routing-key': def.name,
        },
      });
    }
  }

  private async onMessage(
    channel: ConfirmChannel,
    def: ConsumerDefinition,
    delays: number[],
    msg: ConsumeMessage,
  ) {
    const raw: unknown = msg.properties.headers?.['x-attempt'];
    const attempt = typeof raw === 'number' ? raw : 0; // failed tries so far

    try {
      const event = parseEnvelope(msg.content);
      await this.process(def, event);
      channel.ack(msg);
    } catch (error) {
      await this.fail(channel, def, delays, msg, attempt, error);
    }
  }

  /** Dedupe row + handler work in ONE transaction: a failed handler leaves no "processed" trace. */
  private async process(def: ConsumerDefinition, event: EventEnvelope) {
    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO processed_messages (id, consumer, message_id)
          VALUES (gen_random_uuid(), ${def.name}, ${event.id})
          ON CONFLICT (consumer, message_id) DO NOTHING
          RETURNING id`;
        if (rows.length === 0) {
          this.logger.debug(`Duplicate ${event.id} ignored by ${def.name}`);
          return;
        }
        await def.handle(event, tx);
      },
      { timeout: 30_000 },
    );
  }

  private async fail(
    channel: ConfirmChannel,
    def: ConsumerDefinition,
    delays: number[],
    msg: ConsumeMessage,
    attempt: number,
    error: unknown,
  ) {
    const reason = error instanceof Error ? error.message : String(error);
    const toDlq = error instanceof PoisonMessageError || attempt >= delays.length;
    const headers = {
      ...msg.properties.headers,
      'x-attempt': attempt + 1,
      'x-error': reason.slice(0, 500),
    };
    const id = String(msg.properties.messageId ?? 'unknown');

    try {
      if (toDlq) {
        await this.sendConfirmed(channel, `${def.name}.dlq`, msg, {
          headers: {
            ...headers,
            'x-failed-at': new Date().toISOString(),
            'x-source-queue': def.name,
          },
        });
        this.logger.error(
          `Message ${id} dead-lettered from ${def.name} after ${attempt + 1} attempt(s): ${reason}`,
        );
      } else {
        const delay = jitteredTierDelayMs(delays[attempt]);
        await this.sendConfirmed(channel, `${def.name}.retry.${attempt + 1}`, msg, {
          headers,
          expiration: String(delay),
        });
        this.logger.warn(
          `Message ${id} failed in ${def.name} (try ${attempt + 1}), retrying in ${delay} ms: ${reason}`,
        );
      }
      channel.ack(msg); // only after the copy is safely stored; a crash in between just redelivers (idempotent)
    } catch (sendError) {
      this.logger.error(
        `Could not reroute message ${id}: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
      );
      channel.nack(msg, false, true);
    }
  }

  private sendConfirmed(
    channel: ConfirmChannel,
    queue: string,
    msg: ConsumeMessage,
    options: Options.Publish,
  ) {
    const contentType: unknown = msg.properties.contentType;
    const messageId: unknown = msg.properties.messageId;
    const type: unknown = msg.properties.type;
    return new Promise<void>((resolve, reject) => {
      channel.sendToQueue(
        queue,
        msg.content,
        {
          persistent: true,
          contentType: typeof contentType === 'string' ? contentType : undefined,
          messageId: typeof messageId === 'string' ? messageId : undefined,
          type: typeof type === 'string' ? type : undefined,
          ...options,
        },
        (error) =>
          error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(),
      );
    });
  }
}
