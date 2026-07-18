-- AlterTable
ALTER TABLE "FootprintPhoto" ADD COLUMN     "orderIndex" INTEGER NOT NULL DEFAULT 0;

-- 回填：按 footprintId 分组、id asc（≈cuid 插入序）写 0..n-1，保私密侧现状序
UPDATE "FootprintPhoto" p
SET "orderIndex" = t.rn - 1
FROM (
  SELECT id, row_number() OVER (PARTITION BY "footprintId" ORDER BY id) AS rn
  FROM "FootprintPhoto"
) t
WHERE p.id = t.id;
