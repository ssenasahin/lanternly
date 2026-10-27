-- CreateEnum
CREATE TYPE "PingKind" AS ENUM ('SUCCESS', 'START', 'FAIL');

-- AlterEnum
ALTER TYPE "MonitorType" ADD VALUE 'HEARTBEAT';

-- CreateTable
CREATE TABLE "heartbeats" (
    "monitor_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "period_sec" INTEGER,
    "cron" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "grace_sec" INTEGER NOT NULL,
    "last_ping_at" TIMESTAMP(3),
    "last_start_at" TIMESTAMP(3),

    CONSTRAINT "heartbeats_pkey" PRIMARY KEY ("monitor_id")
);

-- CreateTable
CREATE TABLE "heartbeat_pings" (
    "id" BIGSERIAL NOT NULL,
    "monitor_id" UUID NOT NULL,
    "kind" "PingKind" NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER,
    "ip" TEXT,
    "user_agent" TEXT,
    "body" TEXT,

    CONSTRAINT "heartbeat_pings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "heartbeats_token_key" ON "heartbeats"("token");

-- CreateIndex
CREATE INDEX "heartbeat_pings_monitor_id_received_at_idx" ON "heartbeat_pings"("monitor_id", "received_at");

-- AddForeignKey
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heartbeat_pings" ADD CONSTRAINT "heartbeat_pings_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "heartbeats"("monitor_id") ON DELETE CASCADE ON UPDATE CASCADE;
