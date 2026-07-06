import { expect, test } from "vitest";
import { cardDraftSchema } from "../src/schema.js";

const valid = {
  title: "卤煮火烧的出身",
  blocks: [
    {
      type: "text",
      content:
        "天没亮透，南横街的小肠陈门口已经排上了队。大锅里咕嘟着小肠、肺头、炸豆腐，师傅捞起火烧，井字四刀，浇一勺老汤。一说卤煮的祖上是宫廷苏造肉，乾隆年间苏州厨子张东官带进御膳房，后来流入民间，五花肉贵，脚夫吃不起，摊主改用下水，歪打正着成了穷人乐。",
    },
  ],
  sources: ["《北京志·商业卷》"],
};

test("合法草稿通过校验", () => {
  expect(cardDraftSchema.parse(valid)).toEqual(valid);
});

test("空来源 / 空块 / 超长标题被拒绝", () => {
  expect(cardDraftSchema.safeParse({ ...valid, sources: [] }).success).toBe(false);
  expect(cardDraftSchema.safeParse({ ...valid, blocks: [] }).success).toBe(false);
  expect(
    cardDraftSchema.safeParse({ ...valid, title: "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多" }).success,
  ).toBe(false);
});
