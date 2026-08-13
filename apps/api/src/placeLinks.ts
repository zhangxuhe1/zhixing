import { Prisma } from "@zhixing/db";

// 公开详情与管理端共用的稳定排序:sortOrder 相同(默认 0)时按创建先后,
// createdAt 精度内撞车再按 id 兜底——两侧接口顺序永远一致,不随读取入口漂移。
export const PLACE_LINK_ORDER_BY: Prisma.PlaceLinkOrderByWithRelationInput[] = [
  { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" },
];

// 管理端外链 DTO 白名单:标签以 { id, name } 对象下发(编辑需要 id);
// 公开面不用本 select,由 places.ts 逐字段组装并把 tag 投影成纯名字。
export const LINK_SELECT = {
  id: true, platform: true, title: true, url: true, sortOrder: true,
  tag: { select: { id: true, name: true } },
} satisfies Prisma.PlaceLinkSelect;
