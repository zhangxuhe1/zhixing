import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

// 拦截全部 API 调用为可手动结算的 Promise:测试按需控制每个请求的完成顺序,复现真实交错时序
const mock = vi.hoisted(() => {
  type Pending = {
    method: string;
    path: string;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };
  const pending: Pending[] = [];
  return {
    pending,
    take(method: string, path: string): Pending {
      const i = pending.findIndex((p) => p.method === method && p.path === path);
      if (i < 0) throw new Error(`没有在途请求: ${method} ${path}`);
      return pending.splice(i, 1)[0];
    },
  };
});
vi.mock("@/lib/api", () => ({
  api: (path: string, init?: { method?: string }) =>
    new Promise((resolve, reject) => {
      mock.pending.push({ method: init?.method ?? "GET", path, resolve, reject });
    }),
}));

import LinksPage from "@/app/links/page";

const row = (id: string) => ({
  id, platform: "OTHER", title: `标题${id}`, url: `https://example.com/${id}`,
  sortOrder: 0, tag: null, place: { id: "p1", path: "北京" },
});
const TAGS = [{ id: "T", name: "实用攻略", sortOrder: 0, linkCount: 0 }];
const STALE = /请刷新页面/;

// 回归:A 行写失败且回拉也失败后,「快照失效」告警不能被随后完成的 B 行成功写入静默清掉;
// 告警只随下一次成功的整页回拉消失(spec「写操作竞态防线」的不变量)
it("回拉失败告警不被交错完成的成功写入清除,仅整页回拉成功后消失", async () => {
  render(<LinksPage />);
  await act(async () => {
    mock.take("GET", "/admin/links").resolve({ items: [row("A"), row("B")] });
    mock.take("GET", "/admin/link-tags").resolve(TAGS);
  });

  // A、B 两行先后发起打标:行级互斥只锁本行,B 在页面写锁生效前已在途
  const [selectA, selectB] = screen.getAllByRole("combobox") as HTMLSelectElement[];
  fireEvent.change(selectA, { target: { value: "T" } });
  fireEvent.change(selectB, { target: { value: "T" } });

  // A 写失败 → 触发写锁内回拉;回拉也失败 → 快照失效告警出现
  await act(async () => {
    mock.take("PATCH", "/admin/links/A").reject(new Error("A 写入失败"));
  });
  await act(async () => {
    mock.take("GET", "/admin/links").reject(new Error("回拉不可用"));
    mock.take("GET", "/admin/link-tags").resolve(TAGS); // Promise.all 已拒绝,成员由 all 消费不悬挂
  });
  screen.getByText(STALE);

  // 在途的 B 随后成功:清掉的只是普通写入错误,告警必须仍然可见(修复前此处被 setError("") 抹掉)
  await act(async () => {
    mock.take("PATCH", "/admin/links/B").resolve({ id: "B", tag: { id: "T", name: "实用攻略" } });
  });
  screen.getByText(STALE);
  expect(selectB.value).toBe("T");
  expect(screen.queryByText(/A 写入失败/)).toBeNull();

  // 再次写失败但这次回拉成功:拿到完整新快照,告警消失;本次写入错误照常可见
  fireEvent.change(selectA, { target: { value: "T" } });
  await act(async () => {
    mock.take("PATCH", "/admin/links/A").reject(new Error("A 再次写入失败"));
  });
  await act(async () => {
    mock.take("GET", "/admin/links").resolve({
      items: [row("A"), { ...row("B"), tag: { id: "T", name: "实用攻略" } }],
    });
    mock.take("GET", "/admin/link-tags").resolve(TAGS);
  });
  expect(screen.queryByText(STALE)).toBeNull();
  screen.getByText(/A 再次写入失败/);
});
