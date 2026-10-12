import type { ProviderUsage, UsageProblem, UsageProviderId, UsageReport, UsageWindow } from "../../shared/protocol.ts";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import type { UsageCount } from "./settings.ts";
import { t } from "./i18n.ts";
import { formatPercent, formatResetIn, HIGH_PERCENT, meterPercent, orderProviders, PROVIDER_NAME, statusWindows } from "./usage.ts";

/**
 * The plan usage beside a chat pane's composer (PaneUsageStrip). Everything here is a reference
 * read from the sign-in on the PC that runs this UI server: it is never proof of the account the
 * pane bills to, and a remote PC's pane is never given this server's numbers.
 */

/**
 * The agents whose own CLI signs in to exactly one plan this server can read. Matched by the
 * pane's agent id only, never by a model name: pi, OpenCode (any provider, GLM or a local model
 * included) and omo can run on another plan than the one a sign-in here names.
 */
const STRIP_PROVIDER: Readonly<Record<string, UsageProviderId>> = {
  claude: "claude", codex: "codex", cursor: "cursor", copilot: "copilot", grok: "grok", agy: "antigravity",
};

/** numbers read longer ago than this are drawn as old, whatever the server said */
export const OLD_AFTER_MS = 15 * 60_000;

export function stripProvider(agent: string | null | undefined): UsageProviderId | null {
  return agent ? STRIP_PROVIDER[agent] ?? null : null;
}

/** Whether the strip may ask GET /api/usage: only once chosen, only for this server's own panes, only for an agent it can name. */
export function shouldFetchPaneUsage(enabled: boolean, machineId: string, agent: string | null | undefined): boolean {
  return enabled && machineId === LOCAL_MACHINE && stripProvider(agent) !== null;
}

/** Why the numbers shown are not this minute's. */
export type StaleReason = "expired" | "rate_limited" | "failed" | "locked" | "offline" | "old";

export interface PaneUsageWindow {
  kind: "session" | "week";
  /** "5h", or the short window's real length; "Weekly" */
  label: string;
  /** the share shown, per Settings → Meters show */
  percent: number;
  /** "62% left", "38% used" */
  text: string;
  /** "2h 24m" until it starts over; null when unknown */
  resetIn: string | null;
  resetsAt: string | null;
  high: boolean;
}

export interface PaneUsageAccount {
  key: string;
  /** whose sign-in it is as the provider names it; null when it does not say */
  account: string | null;
  plan: string | null;
  problem: UsageProblem | null;
  checkedAt: string | null;
  /** the plan-wide short window and week, in that order; a window the provider does not report is absent, never 0% */
  windows: PaneUsageWindow[];
  stale: StaleReason | null;
}

export type PaneUsageView =
  /** nothing to draw: no agent, or the opt-in has nothing to offer here */
  | { state: "none" }
  /** Settings → Show plan limits is off: one explicit action offers to turn it on, nothing is asked */
  | { state: "opt-in"; provider: UsageProviderId }
  | { state: "remote"; provider: UsageProviderId | null }
  | { state: "unsupported"; agent: string }
  | { state: "loading"; provider: UsageProviderId }
  /** the first read failed: there is nothing to show, not even old numbers */
  | { state: "offline"; provider: UsageProviderId }
  /** the report came and holds no sign-in of this provider */
  | { state: "missing"; provider: UsageProviderId }
  /** every account of this provider is hidden in Settings */
  | { state: "hidden"; provider: UsageProviderId }
  | { state: "ready"; provider: UsageProviderId; accounts: PaneUsageAccount[]; selected: PaneUsageAccount; multiple: boolean };

export interface PaneUsageInput {
  enabled: boolean;
  machineId: string;
  agent: string | null | undefined;
  report: UsageReport | null;
  /** the last GET /api/usage failed (offline, server restarting): the report held is the one before */
  fetchFailed: boolean;
  order: readonly string[];
  hidden: readonly string[];
  count: UsageCount;
  /** the account picked in the strip; one of another provider (the pane's agent changed) is ignored */
  selectedKey: string | null;
  now: number;
}

function windowLength(window: UsageWindow): number | null {
  if (window.starts_at === null || window.resets_at === null) return null;
  const hours = Math.round((Date.parse(window.resets_at) - Date.parse(window.starts_at)) / 3_600_000);
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

export function windowView(window: UsageWindow, count: UsageCount, now: number): PaneUsageWindow {
  const kind = window.kind === "week" ? "week" : "session";
  const hours = kind === "session" ? windowLength(window) : null;
  const label = kind === "week" ? t("Weekly") : hours !== null && hours < 24 ? t("{hours}h", { hours }) : t("Session");
  const percent = meterPercent(window, count);
  const value = formatPercent(percent);
  return {
    kind, label, percent,
    text: count === "left" ? t("{percent} left", { percent: value }) : t("{percent} used", { percent: value }),
    resetIn: formatResetIn(window.resets_at, now), resetsAt: window.resets_at,
    high: window.used_percent >= HIGH_PERCENT,
  };
}

export function staleReason(usage: ProviderUsage, fetchFailed: boolean, now: number): StaleReason | null {
  if (usage.problem !== null) return usage.problem;
  if (fetchFailed) return "offline";
  if (usage.checked_at === null) return null;
  const checked = Date.parse(usage.checked_at);
  if (now - checked > OLD_AFTER_MS) return "old";
  // a window that has started over since it was read: its numbers are the last window's
  if (usage.windows.some((window) => window.resets_at !== null && Date.parse(window.resets_at) <= now && checked < Date.parse(window.resets_at))) return "old";
  return null;
}

export function accountView(usage: ProviderUsage, count: UsageCount, fetchFailed: boolean, now: number): PaneUsageAccount {
  const windows = statusWindows(usage).map((window) => windowView(window, count, now));
  return { key: usage.key, account: usage.account, plan: usage.plan, problem: usage.problem, checkedAt: usage.checked_at, windows, stale: staleReason(usage, fetchFailed, now) };
}

export function paneUsageView(input: PaneUsageInput): PaneUsageView {
  const { agent } = input;
  if (!agent) return { state: "none" };
  const provider = stripProvider(agent);
  if (!input.enabled) return provider !== null && input.machineId === LOCAL_MACHINE ? { state: "opt-in", provider } : { state: "none" };
  if (input.machineId !== LOCAL_MACHINE) return { state: "remote", provider };
  if (provider === null) return { state: "unsupported", agent };
  if (input.report === null) return input.fetchFailed ? { state: "offline", provider } : { state: "loading", provider };
  const all = orderProviders(input.report.providers, input.order).filter((usage) => usage.id === provider);
  if (all.length === 0) return { state: "missing", provider };
  const shown = all.filter((usage) => !input.hidden.includes(usage.key));
  if (shown.length === 0) return { state: "hidden", provider };
  const accounts = shown.map((usage) => accountView(usage, input.count, input.fetchFailed, input.now));
  const selected = accounts.find((account) => account.key === input.selectedKey) ?? accounts[0]!;
  return { state: "ready", provider, accounts, selected, multiple: accounts.length > 1 };
}

/** The account as the strip names it: never a guess at the pane's own account. */
export function accountLabel(account: PaneUsageAccount, index: number): string {
  const name = account.account ?? t("Account {n}", { n: index + 1 });
  return account.plan ? `${name} · ${account.plan}` : name;
}

export function providerName(provider: UsageProviderId): string {
  return PROVIDER_NAME[provider];
}

/** The badge a stale or broken account carries; null when its numbers are current. */
export function staleText(reason: StaleReason | null): string | null {
  switch (reason) {
    case null: return null;
    case "expired": return t("Sign-in expired");
    case "rate_limited": return t("Rate limited · old data");
    case "failed": return t("Not refreshed · old data");
    case "locked": return t("Keychain locked");
    case "offline": return t("Offline · old data");
    case "old": return t("Old data");
  }
}

/** "3m ago" since the numbers were read; null when they never were. */
export function checkedAgo(checkedAt: string | null, now: number): string | null {
  if (checkedAt === null) return null;
  const minutes = Math.floor((now - Date.parse(checkedAt)) / 60_000);
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{m}m ago", { m: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t("{h}h ago", { h: hours }) : t("{d}d ago", { d: Math.floor(hours / 24) });
}

/** The one line the strip reads out and shows on a narrow screen. */
export function paneUsageSummary(view: PaneUsageView): string {
  switch (view.state) {
    case "none": return "";
    case "opt-in": return t("Plan usage is off");
    case "remote": return t("Remote usage not available yet");
    case "unsupported": return t("No plan usage for this agent");
    case "loading": return t("Reading plan usage…");
    case "offline": return t("Plan usage unavailable: the server did not answer");
    case "missing": return t("No {provider} sign-in on this server", { provider: providerName(view.provider) });
    case "hidden": return t("{provider} accounts are hidden in Settings", { provider: providerName(view.provider) });
    case "ready": {
      const account = view.selected;
      const parts = account.windows.map((window) => `${window.label} ${window.text}${window.resetIn ? ` (${t("Resets in {time}", { time: window.resetIn })})` : ""}`);
      if (parts.length === 0) parts.push(t("No data"));
      const stale = staleText(account.stale);
      return [providerName(view.provider), ...parts, ...(stale ? [stale] : [])].join(", ");
    }
  }
}
