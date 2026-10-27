-- CreateEnum
CREATE TYPE "DnsRecordType" AS ENUM ('A', 'AAAA', 'CNAME', 'MX', 'TXT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MonitorType" ADD VALUE 'TCP';
ALTER TYPE "MonitorType" ADD VALUE 'DNS';

-- CreateTable
CREATE TABLE "dns_queries" (
    "monitor_id" UUID NOT NULL,
    "record_type" "DnsRecordType" NOT NULL DEFAULT 'A',
    "expected" TEXT,
    "resolver" TEXT,

    CONSTRAINT "dns_queries_pkey" PRIMARY KEY ("monitor_id")
);

-- AddForeignKey
ALTER TABLE "dns_queries" ADD CONSTRAINT "dns_queries_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
