import { describe, expect, it } from "bun:test";
import type { ProviderUsage, UsageReport, UsageWindow } from "../../shared/protocol.ts";
import { accountLabel, checkedAgo, OLD_AFTER_MS, paneUsageSummary, paneUsageView, shouldFetchPaneUsage, staleText, stripProvider, type PaneUsageInput, type PaneUsageView } from "./paneUsage.ts";

// synthetic sign-ins only: no real account, no real report
const NOW = Date.parse("2026-10-12T12:00:00Z");
const at = (hours: number): string => new Date(NOW + hours * 3_600_000).toISOString();
const session = (used: number, hours = 5, resetIn = 2.4): UsageWindow => ({ kind: "session", scope: null, used_percent: used, resets_at: at(resetIn), starts_at: at(resetIn - hours) });
const week = (used: number, resetIn = 78): UsageWindow => ({ kind: "week", scope: null, used_percent: used, resets_at: at(resetIn), starts_at: at(resetIn - 168) });
const account = (id: ProviderUsage["id"], name: string | null, windows: UsageWindow[], extra: Partial<ProviderUsage> = {}): ProviderUsage => ({
  id, key: `${id}:${name ?? "file"}`, account: name, plan: null, windows, problem: null, checked_at: at(0), ...extra,
});
const report = (...providers: ProviderUsage[]): UsageReport => ({ providers });

const input = (over: Partial<PaneUsageInput>): PaneUsageInput => ({
  enabled: true, machineId: "local", agent: "claude", report: null, fetchFailed: false,
  order: [], hidden: [], count: "left", selectedKey: null, now: NOW, ...over,
});
const ready = (view: PaneUsageView) => {
  if (view.state !== "ready") throw new Error(`expected ready, got ${view.state}`);
  return view;
};

describe("which agent reads which plan", () => {
  it("names a provider by the agent id only, never by a model name", () => {
    expect(stripProvider("claude")).toBe("claude");
    expect(stripProvider("codex")).toBe("codex");
    expect(stripProvider("agy")).toBe("antigravity");
    // these can run any provider's model (GLM, a local one): no plan is guessed for them
    for (const agent of ["pi", "opencode", "omo", "claude-opus-5-5", "glm-5.3", null, undefined, ""]) expect(stripProvider(agent)).toBeNull();
  });

  it("asks only once chosen, only for this server's own panes, only for a known agent", () => {
    expect(shouldFetchPaneUsage(false, "local", "claude")).toBe(false);
    expect(shouldFetchPaneUsage(true, "local", "claude")).toBe(true);
    expect(shouldFetchPaneUsage(true, "studio", "claude")).toBe(false);
    expect(shouldFetchPaneUsage(true, "local", "pi")).toBe(false);
    expect(shouldFetchPaneUsage(true, "local", null)).toBe(false);
  });
});

describe("pane usage states", () => {
  it("offers an explicit opt-in while off, and nothing for a shell or a remote pane", () => {
    expect(paneUsageView(input({ enabled: false }))).toEqual({ state: "opt-in", provider: "claude" });
    expect(paneUsageView(input({ enabled: false, agent: null }))).toEqual({ state: "none" });
    expect(paneUsageView(input({ enabled: false, machineId: "studio" }))).toEqual({ state: "none" });
    expect(paneUsageView(input({ enabled: false, agent: "pi" }))).toEqual({ state: "none" });
  });

  it("never gives a remote PC's pane this server's numbers", () => {
    const view = paneUsageView(input({ machineId: "studio", report: report(account("claude", "a@example.test", [session(10), week(20)])) }));
    expect(view).toEqual({ state: "remote", provider: "claude" });
    expect(paneUsageSummary(view)).toBe("Remote usage not available yet");
  });

  it("says unsupported for an agent with no plan of its own", () => {
    const view = paneUsageView(input({ agent: "opencode", report: report(account("opencode", null, [week(10)])) }));
    expect(view).toEqual({ state: "unsupported", agent: "opencode" });
  });

  it("tells loading, an unanswered first read, a missing sign-in and hidden accounts apart", () => {
    expect(paneUsageView(input({})).state).toBe("loading");
    expect(paneUsageView(input({ fetchFailed: true })).state).toBe("offline");
    const missing = paneUsageView(input({ report: report(account("codex", "c@example.test", [week(10)])) }));
    expect(missing).toEqual({ state: "missing", provider: "claude" });
    expect(paneUsageSummary(missing)).toBe("No Claude sign-in on this server");
    const claude = account("claude", "a@example.test", [session(10)]);
    expect(paneUsageView(input({ report: report(claude), hidden: [claude.key] }))).toEqual({ state: "hidden", provider: "claude" });
  });

  it("shows the 5-hour window and the week as what is left, with resets", () => {
    const view = ready(paneUsageView(input({ report: report(account("claude", "a@example.test", [week(61), { ...week(12), scope: "Sonnet" }, session(38)])) })));
    expect(view.selected.windows.map((window) => [window.kind, window.label, window.text, window.resetIn])).toEqual([
      ["session", "5h", "62% left", "2h 24m"],
      ["week", "Weekly", "39% left", "3d 6h"],
    ]);
    expect(view.selected.stale).toBeNull();
    expect(paneUsageSummary(view)).toBe("Claude, 5h 62% left (Resets in 2h 24m), Weekly 39% left (Resets in 3d 6h)");
  });

  it("counts what is used when Settings says so, and marks a limit near its end", () => {
    const view = ready(paneUsageView(input({ count: "used", report: report(account("claude", null, [session(85), week(40)])) })));
    expect(view.selected.windows.map((window) => [window.text, window.high])).toEqual([["85% used", true], ["40% used", false]]);
  });

  it("names a short window by its real length", () => {
    const view = ready(paneUsageView(input({ report: report(account("claude", null, [session(10, 3)])) })));
    expect(view.selected.windows[0]!.label).toBe("3h");
    const unknown = ready(paneUsageView(input({ report: report(account("claude", null, [{ ...session(10), starts_at: null }])) })));
    expect(unknown.selected.windows[0]!.label).toBe("Session");
  });

  it("draws Codex's week alone when it has no short window, never a 0% or 100% for it", () => {
    const view = ready(paneUsageView(input({ agent: "codex", report: report(account("codex", "c@example.test", [week(84)])) })));
    expect(view.selected.windows.map((window) => window.kind)).toEqual(["week"]);
    expect(view.selected.windows[0]!.text).toBe("16% left");
  });

  it("says no data, not a percentage, when the provider reports no limit", () => {
    const view = ready(paneUsageView(input({ report: report(account("claude", null, [])) })));
    expect(view.selected.windows).toEqual([]);
    expect(paneUsageSummary(view)).toBe("Claude, No data");
    expect(paneUsageSummary(view)).not.toMatch(/\d+%/);
  });

  it("marks an expired sign-in, keeping its last numbers as old", () => {
    const expired = ready(paneUsageView(input({ report: report(account("claude", null, [week(30)], { problem: "expired" })) })));
    expect(expired.selected.stale).toBe("expired");
    expect(paneUsageSummary(expired)).toBe("Claude, Weekly 70% left (Resets in 3d 6h), Sign-in expired");
    const never = ready(paneUsageView(input({ report: report(account("claude", null, [], { problem: "expired", checked_at: null })) })));
    expect(never.selected.windows).toEqual([]);
    expect(checkedAgo(never.selected.checkedAt, NOW)).toBeNull();
  });

  it("marks numbers a 429 kept, a failed read and an offline client as old, never fresh", () => {
    const limited = ready(paneUsageView(input({ report: report(account("claude", null, [week(30)], { problem: "rate_limited", checked_at: at(-0.5) })) })));
    expect(limited.selected.stale).toBe("rate_limited");
    expect(staleText(limited.selected.stale)).toBe("Rate limited · old data");
    expect(checkedAgo(limited.selected.checkedAt, NOW)).toBe("30m ago");
    expect(ready(paneUsageView(input({ report: report(account("claude", null, [week(30)], { problem: "failed" })) }))).selected.stale).toBe("failed");
    const offline = ready(paneUsageView(input({ fetchFailed: true, report: report(account("claude", null, [week(30)])) })));
    expect(offline.selected.stale).toBe("offline");
    expect(paneUsageSummary(offline)).toMatch(/Offline · old data$/);
    const old = ready(paneUsageView(input({ report: report(account("claude", null, [week(30)], { checked_at: new Date(NOW - OLD_AFTER_MS - 60_000).toISOString() })) })));
    expect(old.selected.stale).toBe("old");
    // read 5 minutes ago, but the window started over a minute ago: those numbers are the last window's
    const reset = ready(paneUsageView(input({ report: report(account("claude", null, [session(98, 5, -1 / 60)], { checked_at: at(-5 / 60) })) })));
    expect(reset.selected.stale).toBe("old");
    expect(reset.selected.windows[0]!.resetIn).toBeNull();
  });

  it("lists every account of a provider and keeps the one picked, in Settings order", () => {
    const work = account("codex", "work@example.test", [week(84)], { plan: "pro" });
    const home = account("codex", "home@example.test", [week(31)], { plan: "plus" });
    const both = report(work, home, account("claude", "a@example.test", [week(10)]));
    const first = ready(paneUsageView(input({ agent: "codex", report: both, order: [home.key] })));
    expect(first.multiple).toBe(true);
    expect(first.accounts.map((one) => one.key)).toEqual([home.key, work.key]);
    expect(first.selected.key).toBe(home.key);
    expect(accountLabel(first.accounts[1]!, 1)).toBe("work@example.test · pro");
    const picked = ready(paneUsageView(input({ agent: "codex", report: both, order: [home.key], selectedKey: work.key })));
    expect(picked.selected.key).toBe(work.key);
    expect(picked.selected.windows[0]!.text).toBe("16% left");
    // hidden in Settings: the other stands alone, and is not called one of several
    const one = ready(paneUsageView(input({ agent: "codex", report: both, hidden: [home.key] })));
    expect([one.multiple, one.selected.key]).toEqual([false, work.key]);
    expect(accountLabel({ ...one.selected, account: null, plan: null }, 0)).toBe("Account 1");
  });

  it("drops the last provider's numbers when the pane's agent changes", () => {
    const claude = account("claude", "a@example.test", [session(38), week(61)]);
    const codex = account("codex", "c@example.test", [week(84)]);
    const both = report(claude, codex);
    const before = ready(paneUsageView(input({ report: both })));
    expect(before.provider).toBe("claude");
    // the account picked for Claude does not carry over to Codex
    const after = ready(paneUsageView(input({ agent: "codex", report: both, selectedKey: claude.key })));
    expect([after.provider, after.selected.key, after.accounts.length]).toEqual(["codex", codex.key, 1]);
    expect(paneUsageSummary(after)).not.toContain("Claude");
    expect(paneUsageView(input({ agent: "pi", report: both })).state).toBe("unsupported");
  });
});
