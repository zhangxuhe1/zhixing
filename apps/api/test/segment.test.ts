import { expect, test } from "vitest";
import { segmentTrips, type SegmentInput } from "../src/trips/segment.js";

function d(iso: string): Date {
  return new Date(iso);
}

function fp(footprintId: string, date: string, cityKey: string, cityLabel: string): SegmentInput {
  return { footprintId, date: d(date), cityKey, cityLabel };
}

test("常驻排除：北京 10 天日常 + 济南 3 天 → 仅济南组，北京足迹不出现", () => {
  const beijing: SegmentInput[] = Array.from({ length: 10 }, (_, i) =>
    fp(`bj-${i}`, `2024-01-${String(i + 1).padStart(2, "0")}T08:00:00.000Z`, "beijing", "北京"),
  );
  const jinan: SegmentInput[] = [
    fp("jn-1", "2024-05-01T08:00:00.000Z", "jinan", "济南"),
    fp("jn-2", "2024-05-02T08:00:00.000Z", "jinan", "济南"),
    fp("jn-3", "2024-05-03T08:00:00.000Z", "jinan", "济南"),
  ];
  const result = segmentTrips([...beijing, ...jinan]);

  expect(result).toHaveLength(1);
  expect(result[0].footprintIds.sort()).toEqual(["jn-1", "jn-2", "jn-3"]);
  expect(result[0].footprintIds.some((id) => id.startsWith("bj-"))).toBe(false);
  expect(result[0].suggestedTitle).toBe("济南·2024年5月");
});

test("天数不足不判常驻：总去重天数 6（北京 4 + 济南 2）→ 北京也参与成行", () => {
  const beijing: SegmentInput[] = [
    fp("bj-1", "2024-01-01T08:00:00.000Z", "beijing", "北京"),
    fp("bj-2", "2024-01-02T08:00:00.000Z", "beijing", "北京"),
    fp("bj-3", "2024-01-03T08:00:00.000Z", "beijing", "北京"),
    fp("bj-4", "2024-01-04T08:00:00.000Z", "beijing", "北京"),
  ];
  const jinan: SegmentInput[] = [
    fp("jn-1", "2024-05-01T08:00:00.000Z", "jinan", "济南"),
    fp("jn-2", "2024-05-02T08:00:00.000Z", "jinan", "济南"),
  ];
  const result = segmentTrips([...beijing, ...jinan]);

  // total dedup days = 4 + 2 = 6 < 7, so no resident-city exclusion.
  // Two separate date clusters (Jan vs May, gap far > 2) => two groups, both size >= 2.
  expect(result).toHaveLength(2);
  const allIds = result.flatMap((t) => t.footprintIds).sort();
  expect(allIds).toEqual(["bj-1", "bj-2", "bj-3", "bj-4", "jn-1", "jn-2"]);
});

test("gap 边界：5/1、5/3 同组（日历日差=2）", () => {
  const input: SegmentInput[] = [
    fp("a", "2024-05-01T08:00:00.000Z", "jinan", "济南"),
    fp("b", "2024-05-03T08:00:00.000Z", "jinan", "济南"),
  ];
  const result = segmentTrips(input);
  expect(result).toHaveLength(1);
  expect(result[0].footprintIds.sort()).toEqual(["a", "b"]);
});

test("gap 边界：5/1、5/4 断开（日历日差=3）→ 两个孤立单足迹组均被丢弃", () => {
  const input: SegmentInput[] = [
    fp("a", "2024-05-01T08:00:00.000Z", "jinan", "济南"),
    fp("b", "2024-05-04T08:00:00.000Z", "jinan", "济南"),
  ];
  const result = segmentTrips(input);
  expect(result).toEqual([]);
});

test("成行门槛：孤立单足迹组被丢弃", () => {
  const input: SegmentInput[] = [
    fp("a", "2024-05-01T08:00:00.000Z", "jinan", "济南"),
    fp("b", "2024-05-10T08:00:00.000Z", "qingdao", "青岛"),
    fp("c", "2024-05-20T08:00:00.000Z", "jinan", "济南"),
    fp("d", "2024-05-21T08:00:00.000Z", "jinan", "济南"),
  ];
  const result = segmentTrips(input);
  // "a" and "b" are isolated singletons (gap > 2 from neighbors), dropped.
  // "c","d" form a valid 2-footprint group.
  expect(result).toHaveLength(1);
  expect(result[0].footprintIds.sort()).toEqual(["c", "d"]);
});

test("标题 ≤2 城：济南·青岛·2024年5月", () => {
  const input: SegmentInput[] = [
    fp("a", "2024-05-01T08:00:00.000Z", "jinan", "济南"),
    fp("b", "2024-05-02T08:00:00.000Z", "qingdao", "青岛"),
  ];
  const result = segmentTrips(input);
  expect(result).toHaveLength(1);
  expect(result[0].suggestedTitle).toBe("济南·青岛·2024年5月");
});

test("标题 >2 城：4 城 → 济南·青岛等4地·2024年5月", () => {
  const input: SegmentInput[] = [
    fp("a", "2024-05-01T08:00:00.000Z", "jinan", "济南"),
    fp("b", "2024-05-02T08:00:00.000Z", "qingdao", "青岛"),
    fp("c", "2024-05-03T08:00:00.000Z", "weihai", "威海"),
    fp("d", "2024-05-04T08:00:00.000Z", "yantai", "烟台"),
  ];
  const result = segmentTrips(input);
  expect(result).toHaveLength(1);
  expect(result[0].suggestedTitle).toBe("济南·青岛等4地·2024年5月");
});

test("跨月取起始月：5/30–6/2 → ·2024年5月", () => {
  const input: SegmentInput[] = [
    fp("a", "2024-05-30T08:00:00.000Z", "jinan", "济南"),
    fp("b", "2024-06-01T08:00:00.000Z", "jinan", "济南"),
    fp("c", "2024-06-02T08:00:00.000Z", "jinan", "济南"),
  ];
  const result = segmentTrips(input);
  expect(result).toHaveLength(1);
  expect(result[0].suggestedTitle).toBe("济南·2024年5月");
});

test("同日多足迹：去重天数按日计，分组含全部足迹", () => {
  const input: SegmentInput[] = [
    fp("a", "2024-05-01T08:00:00.000Z", "jinan", "济南"),
    fp("b", "2024-05-01T14:00:00.000Z", "jinan", "济南"),
    fp("c", "2024-05-01T20:00:00.000Z", "jinan", "济南"),
    fp("d", "2024-05-02T08:00:00.000Z", "jinan", "济南"),
  ];
  const result = segmentTrips(input);
  expect(result).toHaveLength(1);
  expect(result[0].footprintIds.sort()).toEqual(["a", "b", "c", "d"]);
});

test("输出排序：两段旅行按 startDate 倒序", () => {
  const input: SegmentInput[] = [
    fp("a", "2024-01-01T08:00:00.000Z", "jinan", "济南"),
    fp("b", "2024-01-02T08:00:00.000Z", "jinan", "济南"),
    fp("c", "2024-05-01T08:00:00.000Z", "qingdao", "青岛"),
    fp("d", "2024-05-02T08:00:00.000Z", "qingdao", "青岛"),
  ];
  const result = segmentTrips(input);
  expect(result).toHaveLength(2);
  expect(result[0].suggestedTitle).toBe("青岛·2024年5月");
  expect(result[1].suggestedTitle).toBe("济南·2024年1月");
  expect(result[0].startDate.getTime()).toBeGreaterThan(result[1].startDate.getTime());
});

test("输入为空数组 → 返回 []", () => {
  expect(segmentTrips([])).toEqual([]);
});

test("全体足迹同城且天数 ≥7 → 常驻排除后全部为空 → []", () => {
  const input: SegmentInput[] = Array.from({ length: 8 }, (_, i) =>
    fp(`x-${i}`, `2024-01-${String(i + 1).padStart(2, "0")}T08:00:00.000Z`, "jinan", "济南"),
  );
  const result = segmentTrips(input);
  expect(result).toEqual([]);
});

test("常驻并列打破链：去重天数相同 → 取足迹总数多者为常驻", () => {
  // beijing: 3 distinct days but 5 footprints (same-day repeats); jinan: 3 distinct days, 3 footprints.
  // Plus a third city to push total dedup days >= 7.
  const beijing: SegmentInput[] = [
    fp("bj-1", "2024-01-01T06:00:00.000Z", "beijing", "北京"),
    fp("bj-2", "2024-01-01T12:00:00.000Z", "beijing", "北京"),
    fp("bj-3", "2024-01-02T06:00:00.000Z", "beijing", "北京"),
    fp("bj-4", "2024-01-02T12:00:00.000Z", "beijing", "北京"),
    fp("bj-5", "2024-01-03T06:00:00.000Z", "beijing", "北京"),
  ];
  const jinan: SegmentInput[] = [
    fp("jn-1", "2024-02-01T08:00:00.000Z", "jinan", "济南"),
    fp("jn-2", "2024-02-02T08:00:00.000Z", "jinan", "济南"),
    fp("jn-3", "2024-02-03T08:00:00.000Z", "jinan", "济南"),
  ];
  const qingdao: SegmentInput[] = [
    fp("qd-1", "2024-05-01T08:00:00.000Z", "qingdao", "青岛"),
    fp("qd-2", "2024-05-02T08:00:00.000Z", "qingdao", "青岛"),
  ];
  // total dedup days = 3(beijing) + 3(jinan) + 2(qingdao) = 8 >= 7.
  // beijing and jinan tie on distinct days (3 each); beijing has more footprints (5 > 3) -> beijing is resident.
  const result = segmentTrips([...beijing, ...jinan, ...qingdao]);

  const allIds = result.flatMap((t) => t.footprintIds);
  expect(allIds.some((id) => id.startsWith("bj-"))).toBe(false);
  expect(allIds.sort()).toEqual(["jn-1", "jn-2", "jn-3", "qd-1", "qd-2"]);
});

test("常驻并列打破链：去重天数与足迹总数都相同 → 取 cityKey 字典序小者", () => {
  // "beijing" vs "jinan": both 3 distinct days, 3 footprints each. "beijing" < "jinan" lexicographically.
  const beijing: SegmentInput[] = [
    fp("bj-1", "2024-01-01T08:00:00.000Z", "beijing", "北京"),
    fp("bj-2", "2024-01-02T08:00:00.000Z", "beijing", "北京"),
    fp("bj-3", "2024-01-03T08:00:00.000Z", "beijing", "北京"),
  ];
  const jinan: SegmentInput[] = [
    fp("jn-1", "2024-02-01T08:00:00.000Z", "jinan", "济南"),
    fp("jn-2", "2024-02-02T08:00:00.000Z", "jinan", "济南"),
    fp("jn-3", "2024-02-03T08:00:00.000Z", "jinan", "济南"),
  ];
  const qingdao: SegmentInput[] = [
    fp("qd-1", "2024-05-01T08:00:00.000Z", "qingdao", "青岛"),
    fp("qd-2", "2024-05-02T08:00:00.000Z", "qingdao", "青岛"),
  ];
  // total dedup days = 3 + 3 + 2 = 8 >= 7. beijing < jinan lexicographically -> beijing is resident.
  const result = segmentTrips([...beijing, ...jinan, ...qingdao]);

  const allIds = result.flatMap((t) => t.footprintIds);
  expect(allIds.some((id) => id.startsWith("bj-"))).toBe(false);
  expect(allIds.sort()).toEqual(["jn-1", "jn-2", "jn-3", "qd-1", "qd-2"]);
});

test("标题城市按组内首现顺序去重（重复到访不重复计入标题）", () => {
  const input: SegmentInput[] = [
    fp("a", "2024-05-01T08:00:00.000Z", "qingdao", "青岛"),
    fp("b", "2024-05-02T08:00:00.000Z", "jinan", "济南"),
    fp("c", "2024-05-03T08:00:00.000Z", "qingdao", "青岛"),
  ];
  const result = segmentTrips(input);
  expect(result).toHaveLength(1);
  // first appearance order: qingdao then jinan -> "青岛·济南"
  expect(result[0].suggestedTitle).toBe("青岛·济南·2024年5月");
});

test("startDate/endDate 为组内实际最早/最晚 Date", () => {
  const input: SegmentInput[] = [
    fp("a", "2024-05-03T08:00:00.000Z", "jinan", "济南"),
    fp("b", "2024-05-01T20:00:00.000Z", "jinan", "济南"),
    fp("c", "2024-05-02T05:00:00.000Z", "jinan", "济南"),
  ];
  const result = segmentTrips(input);
  expect(result).toHaveLength(1);
  expect(result[0].startDate).toEqual(d("2024-05-01T20:00:00.000Z"));
  expect(result[0].endDate).toEqual(d("2024-05-03T08:00:00.000Z"));
});

test("CST 日界：22:00Z(=次日06:00 CST) 与其 CST 同日足迹归同一日历日做 gap 聚类与年月标题", () => {
  // 2024-05-31T22:00Z = 2024-06-01 06:00 CST → 该足迹应按 6/1 参与聚类与标题（2024年6月）。
  // 同组配一条 5/31 22:30Z(=6/1 06:30 CST)，两者同为 CST 6/1，日差=0 必同组。
  const input: SegmentInput[] = [
    fp("a", "2024-05-31T22:00:00.000Z", "jinan", "济南"),
    fp("b", "2024-05-31T22:30:00.000Z", "jinan", "济南"),
  ];
  const result = segmentTrips(input);
  expect(result).toHaveLength(1);
  expect(result[0].footprintIds.sort()).toEqual(["a", "b"]);
  // 标题按 CST：起始日 CST 为 2024/6 → 2024年6月（UTC 语义会误判成 5 月）
  expect(result[0].suggestedTitle).toBe("济南·2024年6月");
});

test("M4 ≥7 门槛用全局去重日：4 日历日 × 2 城/日（8 城·日）→ 全局 4<7 不排常驻", () => {
  // 4 个日历日，每天两座城市各一条 → 每城 dedupDays=4，城·日合计 8；
  // 但全局去重日历日 = 4 < 7，不触发常驻排除，两城都应参与成行。
  const input: SegmentInput[] = [
    fp("a1", "2024-05-01T06:00:00.000Z", "jinan", "济南"),
    fp("b1", "2024-05-01T07:00:00.000Z", "qingdao", "青岛"),
    fp("a2", "2024-05-02T06:00:00.000Z", "jinan", "济南"),
    fp("b2", "2024-05-02T07:00:00.000Z", "qingdao", "青岛"),
    fp("a3", "2024-05-03T06:00:00.000Z", "jinan", "济南"),
    fp("b3", "2024-05-03T07:00:00.000Z", "qingdao", "青岛"),
    fp("a4", "2024-05-04T06:00:00.000Z", "jinan", "济南"),
    fp("b4", "2024-05-04T07:00:00.000Z", "qingdao", "青岛"),
  ];
  const result = segmentTrips(input);
  const allIds = result.flatMap((t) => t.footprintIds).sort();
  // 无常驻排除：8 条全部在同一连续日历段内成一组。
  expect(allIds).toEqual(["a1", "a2", "a3", "a4", "b1", "b2", "b3", "b4"]);
});
