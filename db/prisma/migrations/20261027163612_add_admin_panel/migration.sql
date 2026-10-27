-- AlterTable
ALTER TABLE "users" ADD COLUMN     "plan_id" UUID,
ADD COLUMN     "suspended_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "max_monitors" INTEGER NOT NULL,
    "max_channels" INTEGER NOT NULL,
    "max_api_keys" INTEGER NOT NULL,
    "min_interval_sec" INTEGER NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "actor_email" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_id" TEXT,
    "target" TEXT,
    "ip" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_name_key" ON "plans"("name");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_id_idx" ON "audit_logs"("target_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one default plan; the API falls back to built-in limits if none exists.
CREATE UNIQUE INDEX "plans_one_default" ON "plans"("is_default") WHERE "is_default";

INSERT INTO "plans" ("id", "name", "max_monitors", "max_channels", "max_api_keys", "min_interval_sec", "is_default")
VALUES
  (gen_random_uuid(), 'Free', 50, 20, 10, 30, true),
  (gen_random_uuid(), 'Team', 200, 50, 25, 30, false);

-- The audit log only grows. The one change allowed is the actor link going null
-- when that account is deleted; the copied email keeps the record readable.
CREATE FUNCTION "audit_logs_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_logs rows cannot be deleted';
  END IF;
  IF (NEW."id", NEW."actor_email", NEW."action", NEW."target_id", NEW."target", NEW."ip", NEW."detail"::text, NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."actor_email", OLD."action", OLD."target_id", OLD."target", OLD."ip", OLD."detail"::text, OLD."created_at")
     OR NEW."actor_id" IS NOT NULL AND NEW."actor_id" IS DISTINCT FROM OLD."actor_id" THEN
    RAISE EXCEPTION 'audit_logs rows cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_append_only"
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION "audit_logs_append_only"();
