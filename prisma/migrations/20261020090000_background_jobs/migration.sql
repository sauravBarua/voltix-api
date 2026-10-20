CREATE TABLE "job_locks" (
  "name" TEXT NOT NULL,
  "locked_until" TIMESTAMPTZ(3) NOT NULL,
  "locked_by" TEXT NOT NULL,
  CONSTRAINT "job_locks_pkey" PRIMARY KEY ("name")
);

CREATE TABLE "job_runs" (
  "id" UUID NOT NULL,
  "job" TEXT NOT NULL,
  "instance" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(3),
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "result" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "job_runs_job_started_at_idx" ON "job_runs"("job", "started_at" DESC);

CREATE TABLE "low_stock_alerts" (
  "variant_id" UUID NOT NULL,
  "alerted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "available" INTEGER NOT NULL,
  CONSTRAINT "low_stock_alerts_pkey" PRIMARY KEY ("variant_id")
);

-- Cleanup scans published outbox rows by age
CREATE INDEX "outbox_events_published_at_idx" ON "outbox_events"("published_at") WHERE "status" = 'PUBLISHED';

-- Audit retention: DELETE is allowed only inside a transaction that sets voltix.audit_purge = on.
-- UPDATE and ordinary DELETE are still refused.
CREATE OR REPLACE FUNCTION forbid_audit_log_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('voltix.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
