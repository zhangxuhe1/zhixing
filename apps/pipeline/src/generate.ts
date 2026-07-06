import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createPrisma, type Card, type CardBlock, type PrismaClient } from "@zhixing/db";
import { buildCardPrompt, buildResearchPrompt, CATEGORY_LABELS, type Category } from "./prompts.js";
import { cardDraftSchema, type CardDraft } from "./schema.js";

const MODEL = process.env.ZHIXING_GEN_MODEL ?? "claude-opus-4-8";

async function research(
  client: Anthropic,
  placeName: string,
  cityName: string,
  category: Category,
): Promise<string> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
    messages: [{ role: "user", content: buildResearchPrompt(placeName, cityName, category) }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function writeCard(
  client: Anthropic,
  opts: Parameters<typeof buildCardPrompt>[0],
): Promise<CardDraft> {
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: zodOutputFormat(cardDraftSchema) },
    messages: [{ role: "user", content: buildCardPrompt(opts) }],
  });
  if (!res.parsed_output) throw new Error(`structured output 解析失败 (stop_reason=${res.stop_reason})`);
  return res.parsed_output;
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
  const { values } = parseArgs({
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

  const prisma = createPrisma(process.env.DATABASE_URL);
  const client = new Anthropic(); // 凭据自动解析：ANTHROPIC_API_KEY 或 ant auth profile
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

      const notes = values["no-web-search"]
        ? null
        : await research(client, place.name, cityName, category);
      const draft = await writeCard(client, {
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
