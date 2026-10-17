-- At most one unpaid order per user: stops stock hoarding through repeated checkouts
CREATE UNIQUE INDEX "orders_one_open_per_user" ON "orders" ("user_id") WHERE "status" = 'PENDING_PAYMENT';
