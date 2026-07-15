-- CreateEnum
CREATE TYPE "LinkPlatform" AS ENUM ('XIAOHONGSHU', 'BILIBILI', 'DOUYIN', 'WEIBO', 'OTHER');

-- CreateTable
CREATE TABLE "PlaceLink" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "platform" "LinkPlatform" NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaceLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlaceLink_placeId_idx" ON "PlaceLink"("placeId");

-- AddForeignKey
ALTER TABLE "PlaceLink" ADD CONSTRAINT "PlaceLink_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;
