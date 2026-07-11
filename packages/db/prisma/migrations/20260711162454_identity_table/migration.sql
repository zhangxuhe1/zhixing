-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('APPLE', 'EMAIL');

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "appleSub" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Identity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Identity_userId_idx" ON "Identity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Identity_provider_subject_key" ON "Identity"("provider", "subject");

-- AddForeignKey
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 回填：为每个既有 User 按其 appleSub 生成一条 APPLE Identity（id 用 gen_random_uuid()，cuid 是应用层默认，库内无此函数，唯一性足矣）
INSERT INTO "Identity" ("id", "userId", "provider", "subject", "createdAt")
SELECT gen_random_uuid()::text, "id", 'APPLE', "appleSub", now() FROM "User";
