import { databaseUrl } from "./env.js";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createPrisma } from "@zhixing/db";
import { generateCards } from "./generate.js";
import { createLlm } from "./llm.js";
import { CATEGORY_LABELS, type Category } from "./prompts.js";

type PinLite = { id: string; name: string; cardCount: number };

export function pickJobs(
  pins: PinLite[],
  target: number,
  categories: Category[],
): Array<{ placeName: string; category: Category }> {
  const jobs: Array<{ placeName: string; category: Category }> = [];
  for (const pin of pins) {
    for (let n = pin.cardCount; n < target; n++) {
      jobs.push({ placeName: pin.name, category: categories[n % categories.length] });
    }
  }
  return jobs;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // pnpm run 会把 "--" 透传进来，剥掉它（同 generate.ts 的处理）
  const rawArgs = process.argv.slice(2);
  const { values } = parseArgs({
    args: rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs,
    options: {
      fill: { type: "string" },
      city: { type: "string" },
      delay: { type: "string", default: "4000" },
      limit: { type: "string" },
      "no-web-search": { type: "boolean", default: false },
    },
  });
  const target = Number(values.fill);
  if (!Number.isInteger(target) || target < 1) {
    console.error("用法: pnpm --filter @zhixing/pipeline batch -- --fill <每地目标卡数> [--city 北京市] [--delay ms] [--limit N] [--no-web-search]");
    process.exit(1);
  }

  const prisma = createPrisma(databaseUrl);
  const llm = createLlm();
  try {
    // 城市本身与其下街区都参与补卡
    const where = values.city
      ? { OR: [{ parent: { name: values.city } }, { name: values.city }] }
      : {};
    const places = await prisma.place.findMany({ where, select: { id: true, name: true } });
    const counts = await prisma.card.groupBy({
      by: ["placeId"], where: { status: { not: "RETIRED" } }, _count: { _all: true },
    });
    const countBy = new Map(counts.map((c) => [c.placeId, c._count._all]));
    const pins: PinLite[] = places.map((p) => ({ id: p.id, name: p.name, cardCount: countBy.get(p.id) ?? 0 }));

    let jobs = pickJobs(pins, target, Object.keys(CATEGORY_LABELS) as Category[]);
    if (values.limit) jobs = jobs.slice(0, Number(values.limit));
    console.log(`计划生成 ${jobs.length} 张卡（target=${target}${values.city ? `，city=${values.city}` : ""}）`);

    let ok = 0, fail = 0;
    for (const job of jobs) {
      try {
        ok += await generateCards(prisma, llm, {
          placeName: job.placeName, category: job.category, count: 1,
          webSearch: !values["no-web-search"],
        });
      } catch (e) {
        fail++;
        console.error(`✗ ${job.placeName}/${job.category}: ${e instanceof Error ? e.message : e}`);
      }
      await sleep(Number(values.delay));
    }
    console.log(`完成：成功 ${ok}，失败 ${fail}`);
  } finally {
    await prisma.$disconnect();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
