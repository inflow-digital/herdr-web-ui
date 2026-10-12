import { useEffect, useId, useState } from "react";
import { ChevronDown, Gauge, Server } from "lucide-react";

import "./PaneUsageStrip.css";

import { useMachineId } from "../lib/machineContext.tsx";
import { accountLabel, checkedAgo, paneUsageSummary, paneUsageView, providerName, shouldFetchPaneUsage, staleText, stripProvider, type PaneUsageView } from "../lib/paneUsage.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { PROVIDER_MARK, useUsage } from "../lib/usage.ts";
import { AgentMark } from "./AgentMark.tsx";

/**
 * The plan usage of the agent's provider, over the chat lens's input card: the short window and
 * the week with their resets, as the CLI's own status line shows them. A reference read from the
 * sign-in on the PC running this server, labelled so; never this pane's context window, never a
 * remote PC's plan, never asked for before Settings → Show plan limits is on.
 */
export function PaneUsageStrip({ agent }: { agent: string | null }) {
  const provider = stripProvider(agent);
  // another agent in the pane: the picked account and the open details belong to the last one
  return <UsageStrip key={provider ?? agent ?? ""} agent={agent} />;
}

function UsageStrip({ agent }: { agent: string | null }) {
  const t = useT();
  const machineId = useMachineId();
  const { settings, update } = useSettings();
  const fetching = shouldFetchPaneUsage(settings.showUsage, machineId, agent);
  const { report, failed } = useUsage(fetching);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const detailsId = useId();

  // reset countdowns move on between reads
  useEffect(() => {
    if (!fetching) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [fetching, report]);

  const view: PaneUsageView = paneUsageView({
    enabled: settings.showUsage, machineId, agent, report, fetchFailed: failed,
    order: settings.usageOrder, hidden: settings.usageHidden, count: settings.usageCount, selectedKey, now,
  });
  if (view.state === "none") return null;

  if (view.state === "opt-in") {
    return (
      <div className="pane-usage-strip" data-state="opt-in" role="group" aria-label={t("Plan usage")}>
        <button type="button" className="pane-usage-optin" onClick={() => update({ showUsage: true })}
          title={t("Reads the plan limits of the sign-ins on the PC running this server. Off until chosen.")}>
          <Gauge aria-hidden="true" />{t("Show plan usage")}
        </button>
      </div>
    );
  }

  const summary = paneUsageSummary(view);
  if (view.state !== "ready") {
    return (
      <div className="pane-usage-strip" data-state={view.state} role="status" aria-label={t("Plan usage")}>
        <span className="pane-usage-note">
          {view.state === "remote" ? <Server aria-hidden="true" /> : <Gauge aria-hidden="true" />}
          <span>{summary}</span>
        </span>
      </div>
    );
  }

  const account = view.selected;
  const index = view.accounts.indexOf(account);
  const stale = staleText(account.stale);
  const ago = checkedAgo(account.checkedAt, now);
  const name = providerName(view.provider);
  return (
    <div className="pane-usage-strip" data-state="ready" data-stale={account.stale ?? undefined} data-provider={view.provider}
      role="group" aria-label={t("Plan usage")}>
      <div className="pane-usage-row">
        <button type="button" className="pane-usage-summary" aria-expanded={open} aria-controls={detailsId}
          onClick={() => setOpen((shown) => !shown)} title={summary}>
          <AgentMark agent={PROVIDER_MARK[view.provider]} size={13} />
          <span className="pane-usage-source"><Server aria-hidden="true" />{t("Server account")}</span>
          {account.windows.length === 0
            ? <span className="pane-usage-window is-empty">{t("No data")}</span>
            : account.windows.map((window) => (
              <span key={window.kind} className={`pane-usage-window${window.high ? " is-high" : ""}`} data-kind={window.kind}>
                <span className="pane-usage-label">{window.label}</span>
                <span className="pane-usage-value">{window.text}</span>
                {window.resetIn && <span className="pane-usage-reset">· {window.resetIn}</span>}
              </span>
            ))}
          {stale && <span className={`pane-usage-badge${account.stale === "expired" ? " is-error" : ""}`} data-reason={account.stale}>{stale}</span>}
          <span className="visually-hidden">{summary}</span>
          <ChevronDown className="pane-usage-chevron" aria-hidden="true" />
        </button>
        {view.multiple && (
          <select className="select pane-usage-account" aria-label={t("Server account")} value={account.key}
            onChange={(event) => setSelectedKey(event.target.value)}>
            {view.accounts.map((option, at) => <option key={option.key} value={option.key}>{accountLabel(option, at)}</option>)}
          </select>
        )}
      </div>
      {open && (
        <div className="pane-usage-details" id={detailsId}>
          <p className="pane-usage-scope">
            {t("Read from the {provider} sign-in on the PC running this server ({account}). It may not be the account this pane bills to.", { provider: name, account: accountLabel(account, index) })}
          </p>
          {view.multiple && <p className="pane-usage-scope">{t("This server has {n} {provider} accounts. Pick the one this pane uses; nothing here tells which.", { n: view.accounts.length, provider: name })}</p>}
          {account.windows.length > 0 && (
            <ul className="pane-usage-list">
              {account.windows.map((window) => (
                <li key={window.kind} className={window.high ? "is-high" : undefined}>
                  <span className="pane-usage-label">{window.label}</span>
                  <span className="pane-usage-value">{window.text}</span>
                  <span className="pane-usage-reset-full">{window.resetIn ? t("Resets in {time}", { time: window.resetIn }) : t("Reset time unknown")}</span>
                </li>
              ))}
            </ul>
          )}
          {account.windows.length === 0 && <p className="pane-usage-scope">{account.problem === "expired" ? t("Sign-in expired. Open {name} to renew it.", { name }) : t("The provider reported no limits for this account.")}</p>}
          <p className="pane-usage-meta">
            {ago ? t("Read {ago}", { ago }) : t("Never read")}
            {stale ? ` · ${stale}` : ""}
          </p>
          <p className="pane-usage-meta">{t("Plan usage is separate from this conversation's context window.")}</p>
        </div>
      )}
    </div>
  );
}
