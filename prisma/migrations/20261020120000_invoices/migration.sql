CREATE TABLE "invoices" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "number" TEXT NOT NULL,
  "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoices_order_id_key" ON "invoices"("order_id");
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "invoice_counters" (
  "year" INTEGER NOT NULL,
  "last_seq" INTEGER NOT NULL,
  CONSTRAINT "invoice_counters_pkey" PRIMARY KEY ("year")
);
