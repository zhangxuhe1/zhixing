-- AlterTable
ALTER TABLE "PlaceLink" ADD COLUMN     "tagId" TEXT;

-- CreateTable
CREATE TABLE "PlaceLinkTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaceLinkTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlaceLinkTag_name_key" ON "PlaceLinkTag"("name");

-- AddForeignKey
ALTER TABLE "PlaceLink" ADD CONSTRAINT "PlaceLink_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "PlaceLinkTag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 存量 URL 首尾空白一次性清洗(无判断的规范化,允许进 migration;业务打标不进)
UPDATE "PlaceLink" SET "url" = btrim("url", E' \t\r\n') WHERE "url" <> btrim("url", E' \t\r\n');
