/**
 * 固定 +08:00（中国标准时，无夏令时）日历分桶。
 * 所有"按日历日/季/月"的派生（去重日 key、gap 聚类、季节标签、标题年月）唯一入口，
 * 禁止在别处直接读 UTC 字段做日历判断。
 *
 * 实现：给 UTC 毫秒加 8 小时偏移后再读 UTC 字段，即得 CST 的年/月/日。
 */
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

export function cstParts(date: Date): { y: number; m: number; d: number } {
  const shifted = new Date(date.getTime() + CST_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

/** CST 日历日 key（YYYY-MM-DD），用于按日粒度去重/比较。 */
export function cstDayKey(date: Date): string {
  const { y, m, d } = cstParts(date);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
