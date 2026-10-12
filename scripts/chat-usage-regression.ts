/**
 * The plan usage strip over the chat lens's input card (PaneUsageStrip), on the unmodified app over
 * the demo's fixture transport: no herdr session is opened, the user's default one included, and no
 * real sign-in is read. GET /api/usage is answered here from synthetic reports (fictional accounts
 * under example.test) and every request to it is counted, so "off" is shown to send nothing. The
 * pane's agent, and for one case a second, remote PC carrying the same fixtures, are patched into
 * what the demo answers, in this test only. Screenshots go to artifacts/chat-usage/.
 *
 *   bun run scripts/chat-usage-regression.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ProviderUsage, UsageReport, UsageWindow } from "../shared/protocol.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

const repo = join(import.meta.dir, "..");
const artifacts = join(repo, "artifacts", "chat-usage");
const app = mkdtempSync(join(tmpdir(), "herdr-chat-usage-"));
const TARGET = panes.api;

// ---- synthetic reports --------------------------------------------------------------------------

const at = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();
const session = (used: number, resetIn = 2.4): UsageWindow => ({ kind: "session", scope: null, used_percent: used, resets_at: at(resetIn), starts_at: at(resetIn - 5) });
const week = (used: number, resetIn = 78): UsageWindow => ({ kind: "week", scope: null, used_percent: used, resets_at: at(resetIn), starts_at: at(resetIn - 168) });
const account = (id: ProviderUsage["id"], name: string, windows: UsageWindow[], extra: Partial<ProviderUsage> = {}): ProviderUsage => ({
  id, key: `${id}:${name}`, account: name, plan: "max", windows, problem: null, checked_at: at(0), ...extra,
});
const claudeHealthy = () => account("claude", "sam@example.test", [session(38), week(61), { ...week(12), scope: "Sonnet" }]);
const codexWeekly = () => account("codex", "sam@work.example.test", [week(84, 97)], { plan: "pro" });
const report = (...providers: ProviderUsage[]): UsageReport => ({ providers });

interface Case {
  agent: string;
  /** what GET /api/usage answers; "fail" rejects as a dropped connection does */
  usage: UsageReport | "fail";
  settings?: Record<string, unknown>;
  remote?: boolean;
}

// ---- the page --------------------------------------------------------------------------------

/** Read before the demo's transport: the pane's agent and the extra PC, patched into what the demo answers. */
const before = `<script>(() => {
  const TARGET = ${JSON.stringify(TARGET)};
  const clone = structuredClone;
  const fix = (value) => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) { value.forEach(fix); return value; }
    if (value.pane_id === TARGET && "agent" in value) value.agent = window.usageCase.agent;
    if (window.usageCase.remote && Array.isArray(value.machines) && !value.machines.some((machine) => machine && machine.id === "studio")) {
      const local = value.machines.find((machine) => machine && machine.id === "local");
      if (local) value.machines.push({ ...clone(local), id: "studio", name: "studio", kind: "ssh", target: { destination: "studio.example.test" } });
    }
    for (const key of Object.keys(value)) fix(value[key]);
    return value;
  };
  window.structuredClone = (value, options) => fix(clone(value, options));
  const parse = JSON.parse;
  JSON.parse = function (text, reviver) { return fix(parse.call(JSON, text, reviver)); };
  const json = Response.prototype.json;
  Response.prototype.json = async function () { return fix(await json.call(this)); };
})();</script>`;

/** Read after it: /api/usage answered and counted here, the remote PC's routes served by the demo's, sockets and frames counted. */
const after = `<script>(() => {
  window.usageCalls = 0; window.conversationReads = 0; window.socketsOpened = 0; window.sentFrames = [];
  const demoFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = String(typeof input === "string" ? input : input.url ?? input);
    if (new URL(url, location.href).pathname.endsWith("/api/usage")) {
      window.usageCalls++;
      const usage = window.usageCase.usage;
      if (usage === "fail") return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(new Response(JSON.stringify(usage), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (url.includes("/pane/conversation")) window.conversationReads++;
    const local = url.replace("/api/machines/studio/", "/api/");
    return demoFetch(local === url ? input : local, init);
  };
  const Socket = window.WebSocket;
  const Wrapped = function (...args) {
    window.socketsOpened++;
    const socket = new Socket(...args);
    const send = socket.send.bind(socket);
    socket.send = (data) => { window.sentFrames.push(String(data)); return send(data); };
    return socket;
  };
  Object.assign(Wrapped, { CONNECTING: Socket.CONNECTING, OPEN: Socket.OPEN, CLOSING: Socket.CLOSING, CLOSED: Socket.CLOSED });
  window.WebSocket = Wrapped;
})();</script>`;

const strip = (page: Page) => page.locator(".pane-usage-strip");
const calls = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { usageCalls: number }).usageCalls);
const shot = async (page: Page, name: string): Promise<void> => { await page.screenshot({ path: join(artifacts, `${name}.png`) }); };
const noSideScroll = async (page: Page, what: string): Promise<void> => {
  const [scroll, width, box] = await page.evaluate(() => {
    const node = document.querySelector(".pane-usage-strip")!.getBoundingClientRect();
    return [document.documentElement.scrollWidth, window.innerWidth, { left: node.left, right: node.right }] as const;
  });
  assert.ok(scroll <= width, `${what}: the page does not scroll sideways (${scroll} > ${width})`);
  assert.ok(box.left >= 0 && box.right <= width + 0.5, `${what}: the strip stays on screen: ${JSON.stringify(box)}`);
};

try {
  mkdirSync(artifacts, { recursive: true });
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `${before}\n    <script src="./demo-transport.js"></script>\n    ${after}\n    <script type="module"`));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/app/")) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.slice("/app/".length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const base = `http://127.0.0.1:${server.port}/app/`;

  const executablePath = process.env.CHROME_PATH ?? (existsSync("/opt/google/chrome/chrome") ? "/opt/google/chrome/chrome" : chromium.executablePath());
  const browser: Browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  /** One case in a fresh browser: a 1440x900 window, or a 390x844 phone. */
  const withPane = async (state: Case, run: (page: Page) => Promise<void>, phone = false): Promise<void> => {
    const context = await browser.newContext(phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "en-US" });
    try {
      await context.addInitScript((usageCase) => {
        if (localStorage.getItem("herdr-web-ui:settings") === null) {
          localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", voiceInput: "off", ...usageCase.settings }));
        }
        Object.assign(window, { usageCase });
      }, state);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const query = new URLSearchParams({ pane: TARGET, view: "chat", ...(state.remote ? { machine: "studio" } : {}) });
      await page.goto(`${base}?${query.toString()}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      if (await page.locator(".terminal-stack.is-chat").count() === 0) await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
      await page.locator(".terminal-stack.is-chat .composer-surface").waitFor();
      await run(page);
      assert.deepEqual(errors, [], "no page errors");
    } finally {
      await context.close();
    }
  };
  const on = (extra: Record<string, unknown> = {}) => ({ showUsage: true, ...extra });

  // 1. off until chosen: one explicit action, and not one request before it is pressed
  await withPane({ agent: "claude", usage: report(claudeHealthy()) }, async (page) => {
    await strip(page).waitFor();
    assert.equal(await strip(page).getAttribute("data-state"), "opt-in");
    // the chat has polled its conversation by now: the app is running, and asked nothing of /api/usage
    await page.waitForFunction(() => (window as unknown as { conversationReads: number }).conversationReads > 1);
    assert.equal(await calls(page), 0, "showUsage off: no usage request");
    await shot(page, "desktop-opt-in");
    await page.getByRole("button", { name: "Show plan usage", exact: true }).click();
    await page.locator('.pane-usage-strip[data-state="ready"]').waitFor();
    assert.ok(await calls(page) > 0, "the explicit action turns the setting on and reads");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}") as { showUsage?: boolean });
    assert.equal(stored.showUsage, true);
    await page.reload();
    await page.locator('.pane-usage-strip[data-state="ready"]').waitFor();
    assert.ok(await calls(page) > 0, "reload restores the opt-in and reads quota again");
    assert.match(await strip(page).textContent() ?? "", /62% left/);
  });
  console.log("PASS off by default: an explicit Show plan usage action, no request before it");

  // 2. healthy Claude: 5h and the week, what is left (the default), resets, the server's account named as the source
  await withPane({ agent: "claude", usage: report(claudeHealthy(), codexWeekly()), settings: on() }, async (page) => {
    const ready = page.locator('.pane-usage-strip[data-state="ready"]');
    await ready.waitFor();
    assert.equal(await ready.getAttribute("data-provider"), "claude");
    assert.equal(await ready.getAttribute("data-stale"), null, "fresh numbers carry no stale mark");
    const windows = await ready.locator(".pane-usage-window").evaluateAll((nodes) => nodes.map((node) => [node.getAttribute("data-kind"), node.querySelector(".pane-usage-label")?.textContent, node.querySelector(".pane-usage-value")?.textContent, node.querySelector(".pane-usage-reset")?.textContent ?? null]));
    assert.deepEqual(windows.map((row) => row.slice(0, 3)), [["session", "5h", "62% left"], ["week", "Weekly", "39% left"]]);
    assert.match(String(windows[0]![3]), /^· 2h 2[34]m$/);
    assert.match(String(windows[1]![3]), /^· 3d [56]h$/);
    assert.equal(await ready.locator(".pane-usage-source").textContent(), "Server account");
    assert.equal(await ready.locator(".pane-usage-account").count(), 0, "one account: no picker");
    // the context ring is the conversation's: the strip says nothing of tokens
    assert.doesNotMatch(await ready.textContent() ?? "", /token|context/i);
    await shot(page, "desktop-claude-healthy");
    await ready.screenshot({ path: join(artifacts, "desktop-claude-strip.png") });
    // folded details: where the numbers come from and what they are not
    const summary = ready.locator(".pane-usage-summary");
    assert.equal(await summary.getAttribute("aria-expanded"), "false");
    await summary.click();
    const details = ready.locator(".pane-usage-details");
    await details.waitFor();
    const text = await details.textContent() ?? "";
    assert.match(text, /Read from the Claude sign-in on the PC running this server \(sam@example\.test · max\)\. It may not be the account this pane bills to\./);
    assert.match(text, /Plan usage is separate from this conversation's context window\./);
    assert.match(text, /Resets in 2h 2[34]m/);
    await shot(page, "desktop-claude-details");
  });
  console.log("PASS healthy Claude: 5h and weekly left with resets, server account source, details");

  // 3. the same on a phone: fits, folds, opens
  await withPane({ agent: "claude", usage: report(claudeHealthy()), settings: on() }, async (page) => {
    const ready = page.locator('.pane-usage-strip[data-state="ready"]');
    await ready.waitFor();
    await noSideScroll(page, "phone");
    assert.equal(await ready.locator(".pane-usage-reset").first().isVisible(), false, "a phone keeps resets for the details");
    assert.equal(await ready.locator(".pane-usage-source").isVisible(), true, "and still names the source");
    await shot(page, "mobile-claude-healthy");
    await ready.locator(".pane-usage-summary").click();
    await ready.locator(".pane-usage-details").waitFor();
    await noSideScroll(page, "phone, details open");
    await shot(page, "mobile-claude-details");
  }, true);
  console.log("PASS phone: no sideways scroll, resets folded into details that open");

  // 4. Codex: a week and no short window draws the week alone
  await withPane({ agent: "codex", usage: report(claudeHealthy(), codexWeekly()), settings: on() }, async (page) => {
    const ready = page.locator('.pane-usage-strip[data-state="ready"]');
    await ready.waitFor();
    assert.equal(await ready.getAttribute("data-provider"), "codex");
    assert.deepEqual(await ready.locator(".pane-usage-window").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-kind"))), ["week"]);
    assert.equal(await ready.locator(".pane-usage-value").textContent(), "16% left");
    assert.equal(await ready.locator(".pane-usage-window.is-high").count(), 1, "84% used is near the limit");
    await shot(page, "desktop-codex-week-only");
  });
  console.log("PASS Codex week only");

  // 5. expired sign-in, with and without numbers kept
  await withPane({ agent: "claude", usage: report(account("claude", "sam@example.test", [week(70)], { problem: "expired", checked_at: at(-3) })), settings: on() }, async (page) => {
    const ready = page.locator('.pane-usage-strip[data-state="ready"]');
    await ready.waitFor();
    assert.equal(await ready.getAttribute("data-stale"), "expired");
    assert.equal(await ready.locator('.pane-usage-badge[data-reason="expired"]').textContent(), "Sign-in expired");
    await shot(page, "desktop-expired");
  });
  await withPane({ agent: "claude", usage: report(account("claude", "sam@example.test", [], { problem: "expired", checked_at: null })), settings: on() }, async (page) => {
    const ready = page.locator('.pane-usage-strip[data-state="ready"]');
    await ready.waitFor();
    assert.equal(await ready.locator(".pane-usage-window.is-empty").textContent(), "No data");
    assert.doesNotMatch(await ready.locator(".pane-usage-summary").textContent() ?? "", /\d+%/, "no data is never drawn as a percentage");
    await ready.locator(".pane-usage-summary").click();
    assert.match(await ready.locator(".pane-usage-details").textContent() ?? "", /Sign-in expired\. Open Claude to renew it\..*Never read/);
  }, true);
  console.log("PASS expired sign-in, numbers kept as old or none at all");

  // 6. no sign-in of the pane's provider, and an agent with no plan of its own (asked nothing)
  await withPane({ agent: "claude", usage: report(codexWeekly()), settings: on() }, async (page) => {
    await page.locator('.pane-usage-strip[data-state="missing"]').waitFor();
    assert.equal(await strip(page).textContent(), "No Claude sign-in on this server");
    await shot(page, "desktop-missing");
  });
  await withPane({ agent: "pi", usage: report(claudeHealthy()), settings: on() }, async (page) => {
    await page.locator('.pane-usage-strip[data-state="unsupported"]').waitFor();
    assert.equal(await strip(page).textContent(), "No plan usage for this agent");
    // the sidebar's meters may read the report; the strip never takes pi's model for a Claude plan
    assert.doesNotMatch(await strip(page).textContent() ?? "", /%|Claude/);
    await shot(page, "desktop-unsupported");
  });
  console.log("PASS missing sign-in and unsupported agent");

  // 7. old numbers: a 429 the server kept, and a read the client could not make
  await withPane({ agent: "claude", usage: report(account("claude", "sam@example.test", [session(38), week(61)], { problem: "rate_limited", checked_at: at(-0.5) })), settings: on() }, async (page) => {
    const ready = page.locator('.pane-usage-strip[data-state="ready"]');
    await ready.waitFor();
    assert.equal(await ready.getAttribute("data-stale"), "rate_limited");
    assert.equal(await ready.locator(".pane-usage-badge").textContent(), "Rate limited · old data");
    await ready.locator(".pane-usage-summary").click();
    assert.match(await ready.locator(".pane-usage-details").textContent() ?? "", /Read 30m ago · Rate limited · old data/);
    await shot(page, "desktop-stale-429");
  });
  await withPane({ agent: "claude", usage: report(claudeHealthy()), settings: on() }, async (page) => {
    const ready = page.locator('.pane-usage-strip[data-state="ready"]');
    await ready.waitFor();
    assert.equal(await ready.getAttribute("data-stale"), null);
    // the server stops answering; the page comes back to the foreground and reads again
    const before = await calls(page);
    const visibility = (state: string) => page.evaluate((value) => new Promise<void>((done) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
      // React commits the hidden page before it is shown again
      requestAnimationFrame(() => requestAnimationFrame(() => done()));
    }), state);
    await page.evaluate(() => { (window as unknown as { usageCase: Case }).usageCase.usage = "fail"; });
    await visibility("hidden");
    await visibility("visible");
    await page.waitForFunction((count) => (window as unknown as { usageCalls: number }).usageCalls > count, before);
    await page.locator('.pane-usage-strip[data-stale="offline"]').waitFor();
    assert.equal(await ready.locator(".pane-usage-badge").textContent(), "Offline · old data");
    assert.equal(await ready.locator(".pane-usage-value").first().textContent(), "62% left", "the last numbers stay, marked old");
    await shot(page, "desktop-stale-offline");
  });
  console.log("PASS stale: a kept 429 and an unanswered read are marked old, never fresh");

  // 8. two accounts of one provider: a picker, never the first one claimed as the pane's
  const work = account("codex", "sam@work.example.test", [session(10), week(84, 97)], { plan: "pro" });
  const home = account("codex", "sam@home.example.test", [session(5), week(31, 140)], { plan: "plus" });
  await withPane({ agent: "codex", usage: report(work, home), settings: on() }, async (page) => {
    const ready = page.locator('.pane-usage-strip[data-state="ready"]');
    await ready.waitFor();
    const picker = ready.getByRole("combobox", { name: "Server account", exact: true });
    assert.deepEqual(await picker.locator("option").allTextContents(), ["sam@work.example.test · pro", "sam@home.example.test · plus"]);
    assert.equal(await ready.locator('.pane-usage-window[data-kind="week"] .pane-usage-value').textContent(), "16% left");
    await picker.selectOption(home.key);
    await page.waitForFunction(() => document.querySelector('.pane-usage-window[data-kind="week"] .pane-usage-value')?.textContent === "69% left");
    await ready.locator(".pane-usage-summary").click();
    assert.match(await ready.locator(".pane-usage-details").textContent() ?? "", /This server has 2 Codex accounts\. Pick the one this pane uses; nothing here tells which\./);
    await shot(page, "desktop-multi-account");
  });
  await withPane({ agent: "codex", usage: report(work, home), settings: on() }, async (page) => {
    await page.locator('.pane-usage-strip[data-state="ready"] .pane-usage-account').waitFor();
    await noSideScroll(page, "phone, two accounts");
    await shot(page, "mobile-multi-account");
  }, true);
  console.log("PASS multiple accounts: listed and picked explicitly");

  // 9. a remote PC's pane: never this server's numbers, and nothing asked
  await withPane({ agent: "claude", usage: report(claudeHealthy()), settings: on(), remote: true }, async (page) => {
    await page.locator('.pane-usage-strip[data-state="remote"]').waitFor();
    assert.equal(await strip(page).textContent(), "Remote usage not available yet");
    assert.doesNotMatch(await strip(page).textContent() ?? "", /%/);
    await shot(page, "desktop-remote");
  });
  await withPane({ agent: "claude", usage: report(claudeHealthy()), settings: on(), remote: true }, async (page) => {
    await page.locator('.pane-usage-strip[data-state="remote"]').waitFor();
    await noSideScroll(page, "phone, remote");
    await shot(page, "mobile-remote");
  }, true);
  console.log("PASS remote PC: Remote usage not available yet, the server's plan never shown");

  // 10. the pane's agent changes: the last provider's numbers go with it
  await withPane({ agent: "claude", usage: report(claudeHealthy(), codexWeekly()), settings: on({ usageCount: "used" }) }, async (page) => {
    const ready = page.locator('.pane-usage-strip[data-state="ready"]');
    await ready.waitFor();
    assert.equal(await ready.locator(".pane-usage-value").first().textContent(), "38% used", "Settings → Meters show Used is kept");
    await page.evaluate(() => { (window as unknown as { usageCase: Case }).usageCase.agent = "codex"; });
    // the app reads the session again on its own poll; the strip follows the agent it reports
    await page.locator('.pane-usage-strip[data-provider="codex"]').waitFor({ timeout: 15_000 });
    assert.deepEqual(await ready.locator(".pane-usage-value").allTextContents(), ["84% used"]);
    assert.doesNotMatch(await strip(page).textContent() ?? "", /38%|61%/, "nothing of Claude's is left");
  });
  console.log("PASS agent switch clears the last provider's numbers; Used setting respected");

  // 11. chat and terminal on the same pane: the lens changes, the socket and attach do not, no takeover
  await withPane({ agent: "claude", usage: report(claudeHealthy()), settings: on() }, async (page) => {
    await page.locator('.pane-usage-strip[data-state="ready"]').waitFor();
    const count = () => page.evaluate((pane) => {
      const frames = (window as unknown as { sentFrames: string[] }).sentFrames.map((frame) => { try { return JSON.parse(frame) as Record<string, unknown>; } catch { return {}; } });
      return {
        sockets: (window as unknown as { socketsOpened: number }).socketsOpened,
        attaches: frames.filter((frame) => frame["type"] === "attach" && frame["pane_id"] === pane).length,
        takeover: frames.some((frame) => frame["takeover"] === true),
      };
    }, TARGET);
    const start = await count();
    assert.ok(start.sockets >= 1 && start.attaches >= 1, `the chat lens holds the pane's attach: ${JSON.stringify(start)}`);
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await page.locator(".terminal-stack:not(.is-chat)").waitFor();
    assert.equal(await strip(page).count(), 0, "the terminal lens has no composer, and no strip");
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await page.locator('.terminal-stack.is-chat .pane-usage-strip[data-state="ready"]').waitFor();
    const end = await count();
    assert.equal(end.sockets, start.sockets, "no new socket for a lens change");
    assert.equal(end.attaches, start.attaches, `no new attach for a lens change: ${JSON.stringify([start, end])}`);
    assert.equal(end.takeover, false, "never a takeover");
    assert.equal(new URL(page.url()).searchParams.get("pane"), TARGET, "the same pane");
  });
  console.log("PASS chat ↔ terminal keeps the pane's socket and attach, never a takeover");

  await browser.close();
  server.stop(true);
  console.log(`PASS chat usage strip; screenshots in ${artifacts}`);
} finally {
  rmSync(app, { recursive: true, force: true });
}
