import { expect, test } from "vitest";
import { assertBatchSucceeded, pickJobs } from "../src/batch.js";

const pins = [
  { id: "1", name: "什刹海", cardCount: 1 },
  { id: "2", name: "大栅栏", cardCount: 3 },
  { id: "3", name: "芙蓉街", cardCount: 0 },
];

test("补足到 target，分类轮转，已达标地点跳过", () => {
  const jobs = pickJobs(pins, 3, ["ANECDOTE", "FOOD", "CUSTOMS", "PLACE_NAME", "DIALECT"]);
  expect(jobs.filter((j) => j.placeName === "大栅栏")).toHaveLength(0);
  expect(jobs.filter((j) => j.placeName === "什刹海")).toHaveLength(2);
  expect(jobs.filter((j) => j.placeName === "芙蓉街")).toHaveLength(3);
  // 轮转从当前已有张数起步，避免每次都从同一分类开始
  expect(jobs.filter((j) => j.placeName === "芙蓉街").map((j) => j.category)).toEqual([
    "ANECDOTE", "FOOD", "CUSTOMS",
  ]);
  expect(jobs.filter((j) => j.placeName === "什刹海").map((j) => j.category)).toEqual([
    "FOOD", "CUSTOMS",
  ]);
});

test("任一任务失败时让 batch 以失败状态结束", () => {
  expect(() => assertBatchSucceeded(0)).not.toThrow();
  expect(() => assertBatchSucceeded(2)).toThrow("批量生成存在 2 个失败任务");
});
