// 心得回饋：填寫頁、維護介面、上傳、推薦。
//
// 跟邀請卡完全分開的一份試算表（FEEDBACK_SHEET_ID）和
// 一個雲端資料夾（FEEDBACK_FOLDER），只有 Google 的存取層是共用的。
//
// 這裡的資料比邀請卡敏感得多——是信徒自己寫的心得。
// 教會只是保存；真的要用一定會先找本人談。程式不做「同意書打勾」那套，
// 因為打勾不等於同意，那是人跟人之間的事

import FEEDBACK_HTML from "./feedback.html";
import FADMIN_HTML from "./fadmin.html";
import FREAD_HTML from "./fread.html";
import { readSheet, updateCell, appendRow, getAccessToken } from "./google.js";
import { fill, esc, json, isPreviewBot, 欄名, 產生代碼, 台北時間, 台北日期, 代入, 解碼, 連結化 } from "./lib.js";

const 分頁 = { 回饋: "回饋單", 推薦: "推薦", 設定: "設定檔", 主題: "主題" };
const CODE_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/;

// 填寫頁不快取。使用者按了「先儲存」，回頭重整卻看到舊內容，
// 那一秒他會以為東西不見了——這種驚嚇比多讀一次試算表貴得多
const 設定快取秒 = 120;

/* ── 文案 ────────────────────────────────────────
   全部走設定檔分頁，改字不用改程式。沒建分頁、
   或某一則沒填，就用這裡的預設值
   ──────────────────────────────────────────────── */

const 預設文案 = {
  頁首標題: "說說主的恩典",

  說明標題: "為什麼邀請你寫下來",

  // 語氣參考邀請卡「給慕道者的信」：謙卑、懇請、不給壓力。
  //
  // 五段，刻意壓短過。這段字會擋在表單前面，長了就沒有人讀完，
  // 而沒讀完的人不會知道「不寫也可以」——那才是最該傳達到的一句
  邀請說明: [
    "有些事情，如果沒有記下來，就真的過去了。",
    "這些年神在我們中間做了很多事——有人在難處裡被扶了一把，有人等了很久才看見帶領。當下都很真實，可是五年十年之後，連自己都會想不起來。教會想做的很單純：把這些記下來、保存好，將來辦活動、出週年刊、安排見證分享的時候，才有機會來跟你邀稿。",
    "不寫也沒關係，真的。我們不會沒事把大家寫的東西拿出來看；放著就放著，沒有人會來催。",
    "如果覺得是私事、不想留在教會這裡，那就自己記著就好，有需要再跟我們說。或者只在這裡寫一兩句給自己當記號，細節留在心裡也可以。記得的人是你，不是這個網頁。",
    // 下限和上限都要留門：怕寫太少的人需要「寫最近的就好」，
    // 手上已經有講章的人需要有人告訴他「那份也算」——
    // 那群人往往交出品質最好的一批，卻最容易以為自己的東西不合用
    "不用特地回頭整理一輩子，寫最近的心情、這陣子想到的事就可以。手上已經有完整一篇的——講台上分享過的也算——直接傳上來就好。真的很謝謝你願意。願神帶領我們每一個人。",
  ].join("\n\n"),

  保存說明: [
    "你寫的東西教會會妥善保存，不會公開，也不會轉給別人。",
    "將來若有機會用在週年刊或見證分享，一定會先跟你本人聯絡、取得你的同意，才有下一步。",
  ].join("\n"),

  心得提示: "想到什麼就寫什麼，長短都可以",

  心得說明: [
    "不一定要在這裡打字。習慣用 Word 的人，直接打在 Word 裡，再從下面上傳就好——心得的字通常很多，這個框只是方便，不是規定。",
    "中途離開沒關係，這頁會自己幫你記住。",
  ].join("\n"),

  上傳說明: [
    "很歡迎用 Word。打好的檔案、照片、影片都可以傳上來，一次能選好幾個。",
    "選好就會開始傳，不用等按送出。",
  ].join("\n"),

  推薦說明: "還有誰的經歷讓你印象深刻？我們可以也去邀請他分享",

  存檔提醒: "慢慢寫，不急，隨時回到這個連結都還在。",

  送出按鈕: "送出",
  暫存按鈕: "先儲存",
  送出後訊息: "謝謝你願意寫下來　🙏",
  單檔上限MB: "500",
  LINE訊息: "{對象全稱}平安，想邀請你說說主在你身上的恩典：\n{網址}",
  主題訊息: "平安，想請大家說說主的恩典：\n{引言}\n\n{網址}",
};

export function 文案(來源, 代號, 變數) {
  const 樣板 = (來源 && 來源[代號]) || 預設文案[代號] || "";
  return 代入(樣板, 變數 || {});
}

/* ── 資料層 ──────────────────────────────────────
   readSheet 預設讀邀請卡那份試算表，所以每次都要
   明講是回饋這一份。漏掉的話會安靜地讀錯表
   ──────────────────────────────────────────────── */

const 表 = (env) => ({ 試算表: env.FEEDBACK_SHEET_ID });

async function 讀回饋(env, tab) {
  return readSheet(env, tab, 表(env));
}

export async function 設定(env, { 即時 = false } = {}) {
  if (env.CACHE && !即時) {
    const hit = await env.CACHE.get("fcfg:v1", "json");
    if (hit) return hit;
  }
  const 列 = await 讀回饋(env, 分頁.設定).catch(() => []);
  const cfg = {};
  for (const r of 列) {
    const k = String(r.代號 || "").trim();
    if (k) cfg[k] = String(r.內容 ?? "");
  }
  if (env.CACHE) {
    await env.CACHE.put("fcfg:v1", JSON.stringify(cfg), { expirationTtl: 設定快取秒 });
  }
  return cfg;
}

// 一律讀即時。回饋單是使用者自己剛剛寫的東西，不能給他看快取
export async function 找回饋(env, code) {
  const 列 = await 讀回饋(env, 分頁.回饋);
  return 列.find((x) => String(x.代碼 || "").toLowerCase() === code) || null;
}

/* ── 填寫頁 ─────────────────────────────────────── */

// 幹部掃過去的時候，「Word」比一長串檔名有用得多
function 檔案種類(mime) {
  const m = String(mime || "");
  // 幹部有可能自己把 Google 文件丟進資料夾，再把 ID 貼到試算表上
  if (m === "application/vnd.google-apps.document") return "文件";
  if (m === "application/vnd.google-apps.spreadsheet") return "試算表";
  if (m === "application/vnd.google-apps.presentation") return "簡報";
  if (m.includes("wordprocessing") || m.includes("msword")) return "Word";
  if (m.includes("presentation")) return "簡報";
  if (m.includes("spreadsheet")) return "試算表";
  if (m === "application/pdf") return "PDF";
  if (m.startsWith("image/")) return "照片";
  if (m.startsWith("video/")) return "影片";
  if (m.startsWith("audio/")) return "錄音";
  if (m.startsWith("text/")) return "文字檔";
  return "檔案";
}
// 已經傳上去的檔案，回頭要顯示名字。通常只有零到三個，
// 一個一個問就好——Drive 沒有「一次問這幾個 ID」的用法
async function 檔案清單(env, 值) {
  const ids = String(值 || "").split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  if (!ids.length) return [];
  const token = await getAccessToken(env);
  return Promise.all(ids.map(async (id) => {
    try {
      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType&supportsAllDrives=true`,
        { headers: { authorization: `Bearer ${token}` } }
      ).then((x) => x.json());
      return { id, 名稱: r.name || id, 類型: r.mimeType || "" };
    } catch (e) {
      return { id, 名稱: id, 類型: "" };   // 問不到就顯示 ID，總比整頁壞掉好
    }
  }));
}


async function 填寫頁(code, request, env, ctx) {
  const [r, cfg] = await Promise.all([找回饋(env, code), 設定(env)]);
  if (!r || r.狀態 === "已停用") return null;

  const 檔案 = await 檔案清單(env, r.檔案);
  const html = 畫填寫頁({ env, r, cfg, code, 檔案 });

  if (!isPreviewBot(request.headers.get("user-agent"))) {
    ctx.waitUntil(記開啟(env, r));
  }

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ── 主題頁 ──────────────────────────────────────
   一個引言、很多人回。貼到群組裡的那種連結。
   這一頁不屬於任何人——直到他留名，那一刻才生出屬於他的一列
   ──────────────────────────────────────────────── */

async function 主題頁(主題代碼, request, env, ctx) {
  const [t, cfg] = await Promise.all([找主題(env, 主題代碼), 設定(env)]);
  if (!t || 停用了(t.啟用)) return null;

  // r 是一列「還不存在的回饋單」。畫面需要的欄位先給預設值
  const r = { 引言: t.引言, 信徒姓名: "", 稱呼: "", 心得內容: "", 填寫日期: "", 最後修改: "" };
  return new Response(畫填寫頁({ env, r, cfg, code: "", 檔案: [], 主題: t.主題代碼 }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const 停用了 = (v) => String(v ?? "").trim() === "否";

function 畫填寫頁({ env, r, cfg, code, 檔案, 主題 = "" }) {
  const 稱呼 = String(r.稱呼 || "").trim() || String(r.信徒姓名 || "").trim();
  const 已送 = r.狀態 === "已填寫" || r.狀態 === "已完成";

  return fill(FEEDBACK_HTML, {
    code: esc(code),
    topic: esc(主題),
    nameField: 主題 ? `
    <div class="f">
      <label for="who">你是誰</label>
      <input type="text" id="who" placeholder="姓名，或是想被怎麼稱呼" autocomplete="name">
      <div class="tip">要留一個名字，我們才知道這是誰寫的。將來若想用你這一篇，才找得到人問你。</div>
    </div>
` : "",
    pageTitle: esc(文案(cfg, "頁首標題", {})),
    churchEn: esc(env.CHURCH_NAME_EN || "TRUE JESUS CHURCH"),
    churchZh: esc(env.CHURCH_NAME || "真耶穌教會　黎明教會"),
    churchSite: esc(env.CHURCH_SITE || "https://li-ming-tjc.org"),
    greet: esc(稱呼 ? `${稱呼}平安` : "平安"),
    letterTitle: esc(文案(cfg, "說明標題", {})),
    letter: 連結化(文案(cfg, "邀請說明", { 稱呼: 稱呼 })),
    prompt: 連結化(r.引言 || "說說看你最近的感動"),
    date: esc(r.填寫日期 || 台北日期()),
    content: esc(r.心得內容 || ""),
    hint: esc(文案(cfg, "心得提示", {})),
    contentTip: esc(文案(cfg, "心得說明", {})),
    keepNote: esc(文案(cfg, "保存說明", {})),
    savedReminder: esc(文案(cfg, "存檔提醒", {})),
    saveLabel: esc(文案(cfg, "暫存按鈕", {})),
    submitLabel: esc(文案(cfg, "送出按鈕", {})),
    doneMsg: esc(文案(cfg, "送出後訊息", {})),
    recNote: esc(文案(cfg, "推薦說明", {})),
    uploadTip: esc(文案(cfg, "上傳說明", {})),
    fileList: 檔案.map((f) => `
      <div class="item ok">
        <div class="n">${esc(f.名稱)}</div>
        <div class="s">已上傳　·　<a href="https://drive.google.com/file/d/${
          esc(f.id)}/view" target="_blank" rel="noopener">看檔案</a></div>
      </div>`).join(""),
    sentClass: 已送 ? "sent" : "",
    savedNote: 已送 ? "" : esc(r.最後修改 ? `上次存檔　${r.最後修改}` : ""),
  });
}

// 主題一律讀即時。幹部剛開好就會馬上把連結貼出去，不能等快取
async function 找主題(env, 代碼) {
  const 列 = await 讀回饋(env, 分頁.主題).catch(() => []);
  const k = String(代碼 || "").trim();
  return 列.find((x) => String(x.主題代碼 || "").trim() === k) || null;
}

async function 記開啟(env, r) {
  try {
    const 欄 = await 標題索引(env);
    if (欄.開啟次數 == null) return;
    const n = parseInt(r.開啟次數, 10) || 0;
    await updateCell(env, 分頁.回饋, `${欄名(欄.開啟次數)}${r._row}`, n + 1, 表(env));
  } catch (e) {
    // 記次數失敗不該影響任何人讀他自己的回饋單
  }
}

// 欄名 → 第幾欄。readSheet 會把標題列吃掉，但寫回去要知道位置，
// 所以自己問一次 A1:Z1。記在模組變數裡，同一個 isolate 只問一次——
// 存草稿是每打字三秒就來一趟，這裡不能每次都多一個往返。
// 代價：有人在試算表裡搬動欄位後，要等 isolate 換掉才會跟上
let 標題快取 = null;
async function 標題索引(env) {
  if (標題快取) return 標題快取;
  const token = await getAccessToken(env);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.FEEDBACK_SHEET_ID}` +
    `/values/${encodeURIComponent(`${分頁.回饋}!A1:Z1`)}`;
  const data = await fetch(url, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  const 標題 = (data.values && data.values[0]) || [];
  const m = {};
  標題.forEach((h, i) => { const k = String(h).trim(); if (k) m[k] = i; });
  標題快取 = m;
  return m;
}

/* ── 存草稿／送出 ────────────────────────────────
   同一支 API。差別只在寫不寫「提交時間」跟狀態要變成什麼。
   使用者打字停三秒就會自動來一次，所以這裡要很便宜
   ──────────────────────────────────────────────── */

async function 存檔(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "只收 POST" }, 405);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "看不懂的內容" }, 400); }

  const code = String(body.代碼 || "").toLowerCase();
  if (!CODE_RE.test(code)) return json({ ok: false, error: "連結不正確" }, 400);

  const 送出 = body.模式 === "submit";

  try {
    const r = await 找回饋(env, code);
    if (!r) return json({ ok: false, error: "找不到這份回饋單" }, 404);
    if (r.狀態 === "已停用") return json({ ok: false, error: "這份回饋單已經關閉了" }, 403);

    const 欄 = await 標題索引(env);
    const 現在 = 台北時間();

    // 只寫「這次真的有送來」的欄位。填寫頁已經沒有聯絡方式了，
    // 要是還無條件寫空字串，會把幹部手動填在試算表上的電話洗掉
    const 要寫 = {
      最後修改: 現在,
      狀態: 送出 ? "已填寫" : (r.狀態 === "已填寫" || r.狀態 === "已完成" ? r.狀態 : "草稿"),
    };
    for (const k of ["心得內容", "填寫日期", "聯絡方式"]) {
      if (body[k] !== undefined) 要寫[k] = String(body[k]);
    }

    // 提交時間只記第一次。之後再修改不覆蓋，才看得出他原本什麼時候交的
    if (送出 && !String(r.提交時間 || "").trim()) 要寫.提交時間 = 現在;

    for (const [k, v] of Object.entries(要寫)) {
      if (欄[k] == null) continue;
      await updateCell(env, 分頁.回饋, `${欄名(欄[k])}${r._row}`, v, 表(env));
    }

    if (body.推薦) await 存推薦(env, code, body.推薦);

    return json({ ok: true, 時間: 現在.replace(/^.*?\s/, "") });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ── 推薦別人 ────────────────────────────────────
   這是整套系統會自己長大的地方：寫的人想起另一個人，
   幹部就多一份可以邀請的名單。

   只在「先儲存」和「送出」時才寫，自動存草稿不寫——
   打字停三秒就來一次的話，推薦分頁會被灌爆
   ──────────────────────────────────────────────── */

async function 存推薦(env, code, 清單) {
  const 要存 = (Array.isArray(清單) ? 清單 : [])
    .map((x) => ({
      被推薦人: String((x && x.被推薦人) || "").trim().slice(0, 40),
      推薦原因: String((x && x.推薦原因) || "").trim().slice(0, 500),
    }))
    .filter((x) => x.被推薦人);
  if (!要存.length) return;

  // 同一個人重複送出的時候不要一直長新列
  const 舊 = (await 讀回饋(env, 分頁.推薦).catch(() => []))
    .filter((r) => String(r.來自代碼 || "").toLowerCase() === code)
    .map((r) => String(r.被推薦人 || "").trim());

  for (const x of 要存) {
    if (舊.includes(x.被推薦人)) continue;
    await appendRow(env, 分頁.推薦, {
      來自代碼: code,
      被推薦人: x.被推薦人,
      推薦原因: x.推薦原因,
      處理狀態: "待處理",
      建單代碼: "",
      建立時間: 台北時間(),
    }, 表(env));
    舊.push(x.被推薦人);
  }
}

/* ── 留名建列 ────────────────────────────────────
   主題頁上按下第一個動作（存檔或上傳）時才會走到這裡。
   在那之前，這個人在系統裡完全不存在——
   點進來看看就離開的人，不該在試算表上留下一列空白
   ──────────────────────────────────────────────── */

async function 加入(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "只收 POST" }, 405);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "看不懂的內容" }, 400); }

  const 姓名 = String(body.姓名 || "").trim().slice(0, 40);
  if (!姓名) return json({ ok: false, error: "要先讓我們知道你是誰" }, 400);

  try {
    const t = await 找主題(env, body.主題);
    if (!t) return json({ ok: false, error: "找不到這個主題" }, 404);
    if (停用了(t.啟用)) return json({ ok: false, error: "這個主題已經結束收件了" }, 403);

    const 已用 = new Set((await 讀回饋(env, 分頁.回饋))
      .map((r) => String(r.代碼 || "").toLowerCase()));
    let 代碼 = 產生代碼();
    for (let i = 0; i < 5 && 已用.has(代碼); i++) 代碼 = 產生代碼();
    if (已用.has(代碼)) return json({ ok: false, error: "代碼一直撞號，再試一次" }, 500);

    await appendRow(env, 分頁.回饋, {
      代碼,
      信徒姓名: 姓名,
      稱呼: "",
      // 引言複製一份過來，不是每次去主題查。
      // 幹部之後改了主題的引言，已經寫過的人看到的還是他當初被問的那一句
      引言: t.引言 || "",
      指派人: t.建立人 || "",
      主題: t.主題代碼,
      狀態: "草稿",
      填寫日期: "",
      心得內容: "",
      檔案: "",
      聯絡方式: "",
      提交時間: "",
      最後修改: 台北時間(),
      開啟次數: 1,
    }, 表(env));

    return json({ ok: true, 代碼 });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ── 上傳 ────────────────────────────────────────
   檔案不經過 Worker。Worker 只跟 Drive 要一個 resumable 網址，
   瀏覽器自己 PUT 上去——影片動輒好幾百 MB，Worker 的請求上限是 100 MB，
   繞過去是唯一解，順便也不用替別人的影片付流量。

   要 Google 簽網址的時候一定要帶 Origin，簽出來的網址才肯接受
   從我們這個網域來的跨域 PUT。漏了這個 header，瀏覽器會被 CORS 擋下來
   ──────────────────────────────────────────────── */

async function 要上傳網址(request, env, url) {
  if (request.method !== "POST") return json({ ok: false, error: "只收 POST" }, 405);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "看不懂的內容" }, 400); }

  const code = String(body.代碼 || "").toLowerCase();
  if (!CODE_RE.test(code)) return json({ ok: false, error: "連結不正確" }, 400);

  try {
    const r = await 找回饋(env, code);
    if (!r) return json({ ok: false, error: "找不到這份回饋單" }, 404);
    if (r.狀態 === "已停用") return json({ ok: false, error: "這份回饋單已經關閉了" }, 403);

    const cfg = await 設定(env);
    const 上限 = (parseInt(文案(cfg, "單檔上限MB", {}), 10) || 500) * 1024 * 1024;
    const 大小 = Number(body.大小) || 0;
    if (大小 > 上限) {
      return json({ ok: false, error: `這個檔案 ${(大小 / 1048576).toFixed(0)} MB，超過 ${
        Math.round(上限 / 1048576)} MB 的上限` }, 413);
    }

    // 檔名前面掛上人名，資料夾裡才看得出誰是誰
    const 原名 = String(body.檔名 || "檔案").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
    const 檔名 = `${String(r.信徒姓名 || "").trim() || code}－${原名}`;
    const 型態 = String(body.型態 || "application/octet-stream").slice(0, 100);

    const token = await getAccessToken(env);
    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": 型態,
          "X-Upload-Content-Length": String(大小),
          // 少了這行，瀏覽器 PUT 上去會被 CORS 擋掉
          Origin: env.SITE_ORIGIN || url.origin,
        },
        body: JSON.stringify({ name: 檔名, parents: [env.FEEDBACK_FOLDER] }),
      }
    );

    const 網址 = res.headers.get("location");
    if (!res.ok || !網址) {
      const t = await res.text();
      return json({ ok: false, error: `要不到上傳網址 ${res.status}：${t.slice(0, 200)}` }, 502);
    }

    return json({ ok: true, 網址, 檔名 });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// 瀏覽器傳完之後回來把檔案 ID 記到回饋單上。
// 分成兩步是因為 Worker 根本沒看到那個檔案，只有瀏覽器知道傳完了沒
async function 記檔案(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "只收 POST" }, 405);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "看不懂的內容" }, 400); }

  const code = String(body.代碼 || "").toLowerCase();
  if (!CODE_RE.test(code)) return json({ ok: false, error: "連結不正確" }, 400);

  const 新增 = (Array.isArray(body.檔案) ? body.檔案 : [])
    .map((x) => String(x || "").trim())
    .filter((x) => /^[\w-]{25,}$/.test(x));
  if (!新增.length) return json({ ok: false, error: "沒有檔案" }, 400);

  try {
    const r = await 找回饋(env, code);
    if (!r) return json({ ok: false, error: "找不到這份回饋單" }, 404);

    const 欄 = await 標題索引(env);
    if (欄.檔案 == null) return json({ ok: false, error: "試算表沒有「檔案」這一欄" }, 500);

    const 舊 = String(r.檔案 || "").split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    const 全部 = [...new Set([...舊, ...新增])];

    await updateCell(env, 分頁.回饋, `${欄名(欄.檔案)}${r._row}`, 全部.join(","), 表(env));
    if (欄.最後修改 != null) {
      await updateCell(env, 分頁.回饋, `${欄名(欄.最後修改)}${r._row}`, 台北時間(), 表(env));
    }
    return json({ ok: true, 共: 全部.length });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ── 維護介面 ────────────────────────────────────
   跟邀請卡的 admin 一樣不設驗證：網址不好猜，而且
   預設什麼都不列——一定要先指定指派人或打名字才看得到人。
   真正敏感的心得內容再包一層，要按「看內容」才展開
   ──────────────────────────────────────────────── */

async function 維護頁(url, env) {
  const 站台 = env.SITE_ORIGIN || url.origin;
  const 全部 = await 讀回饋(env, 分頁.回饋);

  const 指派人們 = [...全部.reduce((m, r) => {
    const n = String(r.指派人 || "").trim();
    if (n) m.set(n, (m.get(n) || 0) + 1);
    return m;
  }, new Map())].sort((a, b) => b[1] - a[1]);

  const by = String(url.searchParams.get("by") || "").trim();
  const q = String(url.searchParams.get("q") || "").trim();
  const topic = String(url.searchParams.get("topic") || "").trim();

  // 網址上帶了什麼，就決定打開時停在哪一個頁籤
  const 頁籤 = topic || url.searchParams.get("tab") === "topic" ? "topic" : "solo";
  const 主題的 = 頁籤 === "topic";
  const 剛建 = String(url.searchParams.get("new") || "").trim().toLowerCase();

  // 沒指定就什麼都不列。這一頁上的每一列都是某個人的名字
  let 列 = [];
  if (topic) 列 = 全部.filter((r) => String(r.主題 || "").trim() === topic);
  else if (by) 列 = 全部.filter((r) => String(r.指派人 || "").trim() === by);
  else if (q) 列 = 全部.filter((r) => String(r.信徒姓名 || "").includes(q) ||
                                     String(r.稱呼 || "").includes(q));

  const [cfg, 推薦列, 主題列] = await Promise.all([
    設定(env, { 即時: true }),
    讀回饋(env, 分頁.推薦).catch(() => []),
    讀回饋(env, 分頁.主題).catch(() => []),
  ]);

  // 每個主題收到幾份，chip 上直接看得到
  const 主題數 = 全部.reduce((m, r) => {
    const k = String(r.主題 || "").trim();
    if (k) m.set(k, (m.get(k) || 0) + 1);
    return m;
  }, new Map());

  const 待處理 = 推薦列.filter((r) => (r.處理狀態 || "待處理") === "待處理" && r.被推薦人);
  const 攤開 = url.searchParams.get("rec") === "1";

  // 只查「這次真的要顯示」的那幾列。沒有查詢就是零列，
  // 不會因為打開維護頁就去問一整個資料夾
  const 要顯示 = 列.filter((r) => r.代碼);
  const 附件們 = await Promise.all(要顯示.map((r) => 檔案清單(env, r.檔案)));

  // 誰推薦了幾個人，順手算一算——推薦分頁上面已經讀進來了，不用多問一次
  const 推薦數 = 推薦列.reduce((m, x) => {
    const k = String(x.來自代碼 || "").toLowerCase();
    if (k && x.被推薦人) m.set(k, (m.get(k) || 0) + 1);
    return m;
  }, new Map());

  const rows = 要顯示
    .map((r, i) => 一列(r, 站台, cfg, 剛建, 附件們[i], 推薦數.get(r.代碼.toLowerCase()) || 0))
    .join("");

  const 結果 = 列.length
    ? rows
    : `<div class="box"><div class="empty">${
        by || q || topic
          ? "這裡還沒有回饋單"
          : (主題的 ? "選一個主題，看大家寫了什麼" : "先選一個指派人，或打姓名來查")
      }</div></div>`;

  return new Response(fill(FADMIN_HTML, {
    tab: 頁籤,
    soloCount: String(全部.filter((r) => !String(r.主題 || "").trim()).length || ""),
    topicCount: String(主題列.filter((t) => String(t.主題代碼 || "").trim()).length || ""),
    soloRows: 主題的 ? "" : 結果,
    topicRows: 主題的 ? 結果 : "",
    recBox: 待處理.length
      ? (攤開
          ? `<div class="box"><h2>信徒推薦的人（${待處理.length}）</h2>${
              待處理.map((r) => 推薦一列(r)).join("")
            }</div>`
          : `<div class="box"><h2>信徒推薦的人</h2><div class="empty">有 ${
              待處理.length
            } 位等著處理。<a href="/f/admin?rec=1${
              by ? `&by=${encodeURIComponent(by)}` : ""
            }">攤開來看</a></div></div>`)
      : "",
    lastBy: esc(by),
    byOptions: 指派人們.map(([n]) => `<option value="${esc(n)}">`).join(""),
    byChips: 指派人們.map(([n, c]) =>
      `<a class="chip${n === by ? " on" : ""}" href="/f/admin?by=${encodeURIComponent(n)}">${esc(n)}</a>`
    ).join("") || `<span class="empty">還沒有任何回饋單</span>`,
    q: esc(q),
    topicChips: 主題列.length
      ? 主題列.map((t) => {
          const k = String(t.主題代碼 || "").trim();
          if (!k) return "";
          const n = 主題數.get(k) || 0;
          return `<a class="chip${k === topic ? " on" : ""}" href="/f/admin?topic=${
            encodeURIComponent(k)}">${esc(k)}${n ? `　${n}` : ""}${
            停用了(t.啟用) ? "　（已結束）" : ""}</a>`;
        }).join("")
      : `<span class="empty">還沒有主題</span>`,
    topicBar: topic
      ? `<div class="box"><h2>${esc(topic)}${
             停用了((主題列.find((x) => String(x.主題代碼 || "").trim() === topic) || {}).啟用)
               ? `　<span class="pill dead">已結束收件</span>` : ""
           }</h2>
           <div class="url">${esc(`${站台}/f/t/${topic}`)}</div>
           <div class="acts">
             <a class="btn" href="/f/read?topic=${encodeURIComponent(topic)}">一次讀完</a>
             <button type="button" data-copy="${esc(`${站台}/f/t/${encodeURIComponent(topic)}`)}">複製連結</button>
             <a class="btn" href="https://line.me/R/share?text=${
               encodeURIComponent(文案(cfg, "主題訊息", {
                 引言: (主題列.find((x) => String(x.主題代碼 || "").trim() === topic) || {}).引言 || "",
                 網址: `${站台}/f/t/${encodeURIComponent(topic)}`,
               }))
             }" target="_blank" rel="noopener">用 LINE 傳</a>
             ${停用了((主題列.find((x) => String(x.主題代碼 || "").trim() === topic) || {}).啟用)
               ? `<button type="button" data-topic="${esc(topic)}" data-on="是">重新開放</button>`
               : `<button type="button" data-topic="${esc(topic)}" data-on="否">結束收件</button>`}
           </div></div>`
      : "",
  }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function 一列(r, 站台, cfg, 剛建, 附件 = [], 推薦 = 0) {
  const 網址 = `${站台}/f/${r.代碼}`;
  const 叫他 = String(r.稱呼 || "").trim();
  const 狀態 = r.狀態 || "草稿";
  const 停用了 = 狀態 === "已停用";
  const 有內容 = String(r.心得內容 || "").trim();

  const 類 = 停用了 ? "dead" : (狀態 === "已完成" ? "done" : (狀態 === "已填寫" ? "done" : "wait"));

  const 訊息 = 文案(cfg, "LINE訊息", {
    對象: 叫他 || r.信徒姓名,
    對象全稱: 叫他 || r.信徒姓名,
    指派人: r.指派人 || "",
    網址,
  });

  const 字數 = 有內容 ? `${有內容.length} 字` : "還沒寫";
  const 次數 = Number(r.開啟次數) || 0;

  return `
  <div class="card${停用了 ? " off" : ""}${r.代碼.toLowerCase() === 剛建 ? " new" : ""}">
    <div class="top">
      <span class="who">${esc(r.信徒姓名)}</span>
      ${叫他 ? `<span class="pill">叫他「${esc(叫他)}」</span>` : ""}
      <span class="pill ${類}">${esc(狀態)}</span>
      ${次數 ? `<span class="pill">開啟 ${次數} 次</span>` : ""}
      ${推薦 ? `<span class="pill">推薦了 ${推薦} 人</span>` : ""}
      ${r.主題 ? `<span class="pill">${esc(r.主題)}</span>` : ""}
    </div>

    <div class="ask">${連結化(r.引言 || "")}</div>

    <div class="meta">${esc(字數)}${
      r.最後修改 ? `　·　最後存檔 ${esc(r.最後修改)}` : ""
    }${r.提交時間 ? `　·　送出 ${esc(r.提交時間)}` : ""}${
      r.聯絡方式 ? `　·　${esc(r.聯絡方式)}` : ""
    }</div>

    ${有內容 ? `<div class="body" id="body-${esc(r.代碼)}">${esc(有內容)}</div>` : ""}

    ${附件.length ? `<div class="files">${附件.map((f) => `
      <a class="file" href="https://drive.google.com/file/d/${esc(f.id)}/view"
         target="_blank" rel="noopener">
        <span class="kind">${esc(檔案種類(f.類型))}</span>
        <span class="fname">${esc(f.名稱)}</span>
      </a>`).join("")}</div>` : ""}

    <div class="url">${esc(網址)}</div>

    <div class="acts">
      ${有內容 ? `<button type="button" data-open="${esc(r.代碼)}">看內容</button>` : ""}
      <a class="btn" href="${esc(網址)}" target="_blank" rel="noopener">開啟</a>
      <button type="button" data-copy="${esc(網址)}">複製連結</button>
      <a class="btn" href="https://line.me/R/share?text=${
        encodeURIComponent(訊息)
      }" target="_blank" rel="noopener">用 LINE 傳</a>
      ${狀態 === "已填寫" ? `<button type="button" data-code="${esc(r.代碼)}" data-status="已完成">標記完成</button>` : ""}
      ${停用了
        ? `<button type="button" data-code="${esc(r.代碼)}" data-status="草稿">重新啟用</button>`
        : `<button type="button" data-code="${esc(r.代碼)}" data-status="已停用">停用</button>`}
    </div>
  </div>`;
}

function 推薦一列(r) {
  return `
  <div class="card">
    <div class="top">
      <span class="who">${esc(r.被推薦人)}</span>
      <span class="pill wait">待處理</span>
    </div>
    ${r.推薦原因 ? `<div class="ask">${esc(r.推薦原因)}</div>` : ""}
    <div class="meta">${esc(r.建立時間 || "")}</div>
    <div class="acts">
      <button type="button" data-rec="${r._row}" data-name="${esc(r.被推薦人)}"
              data-why="${esc(r.推薦原因 || "")}">建回饋單給他</button>
      <button type="button" data-skip="${r._row}">略過</button>
    </div>
  </div>`;
}

/* ── 閱讀頁 ──────────────────────────────────────
   一個主題底下所有回覆，從頭讀到尾。
   維護頁是「處理」用的，一列一列；這一頁是「讀」用的，
   長執要坐下來一次看完十幾份，那是完全不同的動作
   ──────────────────────────────────────────────── */

async function 閱讀頁(url, env) {
  const 代碼 = String(url.searchParams.get("topic") || "").trim();
  if (!代碼) return null;

  const [t, 全部] = await Promise.all([
    找主題(env, 代碼),
    讀回饋(env, 分頁.回饋),
  ]);

  const 列 = 全部
    .filter((r) => String(r.主題 || "").trim() === 代碼)
    .sort((a, b) => String(a.提交時間 || a.最後修改 || "").localeCompare(
                    String(b.提交時間 || b.最後修改 || "")));

  const 附件們 = await Promise.all(列.map((r) => 檔案清單(env, r.檔案)));

  const 有寫的 = 列.filter((r) => String(r.心得內容 || "").trim() || String(r.檔案 || "").trim());
  const 字數 = 列.reduce((n, r) => n + String(r.心得內容 || "").trim().length, 0);

  const items = 列.length
    ? 列.map((r, i) => {
        const 內容 = String(r.心得內容 || "").trim();
        const 檔案 = 附件們[i];
        return `
  <div class="one">
    <div class="who">${esc(String(r.稱呼 || "").trim() || r.信徒姓名)}</div>
    <div class="when">${esc(r.提交時間 ? `送出 ${r.提交時間}` : (r.最後修改 ? `尚未送出　最後存檔 ${r.最後修改}` : "尚未送出"))}${
      r.填寫日期 ? `　·　談的是 ${esc(r.填寫日期)}` : ""
    }</div>
    <div class="text${內容 ? "" : " none"}">${esc(內容 || "（還沒寫文字）")}</div>
    ${檔案.length ? `<div class="files">${檔案.map((f) => `
      <a class="file" href="https://drive.google.com/file/d/${esc(f.id)}/view"
         target="_blank" rel="noopener">
        <span class="kind">${esc(檔案種類(f.類型))}</span>
        <span class="fname">${esc(f.名稱)}</span>
      </a>`).join("")}</div>` : ""}
  </div>`;
      }).join("")
    : `<div class="empty">這個主題還沒有人回覆</div>`;

  return new Response(fill(FREAD_HTML, {
    title: esc(`${代碼}　說說主的恩典`),
    ask: 連結化((t && t.引言) || 代碼),
    summary: esc(
      `${代碼}　·　${列.length} 個人開了　·　${有寫的.length} 個人寫了東西` +
      (字數 ? `　·　共 ${字數} 字` : "")
    ),
    items,
  }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ── 維護介面的 API ─────────────────────────────── */

async function 維護API(動作, request, url, env) {
  if (request.method !== "POST") return json({ ok: false, error: "只收 POST" }, 405);

  try {
    const body = await request.json();
    if (動作 === "new") return await 建立回饋單(body, env, url);
    if (動作 === "status") return await 改狀態(body, env);
    if (動作 === "skip") return await 跳過推薦(body, env);
    if (動作 === "setup") return await 補結構(env);
    if (動作 === "topic") return await 建立主題(body, env, url);
    if (動作 === "topic-on") return await 開關主題(body, env);
    return json({ ok: false, error: "不認得的動作" }, 404);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

async function 建立回饋單(body, env, url) {
  const 姓名 = String(body.信徒姓名 || "").trim();
  const 引言 = String(body.引言 || "").trim();
  if (!姓名) return json({ ok: false, error: "要填姓名" }, 400);
  if (!引言) return json({ ok: false, error: "要填引言" }, 400);

  const 已用 = new Set((await 讀回饋(env, 分頁.回饋))
    .map((r) => String(r.代碼 || "").toLowerCase()));

  let 代碼 = 產生代碼();
  for (let i = 0; i < 5 && 已用.has(代碼); i++) 代碼 = 產生代碼();
  if (已用.has(代碼)) return json({ ok: false, error: "代碼一直撞號，再按一次" }, 500);

  await appendRow(env, 分頁.回饋, {
    代碼,
    信徒姓名: 姓名,
    稱呼: String(body.稱呼 || "").trim(),
    引言,
    指派人: String(body.指派人 || "").trim(),
    狀態: "已發送",
    填寫日期: "",
    心得內容: "",
    檔案: "",
    聯絡方式: "",
    提交時間: "",
    最後修改: 台北時間(),
    開啟次數: 0,
  }, 表(env));

  // 從推薦來的，把那一列標記掉，幹部才不會重複建
  const 列號 = parseInt(body.推薦列, 10);
  if (列號 > 1) {
    try {
      const 欄 = await 標題索引推薦(env);
      if (欄.處理狀態 != null) {
        await updateCell(env, 分頁.推薦, `${欄名(欄.處理狀態)}${列號}`, "已建單", 表(env));
      }
      if (欄.建單代碼 != null) {
        await updateCell(env, 分頁.推薦, `${欄名(欄.建單代碼)}${列號}`, 代碼, 表(env));
      }
    } catch (e) {
      // 標記失敗不影響回饋單已經建好這件事
    }
  }

  const 站台 = env.SITE_ORIGIN || url.origin;
  return json({ ok: true, 代碼, 網址: `${站台}/f/${代碼}` });
}

/* ── 補結構 ────────────────────────────────────────
   跟邀請卡的 setup 同一個用意：試算表少了分頁或欄位，
   叫這一支補起來，不用手動開。做幾次都一樣，不會重複加
   ──────────────────────────────────────────────── */

async function 建立主題(body, env, url) {
  const 引言 = String(body.引言 || "").trim();
  if (!引言) return json({ ok: false, error: "要填引言" }, 400);

  // 代碼是人看得懂的字，跟邀請卡的活動代號同一套想法——
  // 在試算表上一眼認得出這是哪一場，不是一串亂碼
  let 代碼 = String(body.主題代碼 || "").trim().replace(/[\\/:*?"<>|#]/g, "").slice(0, 40);
  if (!代碼) 代碼 = `${台北日期().slice(2).replace(/-/g, "")}-${引言.slice(0, 8)}`;

  const 已有 = await 找主題(env, 代碼);
  if (已有) return json({ ok: false, error: `已經有一個叫「${代碼}」的了，換個名稱` }, 409);

  await appendRow(env, 分頁.主題, {
    主題代碼: 代碼,
    引言,
    建立人: String(body.建立人 || "").trim(),
    啟用: "是",
    建立時間: 台北時間(),
  }, 表(env));

  const 站台 = env.SITE_ORIGIN || url.origin;
  return json({ ok: true, 主題代碼: 代碼, 網址: `${站台}/f/t/${encodeURIComponent(代碼)}` });
}

// 聚會結束了就把主題關掉。已經寫的人不受影響，只是不再收新的
async function 開關主題(body, env) {
  const 代碼 = String(body.主題代碼 || "").trim();
  const 開 = String(body.啟用 || "").trim() === "是" ? "是" : "否";

  const t = await 找主題(env, 代碼);
  if (!t) return json({ ok: false, error: "找不到這個主題" }, 404);

  const 標題 = await 讀標題(env, 分頁.主題);
  const i = 標題.indexOf("啟用");
  if (i < 0) return json({ ok: false, error: "主題分頁沒有「啟用」這一欄" }, 500);

  await updateCell(env, 分頁.主題, `${欄名(i)}${t._row}`, 開, 表(env));
  return json({ ok: true, 啟用: 開 });
}

async function 補結構(env) {
  const token = await getAccessToken(env);
  const 表ID = env.FEEDBACK_SHEET_ID;
  const 做了 = [];

  // 有哪些分頁
  const 資訊 = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${表ID}?fields=sheets.properties.title`,
    { headers: { authorization: `Bearer ${token}` } }
  ).then((r) => r.json());
  const 現有 = new Set((資訊.sheets || []).map((x) => x.properties.title));

  if (!現有.has(分頁.主題)) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${表ID}:batchUpdate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: 分頁.主題 } } }] }),
    }).then((r) => r.json());
    做了.push(`建了分頁「${分頁.主題}」`);
  }

  // 主題分頁的標題列
  const 主題標題 = ["主題代碼", "引言", "建立人", "啟用", "建立時間"];
  const 現標題 = await 讀標題(env, 分頁.主題);
  if (!現標題.length) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${表ID}/values/` +
      `${encodeURIComponent(`${分頁.主題}!A1`)}?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ values: [主題標題] }),
      }
    );
    做了.push("寫了主題分頁的標題列");
  }

  // 回饋單多一欄「主題」。同一場聚會的回覆靠它認親
  const 回饋標題 = await 讀標題(env, 分頁.回饋);
  if (!回饋標題.includes("主題")) {
    const 位置 = 回饋標題.length;
    await updateCell(env, 分頁.回饋, `${欄名(位置)}1`, "主題", 表(env));
    做了.push(`回饋單加了「主題」欄（${欄名(位置)}）`);
    標題快取 = null;   // 欄位變了，記在模組裡的位置就過期了
  }

  if (env.CACHE) await env.CACHE.delete("fcfg:v1");
  return json({ ok: true, 做了: 做了.length ? 做了 : ["都已經有了，沒事可做"] });
}

async function 讀標題(env, tab) {
  const token = await getAccessToken(env);
  const data = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.FEEDBACK_SHEET_ID}` +
    `/values/${encodeURIComponent(`${tab}!A1:Z1`)}`,
    { headers: { authorization: `Bearer ${token}` } }
  ).then((r) => r.json());
  return ((data.values && data.values[0]) || []).map((h) => String(h).trim()).filter(Boolean);
}

async function 跳過推薦(body, env) {
  const 列號 = parseInt(body.列, 10);
  if (!(列號 > 1)) return json({ ok: false, error: "列號不正確" }, 400);
  const 欄 = await 標題索引推薦(env);
  if (欄.處理狀態 == null) return json({ ok: false, error: "推薦分頁沒有「處理狀態」這一欄" }, 500);
  await updateCell(env, 分頁.推薦, `${欄名(欄.處理狀態)}${列號}`, "略過", 表(env));
  return json({ ok: true });
}

// 推薦分頁的標題列。跟回饋單那份一樣的道理，記在模組變數裡
let 推薦標題快取 = null;
async function 標題索引推薦(env) {
  if (推薦標題快取) return 推薦標題快取;
  const token = await getAccessToken(env);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.FEEDBACK_SHEET_ID}` +
    `/values/${encodeURIComponent(`${分頁.推薦}!A1:Z1`)}`;
  const data = await fetch(url, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  const m = {};
  ((data.values && data.values[0]) || []).forEach((h, i) => {
    const k = String(h).trim(); if (k) m[k] = i;
  });
  推薦標題快取 = m;
  return m;
}

async function 改狀態(body, env) {
  const code = String(body.代碼 || "").toLowerCase();
  const 新狀態 = String(body.狀態 || "").trim();
  if (!CODE_RE.test(code)) return json({ ok: false, error: "代碼不正確" }, 400);
  if (!["草稿", "已發送", "已填寫", "已完成", "已停用"].includes(新狀態)) {
    return json({ ok: false, error: "不認得的狀態" }, 400);
  }

  const r = await 找回饋(env, code);
  if (!r) return json({ ok: false, error: "找不到這份回饋單" }, 404);

  const 欄 = await 標題索引(env);
  if (欄.狀態 == null) return json({ ok: false, error: "試算表沒有「狀態」這一欄" }, 500);
  await updateCell(env, 分頁.回饋, `${欄名(欄.狀態)}${r._row}`, 新狀態, 表(env));
  return json({ ok: true });
}

/* ── 路由 ────────────────────────────────────────
   路徑已經去掉開頭的 f/。回 null 表示「不是我的」，
   讓 index.js 去給 404
   ──────────────────────────────────────────────── */

export async function 回饋路由(路徑, request, url, env, ctx) {
  if (路徑 === "api/save") return 存檔(request, env);
  if (路徑 === "api/join") return 加入(request, env);
  if (路徑 === "api/upload-url") return 要上傳網址(request, env, url);
  if (路徑 === "api/attach") return 記檔案(request, env);

  // 主題的公開連結。代碼是人看得懂的字，可能有中文
  if (路徑.startsWith("t/")) {
    return 主題頁(解碼(路徑.slice(2)), request, env, ctx);
  }

  if (路徑 === "admin") return 維護頁(url, env);
  if (路徑 === "read") return 閱讀頁(url, env);
  if (路徑.startsWith("admin/api/")) return 維護API(路徑.slice(10), request, url, env);

  const code = 路徑.toLowerCase();
  if (CODE_RE.test(code)) return 填寫頁(code, request, env, ctx);

  return null;
}
