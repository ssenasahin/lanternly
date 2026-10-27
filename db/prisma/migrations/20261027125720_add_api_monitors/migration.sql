-- CreateEnum
CREATE TYPE "HttpMethod" AS ENUM ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD');

-- CreateEnum
CREATE TYPE "BodyType" AS ENUM ('NONE', 'JSON', 'FORM');

-- CreateEnum
CREATE TYPE "AssertionOperator" AS ENUM ('EQUALS', 'NOT_EQUALS', 'CONTAINS', 'GREATER_THAN', 'LESS_THAN', 'EXISTS', 'NOT_EXISTS');

-- AlterEnum
ALTER TYPE "MonitorType" ADD VALUE 'API';

-- AlterTable
ALTER TABLE "check_results" ADD COLUMN     "rules" JSONB;

-- AlterTable
ALTER TABLE "monitors" ADD COLUMN     "slow_after_ms" INTEGER;

-- CreateTable
CREATE TABLE "api_requests" (
    "monitor_id" UUID NOT NULL,
    "method" "HttpMethod" NOT NULL DEFAULT 'GET',
    "headers" TEXT,
    "body_type" "BodyType" NOT NULL DEFAULT 'NONE',
    "body" TEXT,
    "expected_status" TEXT NOT NULL DEFAULT '200-299',

    CONSTRAINT "api_requests_pkey" PRIMARY KEY ("monitor_id")
);

-- CreateTable
CREATE TABLE "assertions" (
    "id" UUID NOT NULL,
    "monitor_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "operator" "AssertionOperator" NOT NULL,
    "expected_value" TEXT,

    CONSTRAINT "assertions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assertions_monitor_id_position_idx" ON "assertions"("monitor_id", "position");

-- AddForeignKey
ALTER TABLE "api_requests" ADD CONSTRAINT "api_requests_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assertions" ADD CONSTRAINT "assertions_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
