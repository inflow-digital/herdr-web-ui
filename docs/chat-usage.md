# 聊天輸入框旁的方案用量（PaneUsageStrip）

聊天模式的輸入框上方有一列精簡的方案用量，對應原生 Claude / Codex CLI 底部的 5 小時、Weekly 與登入過期提示。

## 資料來源

- 沿用既有唯讀端點 `GET /api/usage`（`server/usage.ts`），型別在 `shared/protocol.ts` 的 `UsageReport`。伺服器只讀各 CLI 自己的登入檔，**永不 refresh OAuth**；登入過期回報為 `expired`，交給 CLI 自己續期；供應商回 429 之後，在它指定的時間前不再詢問。
- 數字是「**執行 herdr-web-ui 伺服器那台電腦上登入的帳號**」的參考值，不保證就是這個 pane 實際計費的帳號。列上固定標示「伺服器帳號」，展開細節會寫出帳號與限制。
- 只依 pane 的 agent id 對應供應商：`claude`→Claude、`codex`→Codex、`cursor`、`copilot`、`grok`、`agy`→Antigravity。**pi、OpenCode（含 GLM、本地模型）、omo 不靠模型字串猜測**，一律顯示「此 Agent 沒有方案用量」。
- 遠端 PC 的 pane 不會拿本機伺服器的額度充數，顯示「尚未提供遠端用量」，也不送出請求。
- 方案用量與對話的 context window（輸入框內的圓環）是兩回事，彼此不互推。

## 顯示的狀態

| 狀態 | 顯示 |
|---|---|
| 正常 | `5h 62% left · 2h 24m`、`Weekly 39% left · 3d 6h`；短窗口若不是 5 小時，以實際長度標示 |
| 只有週額度（如部分 Codex 方案） | 只畫 Weekly，不補 0% 或 100% |
| 供應商沒回報任何限額 | 「無資料」，不是百分比 |
| 登入過期 | 「登入已過期」紅色標記；若有舊數字則淡化保留 |
| 429 / 讀取失敗 / 鑰匙圈鎖定 | 「請求過多 · 舊資料」等標記，展開可看「N 分鐘前讀取」 |
| 瀏覽器連不到伺服器 | 保留上一份數字並標「離線 · 舊資料」（`useUsage` 新增 `failed` 旗標） |
| 超過 15 分鐘沒更新 | 「舊資料」 |
| 伺服器沒有此供應商的登入 | 「此伺服器上沒有 Claude 登入」 |
| 同一供應商多個帳號 | 列旁出現「伺服器帳號」下拉選單，必須明確挑選；細節註明無法得知是哪一個 |
| 帳號全在設定中隱藏 | 「Claude 帳號已在設定中隱藏」 |

切換 pane 的 agent 時，上一個供應商的數字與已選帳號都會清掉。

## 設定

- **預設關閉**（`showUsage: false`，隱私 opt-in）。關閉時列上只有一個「顯示方案用量」按鈕，按下才開啟設定；關閉期間不會發出任何 `/api/usage` 請求。
- 與側欄用量共用設定：設定 → 訂閱用量 的「顯示方案限額」、「計量顯示：已用／剩餘」、帳號排序與隱藏。
- 「計量顯示」預設改為**剩餘**（`usageCount: "left"`）；選了「已用」會照用。
- 手機寬度只顯示數字與來源，重置時間收進可展開的細節。

## 測試

```bash
HERDR_TEST_MODE=unit bun test ./src/lib/paneUsage.test.ts   # 狀態、來源、多帳號、遠端、切換 agent
bun run build && bun run scripts/chat-usage-regression.ts   # Playwright E2E
```

E2E 在暫存目錄建置 demo（fixture transport），不連任何 herdr session；`/api/usage` 由腳本以合成資料（`example.test` 假帳號）回應並計數。涵蓋：opt-in 不送請求、Claude 5h/週、Codex 只有週、過期、無登入、不支援、429 與離線舊資料、多帳號選擇、遠端 PC、切換 agent、聊天↔終端機切換不新建 socket／attach、不 takeover。截圖（desktop 1440x900、mobile 390x844）輸出到 `artifacts/chat-usage/`。

## 限制

- 遠端 PC 的用量尚未實作（需要遠端 bridge 自己讀它那台的登入）。
- 無法判斷 pane 實際使用哪個帳號；多帳號只能由使用者挑選，選擇不跨重新整理保存。
- OpenCode 等多供應商 agent 不顯示方案用量。
