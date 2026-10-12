/** 同一 AIH-RUN 控制器的獨立回歸：窗口重置後，快取數字不能被宣稱為新窗口的即時剩餘額度。合成資料、無 API。 */
import { expect, test } from "bun:test";
import { staleReason } from "./paneUsage.ts";
import type { ProviderUsage } from "../../shared/protocol.ts";

test("reset already passed: a cached reading from before reset is old, not current", () => {
  const now = Date.parse("2026-10-12T04:00:00Z");
  const usage: ProviderUsage = {
    id: "claude", key: "claude:synthetic", account: null, plan: "max", problem: null,
    checked_at: "2026-10-12T03:55:00Z",
    windows: [{ kind: "session", scope: null, used_percent: 98,
      starts_at: "2026-10-11T22:59:00Z", resets_at: "2026-10-12T03:59:00Z" }],
  };
  expect(staleReason(usage, false, now)).toBe("old");
});
