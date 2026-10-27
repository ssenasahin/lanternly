-- AlterEnum
ALTER TYPE "MonitorType" ADD VALUE 'AGENT';

-- CreateTable
CREATE TABLE "agents" (
    "monitor_id" UUID NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "hostname" TEXT,
    "platform" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("monitor_id")
);

-- CreateTable
CREATE TABLE "agent_metrics" (
    "id" BIGSERIAL NOT NULL,
    "agent_id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "cpu" DOUBLE PRECISION NOT NULL,
    "memory" DOUBLE PRECISION NOT NULL,
    "disk" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "agent_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_key_hash_key" ON "agents"("key_hash");

-- CreateIndex
CREATE INDEX "agent_metrics_agent_id_at_idx" ON "agent_metrics"("agent_id", "at");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_metrics" ADD CONSTRAINT "agent_metrics_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("monitor_id") ON DELETE CASCADE ON UPDATE CASCADE;
