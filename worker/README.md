# Worker 起手式

把原型的版面拆成 Worker 跑得動的形狀。複製這個資料夾的內容到 Worker 專案就能跑。

```
wrangler dev
```

打開 `http://localhost:8787/k7m2xq9v4bt3`（任何 12 碼、只用
`23456789abcdefghjkmnpqrstuvwxyz` 的字串都可以），會看到一張用假資料組出來的卡片。

## 為什麼原型不能整份貼進 Worker

| 原因 | 說明 |
|------|------|
| HTML 貼進 `.js` 裡 | 原型第 427 行起自己就有 12 個反引號和 25 個 `${...}`。外層再包一層樣板字串，字串會提早結束，剩下的 HTML 被當成 JS 執行——那些 `Unexpected token`、`xxx is not defined` 都是這樣來的 |
| 原型是「示範外殼」 | 頁首、模擬試算表、手機外框、下方說明都是給你看的。要搬進 Worker 的只有 `renderCard()` 產出的那張卡 |
| 兩張海報是內嵌圖 | base64 共 228 KB，佔原型檔案的 93%。這些要改成 `/img/<Drive 檔案 ID>` |
| `document` 在 Worker 裡不存在 | 原型結尾的 `getElementById`、`addEventListener` 是瀏覽器的東西，Worker 沒有 DOM |

解法就是這個資料夾的做法：**HTML 放 `.html` 檔，用 `import` 讀進來**，
`wrangler.toml` 裡的 `[[rules]] type = "Text"` 讓它變成一個字串。
HTML 裡有什麼字元都不影響 JS。

## 檔案

| 檔案 | 做什麼 |
|------|--------|
| `src/card.html` | 邀請卡版面。`{{變數}}` 是要代入的位置 |
| `src/notfound.html` | 連結失效 / 找不到 |
| `src/index.js` | 路由、組字串、逃脫。資料層和圖片代理留了 `TODO` |
| `wrangler.toml` | 設定檔。KV 綁定在 B4 之後補上 |

## 接下來

- `loadInvite()` 現在回傳假資料 → 施做計畫 **B6** 換成 KV ＋ 試算表
- `imageProxy()` 現在回 501 → **C3** 接上 Drive API
- `countOpen()` 是空的 → **C5** 寫回試算表

版面先跑起來、再接資料，順序不要顛倒——看得到東西才有動力。

## 兩個容易踩到的地方

**逃脫順序**：`renderCard()` 是先 `esc()` 整段文字，再把 `{對象}` 換成 `<mark>`。
反過來寫的話，試算表裡任何人打的 HTML 都會被當成標籤執行。

**og:image 要絕對網址**：LINE 不吃 `/img/xxx` 這種相對路徑，
所以 `wrangler.toml` 裡的 `SITE_ORIGIN` 要填對，換網域時記得改。
