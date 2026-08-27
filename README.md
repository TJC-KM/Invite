# 黎明教會 個人化邀請卡

一人一組隨機網址，開啟專屬邀請卡。內容（邀請對象、給對象的話、活動海報、附件見證）
由信徒透過維護介面管理。

> **狀態：規劃中，還沒開始寫程式。**

## 文件

| 檔案 | 說明 |
|------|------|
| [`docs/規格.html`](docs/規格.html) | **完整規格**——架構、資料表、命名規則、建置步驟。雙擊開啟 |
| [`docs/原型.html`](docs/原型.html) | 可行性原型，可點的模擬版。雙擊開啟 |
| [`docs/施做步驟.html`](docs/施做步驟.html) | **施做計畫**——決策、階段順序、每步驗收條件、回推時程。雙擊開啟 |

線上版（同一份內容）：
- 規格 <https://claude.ai/code/artifact/618bb360-d8ee-4ec7-8e52-6af21cf98aff>
- 原型 <https://claude.ai/code/artifact/f6eca893-f4ad-4ee5-aef1-ae620ad7dc89>
- 施做計畫 <https://claude.ai/code/artifact/bcbcbc21-e866-4552-ab71-cc75651378a2>

## 架構摘要

```
invite.li-ming-tjc.org/<12碼>   →  Worker            公開邀請卡，免登入
invite.li-ming-tjc.org/admin    →  Access → Worker   維護介面，白名單 email
                                       ↓
                                   KV 快取
                                       ↓
                              Google 試算表（資料的家）
                              Google 雲端硬碟（海報、附件 PDF）
```

- **資料放 Google 試算表**，信徒看得到、必要時能直接改
- **前面掛 Cloudflare Worker ＋ KV 快取**，不用 GAS——GAS 冷啟動太慢，
  邀請卡是陌生人從 LINE 點開的，開場空白三秒就沒了。
  Sheets API 本身也不快（200～400ms），所以快取這層是必要的，不是加分項
- Worker 用**服務帳戶**存取試算表（金鑰存成 Worker secret，不進 git）
- **維護介面用 Cloudflare Access 擋**，不自己寫登入，50 人以內免費
- 伺服器端渲染，所以**每張卡有自己的 LINE 預覽標題和縮圖**

## 已決定

- 另開專案，不併進活動快報（`GoogleAppsScript/News`）——技術棧完全不同
- 資料留在 Google 試算表，不改用資料庫
- repo 放 `tjc-km`，子網域 `invite.li-ming-tjc.org`
- 網址代碼 12 碼、小寫、字集去掉易混淆字元，**不可流水號**
- 教會資訊與雲端資料夾 ID 放 `wrangler.toml`，不進試算表

## 待決定

見規格第 10 節。最需要先拍板的是**要不要記錄開啟次數**（隱私 vs 關懷追蹤）。

## 注意

網址代碼是**「猜不到」，不是「有權限管制」**——拿到網址的人都看得到。
適合放邀請函與活動資訊，不要放電話、地址、奉獻紀錄。

## 素材出處

原始檔在 `C:\Users\c3012\Downloads\`：
`1.給見證者的信.docx`、`2.給慕道者的信.pdf`（1 頁純文字，已是模板格式）、
`3.蘇真玉見證.pdf`（6 頁掃描圖，**無文字層**）、
`靈恩會海報.jpg`、`右邊福茶海報.png`、`左邊名字.png`（目前手動拼貼的名字卡）
