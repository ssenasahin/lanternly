-- CreateTable
CREATE TABLE "check_rollups" (
    "monitor_id" UUID NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "checks" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL,
    "response_count" INTEGER NOT NULL,
    "response_avg_ms" DOUBLE PRECISION,
    "response_p95_ms" DOUBLE PRECISION,

    CONSTRAINT "check_rollups_pkey" PRIMARY KEY ("monitor_id","hour")
);

-- AddForeignKey
ALTER TABLE "check_rollups" ADD CONSTRAINT "check_rollups_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
