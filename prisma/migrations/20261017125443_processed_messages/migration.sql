CREATE TABLE "processed_messages" (
  "id" UUID NOT NULL,
  "consumer" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "processed_messages_consumer_message_id_key" ON "processed_messages"("consumer", "message_id");
CREATE INDEX "processed_messages_processed_at_idx" ON "processed_messages"("processed_at");
