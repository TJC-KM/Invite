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
import { readSheet, updateCell, appendRow, getAccessToken } from "./google.js";
import { fill, esc, json, isPreviewBot, 欄名, 產生代碼, 台北時間, 台北日期, 代入 } from "./lib.js";

const 分頁 = { 回饋: "回饋單", 推薦: "推薦", 設定: "設定檔" };
const CODE_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/;

// 填寫頁不快取。使用者按了「先儲存」，回頭重整卻看到舊內容，
// 那一秒他會以為東西不見了——這種驚嚇比多讀一次試算表貴得多
const 設定快取秒 = 120;

/* ── 文案 ────────────────────────────────────────
   全部走設定檔分頁，改字不用改程式。沒建分頁、
   或某一則沒填，就用這裡的預設值
   ──────────────────────────────────────────────── */

const 預設文案 = {
  頁首標題: "心得回饋",
  心得提示: "想到什麼就寫什麼，長短都可以",
  保存說明: "你的分享教會會妥善保存。若有機會用在見證或刊物，一定會先跟你本人聯絡。",
  推薦說明: "還有誰的經歷讓你印象深刻？我們可以也去邀請他分享",
  送出按鈕: "送出",
  暫存按鈕: "先儲存",
  送出後訊息: "謝謝你的分享 🙏",
  單檔上限MB: "500",
  LINE訊息: "{對象全稱}平安，想邀請你寫一段心得：\n{網址}",
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

async function 填寫頁(code, request, env, ctx) {
  const [r, cfg] = await Promise.all([找回饋(env, code), 設定(env)]);
  if (!r || r.狀態 === "已停用") return null;

  const 稱呼 = String(r.稱呼 || "").trim() || String(r.信徒姓名 || "").trim();
  const 已送 = r.狀態 === "已填寫" || r.狀態 === "已完成";

  const html = fill(FEEDBACK_HTML, {
    code: esc(code),
    pageTitle: esc(文案(cfg, "頁首標題", {})),
    churchEn: esc(env.CHURCH_NAME_EN || "TRUE JESUS CHURCH"),
    churchZh: esc(env.CHURCH_NAME || "真耶穌教會　黎明教會"),
    churchSite: esc(env.CHURCH_SITE || "https://li-ming-tjc.org"),
    greet: esc(稱呼 ? `${稱呼}平安` : "平安"),
    prompt: esc(r.引言 || "說說看你最近的感動"),
    promptFrom: esc(r.指派人 ? `— ${r.指派人}　邀請你寫的` : ""),
    date: esc(r.填寫日期 || 台北日期()),
    content: esc(r.心得內容 || ""),
    contact: esc(r.聯絡方式 || ""),
    hint: esc(文案(cfg, "心得提示", {})),
    keepNote: esc(文案(cfg, "保存說明", {})),
    saveLabel: esc(文案(cfg, "暫存按鈕", {})),
    submitLabel: esc(文案(cfg, "送出按鈕", {})),
    doneMsg: esc(文案(cfg, "送出後訊息", {})),
    sentClass: 已送 ? "sent" : "",
    savedNote: 已送 ? "" : esc(r.最後修改 ? `上次存檔　${r.最後修改}` : ""),
  });

  if (!isPreviewBot(request.headers.get("user-agent"))) {
    ctx.waitUntil(記開啟(env, r));
  }

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
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

    const 要寫 = {
      心得內容: String(body.心得內容 ?? ""),
      填寫日期: String(body.填寫日期 ?? ""),
      聯絡方式: String(body.聯絡方式 ?? ""),
      最後修改: 現在,
      狀態: 送出 ? "已填寫" : (r.狀態 === "已填寫" || r.狀態 === "已完成" ? r.狀態 : "草稿"),
    };
    // 提交時間只記第一次。之後再修改不覆蓋，才看得出他原本什麼時候交的
    if (送出 && !String(r.提交時間 || "").trim()) 要寫.提交時間 = 現在;

    for (const [k, v] of Object.entries(要寫)) {
      if (欄[k] == null) continue;
      await updateCell(env, 分頁.回饋, `${欄名(欄[k])}${r._row}`, v, 表(env));
    }

    return json({ ok: true, 時間: 現在.replace(/^.*?\s/, "") });
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
  const 剛建 = String(url.searchParams.get("new") || "").trim().toLowerCase();

  // 沒指定就什麼都不列。這一頁上的每一列都是某個人的名字
  let 列 = [];
  if (by) 列 = 全部.filter((r) => String(r.指派人 || "").trim() === by);
  else if (q) 列 = 全部.filter((r) => String(r.信徒姓名 || "").includes(q) ||
                                     String(r.稱呼 || "").includes(q));

  const cfg = await 設定(env, { 即時: true });

  const rows = 列.filter((r) => r.代碼).map((r) => 一列(r, 站台, cfg, 剛建)).join("");

  const 結果 = 列.length
    ? rows
    : `<div class="box"><div class="empty">${
        by || q ? "這裡還沒有回饋單" : "先選一個指派人，或打信徒姓名來查"
      }</div></div>`;

  return new Response(fill(FADMIN_HTML, {
    lastBy: esc(by),
    byOptions: 指派人們.map(([n]) => `<option value="${esc(n)}">`).join(""),
    byChips: 指派人們.map(([n, c]) =>
      `<a class="chip${n === by ? " on" : ""}" href="/f/admin?by=${encodeURIComponent(n)}">${esc(n)}</a>`
    ).join("") || `<span class="empty">還沒有任何回饋單</span>`,
    q: esc(q),
    rows: 結果,
  }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function 一列(r, 站台, cfg, 剛建) {
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
    </div>

    <div class="ask">${esc(r.引言 || "")}</div>

    <div class="meta">${esc(字數)}${
      r.最後修改 ? `　·　最後存檔 ${esc(r.最後修改)}` : ""
    }${r.提交時間 ? `　·　送出 ${esc(r.提交時間)}` : ""}${
      r.聯絡方式 ? `　·　${esc(r.聯絡方式)}` : ""
    }</div>

    ${有內容 ? `<div class="body" id="body-${esc(r.代碼)}">${esc(有內容)}</div>` : ""}

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

/* ── 維護介面的 API ─────────────────────────────── */

async function 維護API(動作, request, url, env) {
  if (request.method !== "POST") return json({ ok: false, error: "只收 POST" }, 405);

  try {
    const body = await request.json();
    if (動作 === "new") return await 建立回饋單(body, env, url);
    if (動作 === "status") return await 改狀態(body, env);
    return json({ ok: false, error: "不認得的動作" }, 404);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

async function 建立回饋單(body, env, url) {
  const 姓名 = String(body.信徒姓名 || "").trim();
  const 引言 = String(body.引言 || "").trim();
  if (!姓名) return json({ ok: false, error: "要填信徒姓名" }, 400);
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

  const 站台 = env.SITE_ORIGIN || url.origin;
  return json({ ok: true, 代碼, 網址: `${站台}/f/${代碼}` });
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

  if (路徑 === "admin") return 維護頁(url, env);
  if (路徑.startsWith("admin/api/")) return 維護API(路徑.slice(10), request, url, env);

  const code = 路徑.toLowerCase();
  if (CODE_RE.test(code)) return 填寫頁(code, request, env, ctx);

  return null;
}
