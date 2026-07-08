import { cstDayKey, cstParts } from "../time.js";

export type SegmentInput = {
  footprintId: string;
  date: Date;
  cityKey: string;
  cityLabel: string;
};

export type TripSuggestion = {
  footprintIds: string[];
  suggestedTitle: string;
  startDate: Date;
  endDate: Date;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 由 CST 日期字符串计算相对天数序号，用于计算日历日差。 */
function dayOrdinal(dayKey: string): number {
  return Date.UTC(
    Number(dayKey.slice(0, 4)),
    Number(dayKey.slice(5, 7)) - 1,
    Number(dayKey.slice(8, 10)),
  ) / MS_PER_DAY;
}

export function segmentTrips(footprints: SegmentInput[]): TripSuggestion[] {
  if (footprints.length === 0) return [];

  // 1. 常驻城市判定：按 cityKey 分组，统计去重日期天数与足迹总数。
  const byCity = new Map<string, SegmentInput[]>();
  for (const fp of footprints) {
    const list = byCity.get(fp.cityKey);
    if (list) list.push(fp);
    else byCity.set(fp.cityKey, [fp]);
  }

  type CityStat = { cityKey: string; dedupDays: number; total: number };
  const cityStats: CityStat[] = [];
  for (const [cityKey, list] of byCity) {
    const days = new Set(list.map((fp) => cstDayKey(fp.date)));
    cityStats.push({ cityKey, dedupDays: days.size, total: list.length });
  }

  // ≥7 门槛用"足迹总天数"= 全局去重日历日（一天多城不重复计），
  // 与 spec 一致；per-city dedupDays 仅用于挑选常驻城市。
  const globalDays = new Set(footprints.map((fp) => cstDayKey(fp.date)));
  const totalDedupDays = globalDays.size;

  let working = footprints;
  if (totalDedupDays >= 7) {
    cityStats.sort((a, b) => {
      if (a.dedupDays !== b.dedupDays) return b.dedupDays - a.dedupDays;
      if (a.total !== b.total) return b.total - a.total;
      return a.cityKey < b.cityKey ? -1 : a.cityKey > b.cityKey ? 1 : 0;
    });
    const residentCityKey = cityStats[0].cityKey;
    working = footprints.filter((fp) => fp.cityKey !== residentCityKey);
  }

  if (working.length === 0) return [];

  // 2. 按 date 升序排序后，按日历日差 <= 2 分组。
  const sorted = [...working].sort((a, b) => a.date.getTime() - b.date.getTime());

  const groups: SegmentInput[][] = [];
  let current: SegmentInput[] = [sorted[0]];
  let currentDayOrdinal = dayOrdinal(cstDayKey(sorted[0].date));

  for (let i = 1; i < sorted.length; i++) {
    const fp = sorted[i];
    const ord = dayOrdinal(cstDayKey(fp.date));
    if (ord - currentDayOrdinal <= 2) {
      current.push(fp);
    } else {
      groups.push(current);
      current = [fp];
    }
    currentDayOrdinal = ord;
  }
  groups.push(current);

  // 3. 组内足迹数 >= 2 才输出。
  const trips: TripSuggestion[] = [];
  for (const group of groups) {
    if (group.length < 2) continue;

    let startDate = group[0].date;
    let endDate = group[0].date;
    for (const fp of group) {
      if (fp.date.getTime() < startDate.getTime()) startDate = fp.date;
      if (fp.date.getTime() > endDate.getTime()) endDate = fp.date;
    }

    // 4. 标题：城市按组内首现顺序去重。
    const seenCities: string[] = [];
    const seen = new Set<string>();
    for (const fp of group) {
      if (!seen.has(fp.cityKey)) {
        seen.add(fp.cityKey);
        seenCities.push(fp.cityLabel);
      }
    }

    let cityPart: string;
    if (seenCities.length <= 2) {
      cityPart = seenCities.join("·");
    } else {
      cityPart = `${seenCities.slice(0, 2).join("·")}等${seenCities.length}地`;
    }

    const { y: year, m: month } = cstParts(startDate);
    const suggestedTitle = `${cityPart}·${year}年${month}月`;

    trips.push({
      footprintIds: group.map((fp) => fp.footprintId),
      suggestedTitle,
      startDate,
      endDate,
    });
  }

  // 5. 输出按 startDate 倒序。
  trips.sort((a, b) => b.startDate.getTime() - a.startDate.getTime());

  return trips;
}
