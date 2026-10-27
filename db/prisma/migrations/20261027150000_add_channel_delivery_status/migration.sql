-- AlterEnum
BEGIN;
CREATE TYPE "ChannelType_new" AS ENUM ('SLACK', 'TELEGRAM', 'WEBHOOK');
ALTER TABLE "notification_channels" ALTER COLUMN "type" TYPE "ChannelType_new" USING ("type"::text::"ChannelType_new");
ALTER TYPE "ChannelType" RENAME TO "ChannelType_old";
ALTER TYPE "ChannelType_new" RENAME TO "ChannelType";
DROP TYPE "public"."ChannelType_old";
COMMIT;

-- AlterTable
ALTER TABLE "notification_channels" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "last_sent_at" TIMESTAMP(3);

