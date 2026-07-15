import type { PrismaClient } from "@zhixing/db";

export type PlaceAncestor = { id: string; name: string; level: string };

/**
 * 沿 parentId 链向上收集祖先。返回顺序定死为「从远到近」(省 → 市 → 区)，
 * 客户端 join(" · ") 即得 "山东省 · 济南市"。深度上限 10 防呆(树实际最深 4 层)。
 */
export async function placeAncestors(
  prisma: PrismaClient,
  startParentId: string | null,
): Promise<PlaceAncestor[]> {
  const chain: PlaceAncestor[] = [];
  let cursor = startParentId;
  for (let depth = 0; cursor && depth < 10; depth++) {
    const node = await prisma.place.findUnique({
      where: { id: cursor },
      select: { id: true, name: true, level: true, parentId: true },
    });
    if (!node) break;
    chain.push({ id: node.id, name: node.name, level: node.level });
    cursor = node.parentId;
  }
  return chain.reverse();
}
