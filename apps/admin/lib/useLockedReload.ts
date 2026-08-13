"use client";
import { useCallback, useState } from "react";

// 页面级写锁 + 「快照失效」告警的唯一实现，三个外链管理页共用（spec「写操作竞态防线」的不变量）：
//
// - 不变量：初始加载后，整页 GET 只允许发生在写锁（syncing）内——锁内发不出新写，陈旧快照无从
//   覆盖别行新值。写锁用引用计数持有：并发触发多次回拉时，最后一个结束（finally）才解锁——先完成
//   者不得提前放行新写，否则仍在途的旧 GET 可能覆盖锁外新写。
// - staleError 与页面各自的普通写入错误（error）是两个独立状态：只有回拉失败会设置它（DB 可能已变，
//   旧快照不再可信，必须持续可见），只有一次成功的整页回拉才会清除它。本 hook 不暴露它的 setter——
//   写操作成功后清空自己的 error 时，物理上碰不到这条告警，不会出现「A 行回拉失败的告警被 B 行
//   随后完成的成功写入静默清掉」的交错。
export function useLockedReload(load: () => Promise<void>) {
  const [syncCount, setSyncCount] = useState(0);
  const [staleError, setStaleError] = useState("");

  const reloadLocked = useCallback(async () => {
    setSyncCount((n) => n + 1);
    try {
      await load();
      setStaleError(""); // 拿到完整新快照，页面重新可信
    } catch (e) {
      setStaleError(String(e)); // 回拉失败后解锁，页面停留在旧快照，告警常驻直到下次回拉成功
    } finally {
      setSyncCount((n) => n - 1);
    }
  }, [load]);

  return { syncing: syncCount > 0, staleError, reloadLocked };
}
