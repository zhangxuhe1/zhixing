/**
 * mulberry32：极小的 32 位确定性 PRNG。同一 seed 产生逐字节相同的调用序列，
 * 是整个 seed CLI"不联网、不调 LLM、结果确定"契约的根基——所有随机决策
 * （时间聚类、内容抽取、点赞关系、对象存储 uuid）都必须经由它派生，
 * 禁止在 seed/ 目录下出现 Math.random()/crypto.randomUUID() 等不确定源。
 *
 * 算法来源：https://github.com/cprosche/mulberry32（公有实现，非本项目原创）。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** 下一个 [0,1) 浮点 */
  next(): number;
  /** [min, max] 闭区间整数 */
  int(min: number, max: number): number;
  /** 命中概率为 p（0~1）的布尔 */
  chance(p: number): boolean;
  /** 等概率取数组中一项（数组不可为空） */
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates 洗牌，返回新数组，不改原数组 */
  shuffle<T>(items: readonly T[]): T[];
  /** 派生一个 UUID v4 形状的字符串（不追求 RFC 4122 语义合规，只求形状与足够的碰撞抵抗，供对象键使用） */
  uuid(): string;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);

  const int = (min: number, max: number): number => Math.floor(next() * (max - min + 1)) + min;

  const hex4bit = (): string => int(0, 15).toString(16);
  const hexBlock = (n: number): string => Array.from({ length: n }, hex4bit).join("");

  return {
    next,
    int,
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error("rng.pick: empty array");
      return items[int(0, items.length - 1)];
    },
    shuffle: <T>(items: readonly T[]): T[] => {
      const arr = items.slice();
      for (let i = arr.length - 1; i > 0; i--) {
        const j = int(0, i);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
    uuid: () => {
      const variant = ["8", "9", "a", "b"][int(0, 3)];
      return `${hexBlock(8)}-${hexBlock(4)}-4${hexBlock(3)}-${variant}${hexBlock(3)}-${hexBlock(12)}`;
    },
  };
}
