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
      return { id, 名稱: r.name || id };
    } catch (e) {
      return { id, 名稱: id };   // 問不到就顯示 ID，總比整頁壞掉好
    }
  }));
}


async function 填寫頁(code, request, env, ctx) {
  const [r, cfg] = await Promise.all([找回饋(env, code), 設定(env)]);
  if (!r || r.狀態 === "已停用") return null;

  const 檔案 = await 檔案清單(env, r.檔案);

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
    recNote: esc(文案(cfg, "推薦說明", {})),
    uploadTip: esc(`單一檔案最多 ${文案(cfg, "單檔上限MB", {}) || 500} MB。選好就會開始傳，不用等按送出`),
    fileList: 檔案.map((f) => `
      <div class="item ok">
        <div class="n">${esc(f.名稱)}</div>
        <div class="s">已上傳　·　<a href="https://drive.google.com/file/d/${
          esc(f.id)}/view" target="_blank" rel="noopener">看檔案</a></div>
      </div>`).join(""),
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
  const 剛建 = String(url.searchParams.get("new") || "").trim().toLowerCase();

  // 沒指定就什麼都不列。這一頁上的每一列都是某個人的名字
  let 列 = [];
  if (by) 列 = 全部.filter((r) => String(r.指派人 || "").trim() === by);
  else if (q) 列 = 全部.filter((r) => String(r.信徒姓名 || "").includes(q) ||
                                     String(r.稱呼 || "").includes(q));

  const [cfg, 推薦列] = await Promise.all([
    設定(env, { 即時: true }),
    讀回饋(env, 分頁.推薦).catch(() => []),
  ]);

  const 待處理 = 推薦列.filter((r) => (r.處理狀態 || "待處理") === "待處理" && r.被推薦人);
  const 攤開 = url.searchParams.get("rec") === "1";

  const rows = 列.filter((r) => r.代碼).map((r) => 一列(r, 站台, cfg, 剛建)).join("");

  const 結果 = 列.length
    ? rows
    : `<div class="box"><div class="empty">${
        by || q ? "這裡還沒有回饋單" : "先選一個指派人，或打信徒姓名來查"
      }</div></div>`;

  return new Response(fill(FADMIN_HTML, {
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
      <button type="button" data-skip="${r._row}">先不處理</button>
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
    if (動作 === "skip") return await 跳過推薦(body, env);
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

async function 跳過推薦(body, env) {
  const 列號 = parseInt(body.列, 10);
  if (!(列號 > 1)) return json({ ok: false, error: "列號不正確" }, 400);
  const 欄 = await 標題索引推薦(env);
  if (欄.處理狀態 == null) return json({ ok: false, error: "推薦分頁沒有「處理狀態」這一欄" }, 500);
  await updateCell(env, 分頁.推薦, `${欄名(欄.處理狀態)}${列號}`, "不處理", 表(env));
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
  if (路徑 === "api/upload-url") return 要上傳網址(request, env, url);
  if (路徑 === "api/attach") return 記檔案(request, env);

  if (路徑 === "admin") return 維護頁(url, env);
  if (路徑.startsWith("admin/api/")) return 維護API(路徑.slice(10), request, url, env);

  const code = 路徑.toLowerCase();
  if (CODE_RE.test(code)) return 填寫頁(code, request, env, ctx);

  return null;
}
