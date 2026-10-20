import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer } from '@testcontainers/redis';

type Stoppable = { stop: () => Promise<unknown> };
const holder = globalThis as unknown as { __voltixContainers?: Stoppable[] };

/** Throwaway Postgres, Redis and RabbitMQ: migrated, seeded, and wired in through environment variables. */
export default async function globalSetup() {
  const [pg, redis, rabbit] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('voltix')
      .withUsername('voltix')
      .withPassword('voltix')
      .start(),
    new RedisContainer('redis:7-alpine').start(),
    new RabbitMQContainer('rabbitmq:4-management-alpine')
      .withEnvironment({ RABBITMQ_DEFAULT_USER: 'voltix', RABBITMQ_DEFAULT_PASS: 'voltix' })
      .start(),
  ]);
  holder.__voltixContainers = [pg, redis, rabbit];

  // Forced: these must win over whatever .env says
  process.env.DATABASE_URL = `postgresql://voltix:voltix@${pg.getHost()}:${pg.getPort()}/voltix`;
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  process.env.RABBITMQ_URL = `amqp://voltix:voltix@${rabbit.getHost()}:${rabbit.getMappedPort(5672)}`;

  // Defaults for a clean CI machine without a .env (an existing value is kept)
  const defaults: Record<string, string> = {
    JWT_ACCESS_SECRET: 'integration-test-secret-'.padEnd(48, 'x'),
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    CLOUDINARY_CLOUD_NAME: 'dummy',
    CLOUDINARY_API_KEY: 'dummy',
    CLOUDINARY_API_SECRET: 'dummy',
    SEED_PASSWORD: 'Voltix-Dev-1234!',
  };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
  // The isolated run never talks to real Stripe
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';

  execSync('pnpm exec prisma migrate deploy', { stdio: 'inherit', env: process.env });
  execSync('pnpm exec tsx prisma/seed.ts', { stdio: 'inherit', env: process.env });
}
