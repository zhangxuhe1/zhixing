export const CATEGORY_LABELS = {
  CUSTOMS: "习俗",
  FOOD: "吃食",
  DIALECT: "方言",
  ANECDOTE: "掌故",
  PLACE_NAME: "地名由来",
} as const;

export type Category = keyof typeof CATEGORY_LABELS;

// 规格书 §3.3 风物卡写作模板
export const TEMPLATE_RULES = `写作规则（必须全部遵守）：
1. 开头禁止百科腔：不得以"XX是一种""XX位于""XX始建于"这类定义句开头，必须以场景、人物或对话切入。
2. 全文 300–500 字（各文本块合计），可拆 1–3 个自然段落块。
3. 至少包含一个细节锚点：具体的店名、人名、年代、俗语原文或数字。
4. 传说与史实分开：无法确证的内容用"相传""一说"标注，不得把传说写成史实。
5. 方言类卡片：必须给出词条、拼音近似注音、例句和使用场景。
6. 结尾不总结、不升华：禁止"这正是……的体现""如今……依然"式收尾，讲完就停。
7. sources 填写参考来源（书名/志书/文章名；若引用了检索到的网页，写"标题 - 域名"）。`;

export function buildResearchPrompt(placeName: string, cityName: string, category: Category): string {
  return `你在为一个人文地图 App 收集写作素材。目标地点：${cityName}·${placeName}，内容分类：${CATEGORY_LABELS[category]}。

请检索并汇集这个地点在该分类下值得写的素材：具体的店名、人名、年代、俗语、掌故、出处。优先地方志、正规媒体与文化类文章，忽略营销软文。

输出一份条目化的素材笔记：每条素材附一句来源说明（书名/文章标题与域名）。如果检索不到可靠素材，明确说明哪些内容只能依据常识背景。不要成文，只要素材。`;
}

export function buildCardPrompt(opts: {
  placeName: string;
  cityName: string;
  category: Category;
  notes: string | null;
  existingTitles: string[];
}): string {
  const { placeName, cityName, category, notes, existingTitles } = opts;
  const dedupe =
    existingTitles.length > 0
      ? `该地点已有以下卡片，选题与标题不得重复或近似：${existingTitles.join("、")}。`
      : "";
  const material = notes
    ? `以下是检索到的素材笔记，写作时以此为主要依据：\n${notes}`
    : "没有检索素材，仅依据你可靠的知识写作；不确定的内容一律用\"相传\"\"一说\"标注。";

  return `你在为人文地图 App「知行」写一张「风物卡」——关于一个地方风土人情的小故事。

地点：${cityName}·${placeName}
分类：${CATEGORY_LABELS[category]}
${dedupe}

${TEMPLATE_RULES}

${material}

只返回一个 JSON 对象（不要代码块围栏、不要多余文字），格式：
{"title": "2–30 字标题，有钩子，不用书名号", "blocks": [{"type": "text", "content": "段落正文"}], "sources": ["参考来源"]}
其中 blocks 为 1–3 个 text 块（合计 300–500 字），sources 至少 1 条。`;
}
