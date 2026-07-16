BEGIN;

-- DropForeignKey
ALTER TABLE "Place" DROP CONSTRAINT "Place_createdById_fkey";

-- DropIndex
DROP INDEX "Place_status_idx";

-- AlterTable
ALTER TABLE "Place"
DROP COLUMN "createdById",
DROP COLUMN "status";

-- DropEnum
DROP TYPE "PlaceStatus";

COMMIT;
