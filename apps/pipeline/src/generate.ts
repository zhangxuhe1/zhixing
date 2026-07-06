import { databaseUrl } from "./env.js";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createPrisma, type Card, type CardBlock, type PrismaClient } from "@zhixing/db";
import { createLlm, type LlmClient } from "./llm.js";
import { buildCardPrompt, buildResearchPrompt, CATEGORY_LABELS, type Category } from "./prompts.js";
import { cardDraftSchema, type CardDraft } from "./schema.js";

async function writeCard(
  llm: LlmClient,
  opts: Parameters<typeof buildCardPrompt>[0],
): Promise<CardDraft> {
  const raw = await llm.generateJson(buildCardPrompt(opts));
  const parsed = cardDraftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`structured output 校验失败: ${parsed.error.message}\n原始输出: ${JSON.stringify(raw).slice(0, 500)}`);
  }
  return parsed.data;
}

export async function saveDraft(
  prisma: PrismaClient,
  placeId: string,
  category: Category,
  draft: CardDraft,
): Promise<Card & { blocks: CardBlock[] }> {
  return prisma.card.create({
    data: {
      placeId,
      category,
      title: draft.title,
      status: "AI_GENERATED",
      sources: draft.sources,
      blocks: {
        create: draft.blocks.map((b, i) => ({ order: i, type: "TEXT", text: b.content })),
      },
    },
    include: { blocks: { orderBy: { order: "asc" } } },
  });
}

async function main() {
  // pnpm run 会把 "--" 透传进来，剥掉它避免 parseArgs 把后续参数当 positional
  const rawArgs = process.argv.slice(2);
  const { values } = parseArgs({
    args: rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs,
    options: {
      place: { type: "string" },
      category: { type: "string" },
      count: { type: "string", default: "1" },
      "no-web-search": { type: "boolean", default: false },
    },
  });
  const categories = Object.keys(CATEGORY_LABELS) as Category[];
  if (!values.place || !values.category || !categories.includes(values.category as Category)) {
    console.error(
      `用法: pnpm --filter @zhixing/pipeline generate -- --place <地点名> --category <${categories.join("|")}> [--count N] [--no-web-search]`,
    );
    process.exit(1);
  }
  const category = values.category as Category;
  const count = Number(values.count);

  const prisma = createPrisma(databaseUrl);
  const llm = createLlm(); // GEMINI_API_KEY / DEEPSEEK_API_KEY，ZHIXING_LLM_PROVIDER 可显式指定
  const skipSearch = values["no-web-search"] || !llm.canWebSearch;
  if (!values["no-web-search"] && !llm.canWebSearch) {
    console.log(`(${llm.provider} 不支持联网检索，跳过研究步骤，直接依据模型知识成稿)`);
  }
  try {
    const place = await prisma.place.findFirst({
      where: { name: values.place },
      include: { parent: true },
    });
    if (!place) throw new Error(`地点不存在: ${values.place}（先运行 import-places 或在后台创建）`);
    const cityName = place.parent?.name ?? place.name;

    for (let i = 0; i < count; i++) {
      const existing = await prisma.card.findMany({
        where: { placeId: place.id, status: { not: "RETIRED" } },
        select: { title: true },
      });
      const existingTitles = existing.map((c) => c.title);

      const notes = skipSearch
        ? null
        : await llm.research(buildResearchPrompt(place.name, cityName, category));
      const draft = await writeCard(llm, {
        placeName: place.name,
        cityName,
        category,
        notes,
        existingTitles,
      });
      const card = await saveDraft(prisma, place.id, category, draft);
      console.log(`✓ [${CATEGORY_LABELS[category]}] ${card.title} (${card.id})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
