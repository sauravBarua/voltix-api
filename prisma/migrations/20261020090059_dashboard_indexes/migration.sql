-- Sales widgets filter paid orders by paid_at; orders-by-status filters by created_at
CREATE INDEX "orders_paid_at_idx" ON "orders"("paid_at") WHERE "paid_at" IS NOT NULL;
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");
