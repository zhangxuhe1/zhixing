-- CreateEnum
CREATE TYPE "PlaceLevel" AS ENUM ('PROVINCE', 'CITY', 'DISTRICT', 'POI');

-- CreateEnum
CREATE TYPE "CardCategory" AS ENUM ('CUSTOMS', 'FOOD', 'DIALECT', 'ANECDOTE', 'PLACE_NAME');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('AI_GENERATED', 'REVIEWED', 'RETIRED');

-- CreateEnum
CREATE TYPE "BlockType" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Place" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" "PlaceLevel" NOT NULL,
    "parentId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "intro" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Card" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "category" "CardCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "status" "CardStatus" NOT NULL DEFAULT 'AI_GENERATED',
    "sources" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardBlock" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "type" "BlockType" NOT NULL,
    "text" TEXT,
    "mediaUrl" TEXT,

    CONSTRAINT "CardBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "appleSub" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Footprint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "text" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Footprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FootprintPhoto" (
    "id" TEXT NOT NULL,
    "footprintId" TEXT NOT NULL,
    "mediaUrl" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3),
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,

    CONSTRAINT "FootprintPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchMiss" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "lastAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchMiss_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Place_level_idx" ON "Place"("level");

-- CreateIndex
CREATE UNIQUE INDEX "Place_name_parentId_key" ON "Place"("name", "parentId");

-- CreateIndex
CREATE INDEX "Card_placeId_status_idx" ON "Card"("placeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CardBlock_cardId_order_key" ON "CardBlock"("cardId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "User_appleSub_key" ON "User"("appleSub");

-- CreateIndex
CREATE INDEX "Footprint_placeId_visibility_idx" ON "Footprint"("placeId", "visibility");

-- CreateIndex
CREATE INDEX "Footprint_userId_idx" ON "Footprint"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchMiss_query_key" ON "SearchMiss"("query");

-- AddForeignKey
ALTER TABLE "Place" ADD CONSTRAINT "Place_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Place"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardBlock" ADD CONSTRAINT "CardBlock_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Footprint" ADD CONSTRAINT "Footprint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Footprint" ADD CONSTRAINT "Footprint_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FootprintPhoto" ADD CONSTRAINT "FootprintPhoto_footprintId_fkey" FOREIGN KEY ("footprintId") REFERENCES "Footprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
