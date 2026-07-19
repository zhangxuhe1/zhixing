import type { PrismaClient } from "@zhixing/db";

/**
 * 展开 rootId 整棵子树（含自身）的地点 id 列表。一次全量取 (id, parentId) 建
 * 邻接表后向下 BFS——树深 ≤4、千行量级毫秒级；visited 防脏数据成环。
 * rootId 不存在时退化为 [rootId]（上游 IN 查询自然得空集）。
 */
export async function placeSubtreeIds(
  prisma: PrismaClient,
  rootId: string,
): Promise<string[]> {
  const rows = await prisma.place.findMany({ select: { id: true, parentId: true } });
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parentId == null) continue;
    const list = children.get(r.parentId);
    if (list) list.push(r.id);
    else children.set(r.parentId, [r.id]);
  }
  const visited = new Set<string>([rootId]);
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      queue.push(child);
    }
  }
  return queue;
}
