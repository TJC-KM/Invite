// 邀請卡 Worker —— 公開路徑的骨架
//
// HTML 不寫在這個檔案裡。card.html 是用 import 進來的純文字，
// 這樣裡面有多少反引號、${}、引號都不會影響 JS。

import CARD_HTML from "./card.html";
import NOTFOUND_HTML from "./notfound.html";
import LIST_HTML from "./list.html";
import { readSheet, updateCell, listFolder, fetchFile, fileMeta, getAccessToken } from "./google.js";

const CODE_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    if (path === "") {
      return Response.redirect(env.CHURCH_SITE || "https://li-ming-tjc.org", 302);
    }

    if (path.startsWith("img/")) {
      return imageProxy(path.slice(4), env, ctx);
    }

    // 暫時的自我診斷。要帶 DEBUG_TOKEN 才進得去，B6 驗完就刪掉
    if (path === "debug") return debug(url, env);

    // 發送用的名單頁。同樣要帶金鑰——這頁看得到所有人的連結，
    // 等 Cloudflare Access 上線（E4）就改成正式的 /admin
    if (path === "list") return listPage(url, env);

    const code = path.toLowerCase();
    if (!CODE_RE.test(code)) return notFound();

    const invite = await loadInvite(code, env);
    if (!invite || invite.狀態 === "已停用") return notFound();

    const html = renderCard(invite, env);

    // 開啟次數：回應送出之後才寫，訪客不用等（規格第 3 節）
    if (!isPreviewBot(request.headers.get("user-agent"))) {
      ctx.waitUntil(countOpen(code, invite, env));
    }

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};

/* ────────────────────────────────────────────────
   資料層　—— 試算表是資料的家，KV 是它前面那層快取
   ──────────────────────────────────────────────── */

const 分頁 = { 邀請: "邀請名單", 活動: "活動", 模板: "信件模板", 附件: "附件" };
const CACHE_TTL = 300; // 秒。直接改試算表最多五分鐘生效

// 「否」才算停用，空白一律當啟用——欄位沒填不該讓東西消失
const 有效 = (v) => String(v ?? "").trim() !== "否";
const 逗號 = (v) => String(v ?? "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);

async function loadInvite(code, env) {
  const key = `inv:${code}`;
  if (env.CACHE) {
    const hit = await env.CACHE.get(key, "json");
    if (hit) return hit;
  }

  const [邀請列, 設定] = await Promise.all([
    readSheet(env, 分頁.邀請),
    loadConfig(env),
  ]);

  const r = 邀請列.find((x) => String(x.代碼 || "").toLowerCase() === code);
  if (!r) return null;

  const invite = 組合(r, 設定);
  if (env.CACHE) {
    await env.CACHE.put(key, JSON.stringify(invite), { expirationTtl: CACHE_TTL });
  }
  return invite;
}

// 活動、模板、附件三張表一起快取。它們被所有邀請共用
async function loadConfig(env) {
  if (env.CACHE) {
    const hit = await env.CACHE.get("cfg:v1", "json");
    if (hit) return hit;
  }

  const [活動, 模板, 附件] = await Promise.all([
    readSheet(env, 分頁.活動),
    readSheet(env, 分頁.模板),
    readSheet(env, 分頁.附件),
  ]);

  // 附件沒填檔案 ID 時，從雲端資料夾照檔名補。
  // 這樣維護的人只要把圖丟進資料夾，不用一個一個複製 ID
  const 列資料夾 = async (id) => {
    if (!id) return [];
    try { return await listFolder(env, id); }
    catch (e) { return []; } // 列不出來就算了，有填 ID 的照樣能用
  };

  const [檔案清單, 海報清單] = await Promise.all([
    附件.some((a) => !是ID(a.檔案)) ? 列資料夾(env.ATTACH_FOLDER) : [],
    活動.some((e) => e.海報 && !是ID(e.海報)) ? 列資料夾(env.POSTER_FOLDER) : [],
  ]);

  const cfg = { 活動, 模板, 附件, 檔案清單, 海報清單 };
  if (env.CACHE) {
    await env.CACHE.put("cfg:v1", JSON.stringify(cfg), { expirationTtl: CACHE_TTL });
  }
  return cfg;
}

function 組合(r, cfg) {
  const 活動 = 逗號(r.活動)
    .map((代號) => cfg.活動.find((e) => e.活動代號 === 代號))
    .filter((e) => e && 有效(e.啟用))
    .map((e) => ({ ...e, 海報: 解析檔案(e.海報, cfg.海報清單) }));

  const 模板 = cfg.模板.find((t) => t.模板代號 === r.信件模板 && 有效(t.啟用));
  const 信件內文 = 模板 ? String(模板.內文).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : [];

  const 附件 = 逗號(r.附件)
    .map((代號) => cfg.附件.find((a) => a.附件代號 === 代號))
    .filter((a) => a && 有效(a.啟用))
    .map((a) => ({
      名稱: a.名稱,
      說明: a.說明,
      類型: a.類型,
      檔案: a.檔案
        ? 逗號(a.檔案).map((v) => 解析檔案(v, cfg.檔案清單)).filter(Boolean)
        : 依檔名找(cfg.檔案清單, a),
      原始檔: a.原始檔 || 找PDF(cfg.檔案清單, a),
    }));

  return {
    代碼: r.代碼,
    _row: r._row,
    對象姓名: r.對象姓名,
    稱謂: r.稱謂,
    邀請人: r.邀請人,
    狀態: r.狀態,
    個人化開場: r.個人化開場,
    客製內文: r.客製內文,
    開啟次數: Number(r.開啟次數) || 0,
    活動,
    附件,
    信件內文,
  };
}

// 雲端硬碟的檔案 ID 長這樣：25 個字以上的英數與 - _
const 是ID = (v) => /^[\w-]{25,}$/.test(String(v ?? "").trim());

// 「海報」和「檔案」欄可以填三種東西，維護的人用哪種順手就用哪種：
//   1. 檔案 ID
//   2. 雲端硬碟的分享連結（貼上就好，程式自己抽 ID）
//   3. 檔名開頭，例如 2026-09-20 —— 海報資料夾本來就用日期當檔名
function 解析檔案(值, 清單) {
  const v = String(值 ?? "").trim();
  if (!v) return "";
  if (是ID(v)) return v;

  const 連結 = v.match(/\/d\/([\w-]{25,})|[?&]id=([\w-]{25,})/);
  if (連結) return 連結[1] || 連結[2];

  const f = (清單 || []).find((x) => x.name.startsWith(v));
  return f ? f.id : "";
}

// 檔名以附件代號或名稱開頭的圖片，依檔名排序就是頁序
function 依檔名找(清單, a) {
  const 前綴 = [a.附件代號, a.名稱].filter(Boolean);
  return 清單
    .filter((f) => f.mimeType?.startsWith("image/") && 前綴.some((p) => f.name.startsWith(p)))
    .map((f) => f.id);
}

function 找PDF(清單, a) {
  const 前綴 = [a.附件代號, a.名稱].filter(Boolean);
  const f = 清單.find((x) => x.mimeType === "application/pdf" && 前綴.some((p) => x.name.startsWith(p)));
  return f ? f.id : "";
}

/* ── 開啟次數（規格第 3 節）───────────────────── */

async function countOpen(code, invite, env) {
  if (!invite._row) return;
  try {
    const 次數 = (Number(invite.開啟次數) || 0) + 1;
    const 現在 = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });

    // 欄位位置寫死在這裡不安全（欄可能被搬動），所以照標題找欄
    const 邀請列 = await readSheet(env, 分頁.邀請);
    const 標題 = Object.keys(邀請列[0] || {}).filter((k) => k !== "_row");
    const 欄 = (名) => {
      const i = 標題.indexOf(名);
      return i < 0 ? null : String.fromCharCode(65 + i);
    };

    const c1 = 欄("開啟次數");
    const c2 = 欄("最後開啟");
    if (c1) await updateCell(env, 分頁.邀請, `${c1}${invite._row}`, 次數);
    if (c2) await updateCell(env, 分頁.邀請, `${c2}${invite._row}`, 現在);

    // 快取裡的次數也跟上，免得五分鐘內每次開都寫同一個數字
    if (env.CACHE) {
      await env.CACHE.put(`inv:${code}`, JSON.stringify({ ...invite, 開啟次數: 次數 }),
        { expirationTtl: CACHE_TTL });
    }
  } catch (e) {
    // 計數失敗不該影響任何人看卡片
  }
}

/* ────────────────────────────────────────────────
   渲染
   ──────────────────────────────────────────────── */

function renderCard(inv, env) {
  const 全名 = esc(inv.對象姓名);
  const 邀請人 = esc(inv.邀請人);
  const 活動 = inv.活動 || [];
  const 首場 = 活動[0];

  const 信 = (inv.客製內文
    ? String(inv.客製內文).split(/\n\s*\n/)
    : [inv.個人化開場, ...(inv.信件內文 || [])].filter(Boolean)
  ).map((p, i) => {
    // 先逃脫整段，再把變數換成 <mark>——順序反了就等於開放試算表注入 HTML
    const 內容 = esc(p)
      .replace(/\{對象\}/g, `<mark>${全名}</mark>`)
      .replace(/\{對象全稱\}/g, `<mark>${全名}${esc(inv.稱謂)}</mark>`)
      .replace(/\{邀請人\}/g, `<mark>${邀請人}</mark>`);
    return i === 0 ? `<p class="salut">${內容}</p>` : `<p>${內容}</p>`;
  }).join("\n      ");

  const 活動區 = 活動.map((ev) => `
  <div class="sec">
    <div class="sec-h">Event</div>
    ${ev.海報 ? `<img class="poster" src="/img/${esc(ev.海報)}" alt="${esc(ev.名稱)}海報" loading="lazy">` : ""}
    <div class="ev">
      <div class="ev-name">${esc(ev.名稱)}</div>
      <dl>
        <dt>日期</dt><dd>${esc(ev.日期)}</dd>
        <dt>時間</dt><dd>${esc(ev.時間)}</dd>
        <dt>地點</dt><dd>${esc(ev.地點)}</dd>
      </dl>
      ${ev.標語 ? `<div class="tag">${ev.標語}</div>` : ""}
    </div>
  </div>`).join("\n");

  const 附件區 = (inv.附件 || []).map((a) => {
    const 頁 = a.類型 === "圖片集" && Array.isArray(a.檔案)
      ? `<div class="pages">${a.檔案
          .map((id, n) => `<img src="/img/${esc(id)}" alt="${esc(a.名稱)} 第 ${n + 1} 頁" loading="lazy">`)
          .join("")}</div>`
      : "";
    // PDF 走 Google 的預覽頁，不走自家代理：
    // 這些見證是 6 頁掃描、單檔十幾 MB，整份丟給手機下載要等十幾秒。
    // Drive 的檢視器會逐頁串流，點下去就看得到第一頁
    const 主檔 = a.原始檔 || (a.類型 !== "圖片集" ? (a.檔案 || [])[0] : "");
    const 下載 = 主檔
      ? `<a class="attach" href="https://drive.google.com/file/d/${esc(主檔)}/preview" target="_blank" rel="noopener">
        <div class="ic">📖</div>
        <div><div class="t">${esc(a.名稱)}</div><div class="s">${esc(a.說明 || "點開閱讀")}</div></div>
      </a>`
      : "";
    return `
  <div class="sec">
    <div class="sec-h">Enclosed</div>
    ${頁 ? `<div class="ev-name">${esc(a.名稱)}</div>` : ""}
    ${頁}
    ${下載}
  </div>`;
  }).join("\n");

  const 活動名 = 活動.map((e) => e.名稱).join("、");

  return fill(CARD_HTML, {
    pageTitle: `${inv.邀請人} 邀請你參加${首場 ? 首場.名稱 : "聚會"}`,
    ogTitle: `${inv.邀請人} 邀請你參加${活動名 || "聚會"}`,
    ogDesc: 首場 ? `${首場.日期} ${首場.時間}　${首場.地點}` : "",
    ogImage: 首場 && 首場.海報 ? `${env.SITE_ORIGIN || ""}/img/${首場.海報}` : "",
    churchEn: esc(env.CHURCH_NAME_EN || "TRUE JESUS CHURCH"),
    churchZh: esc(env.CHURCH_NAME || "真耶穌教會　黎明教會"),
    churchMeta: `${esc(env.CHURCH_ADDRESS || "")}<br>${esc(env.CHURCH_PHONE || "")}`,
    churchPhone: esc(env.CHURCH_PHONE || ""),
    who: 全名,
    hon: esc(inv.稱謂),
    from: 邀請人,
    letter: 信,
    events: 活動區,
    attachments: 附件區,
    mapUrl: esc(env.CHURCH_MAP || "#"),
  });
}

// {{名稱}} 換成對應的值。值已經是最終 HTML，這裡不再逃脫
function fill(tpl, data) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in data ? String(data[k]) : ""));
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

function notFound() {
  return new Response(NOTFOUND_HTML, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// LINE、Facebook 那類預覽爬蟲：照樣給網頁，但不算開啟次數
function isPreviewBot(ua) {
  return /line|facebookexternalhit|twitterbot|slackbot|whatsapp|discordbot|bot|crawler|spider/i.test(ua || "");
}

/* ────────────────────────────────────────────────
   名單頁　—— 複製連結、預覽、用 LINE 傳送
   ──────────────────────────────────────────────── */

async function listPage(url, env) {
  if (!env.DEBUG_TOKEN || url.searchParams.get("t") !== env.DEBUG_TOKEN) {
    return notFound();
  }

  const 站台 = env.SITE_ORIGIN || url.origin;

  if (url.searchParams.get("refresh") === "1" && env.CACHE) {
    const 列 = await readSheet(env, 分頁.邀請);
    await Promise.all([
      env.CACHE.delete("cfg:v1"),
      ...列.map((r) => env.CACHE.delete(`inv:${String(r.代碼 || "").toLowerCase()}`)),
    ]);
  }

  const [列, cfg] = await Promise.all([readSheet(env, 分頁.邀請), loadConfig(env)]);

  const rows = 列
    .filter((r) => r.代碼)
    .map((r) => {
      const inv = 組合(r, cfg);
      const 網址 = `${站台}/${r.代碼}`;
      const 活動名 = inv.活動.map((e) => e.名稱).join("、") || "聚會";
      const 訊息 =
        `${r.對象姓名}${r.稱謂 || ""}平安，我是${r.邀請人}。
` +
        `誠摯邀請你參加${活動名}，這是給你的邀請卡：
${網址}`;

      const 狀態類 = r.狀態 === "已發送" ? "sent" : r.狀態 === "已停用" ? "off" : "";
      const 次數 = Number(r.開啟次數) || 0;

      return `
  <div class="card">
    <div class="top">
      <span class="who">${esc(r.對象姓名)}${esc(r.稱謂 || "")}</span>
      <span class="pill ${狀態類}">${esc(r.狀態 || "草稿")}</span>
      ${次數 ? `<span class="pill opened">開啟 ${次數} 次</span>` : ""}
    </div>
    <div class="meta">${esc(r.邀請人)} 邀請　·　${esc(活動名)}${
      inv.附件.length ? `　·　附 ${esc(inv.附件[0].名稱)}` : ""
    }</div>
    <div class="url">${esc(網址)}</div>
    <div class="acts">
      <button data-copy="${esc(網址)}">複製連結</button>
      <a class="lnk" href="${esc(網址)}" target="_blank" rel="noopener">預覽</a>
      <a class="lnk" href="https://line.me/R/msg/text/?${encodeURIComponent(訊息)}"
         target="_blank" rel="noopener">用 LINE 傳送</a>
      <button data-copy="${esc(訊息)}">複製訊息</button>
    </div>
  </div>`;
    })
    .join("\n");

  const html = fill(LIST_HTML, {
    count: 列.length,
    token: esc(env.DEBUG_TOKEN),
    sheetUrl: `https://docs.google.com/spreadsheets/d/${env.SHEET_ID}/edit`,
    rows: rows || `<div class="empty">試算表裡還沒有邀請</div>`,
  });

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // 這頁列得出所有人的連結，別讓它被存進任何中間層
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/* ────────────────────────────────────────────────
   自我診斷　—— 驗完就整段刪掉
   ──────────────────────────────────────────────── */

async function debug(url, env) {
  if (!env.DEBUG_TOKEN || url.searchParams.get("t") !== env.DEBUG_TOKEN) {
    return new Response("Not found", { status: 404 });
  }

  const out = {};
  const 記 = async (名, fn) => {
    try { out[名] = await fn(); }
    catch (e) { out[名] = `✗ ${e.message}`; }
  };

  await 記("權杖", async () => ((await getAccessToken(env)) ? "✓ 換到了" : "✗"));

  for (const tab of Object.values(分頁)) {
    await 記(tab, async () => {
      const rows = await readSheet(env, tab);
      return {
        筆數: rows.length,
        標題列: Object.keys(rows[0] || {}).filter((k) => k !== "_row"),
        第一筆: rows[0] || null,
      };
    });
  }

  await 記("海報資料夾", async () => {
    if (!env.POSTER_FOLDER) return "（沒設定）";
    const files = await listFolder(env, env.POSTER_FOLDER);
    return files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType }));
  });

  await 記("雲端資料夾", async () => {
    if (!env.ATTACH_FOLDER) return "（沒設定）";
    const meta = await fileMeta(env, env.ATTACH_FOLDER);
    const files = await listFolder(env, env.ATTACH_FOLDER);
    return {
      資料夾: meta.name,
      在共用雲端硬碟: meta.driveId ? `是（${meta.driveId}）` : "否",
      擁有者: (meta.owners || []).map((o) => o.emailAddress),
      檔案數: files.length,
      檔案: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })),
    };
  });

  return new Response(JSON.stringify(out, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/* ────────────────────────────────────────────────
   圖片代理　—— 施做計畫 C3
   ──────────────────────────────────────────────── */

async function imageProxy(fileId, env, ctx) {
  if (!/^[\w-]{10,}$/.test(fileId)) return new Response("Not found", { status: 404 });

  const cache = caches.default;
  const key = new Request(`https://img.local/${fileId}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  const upstream = await fetchFile(env, fileId);
  if (!upstream.ok) {
    return new Response("圖片讀不到", { status: upstream.status === 404 ? 404 : 502 });
  }

  const res = new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") || "image/jpeg",
      // 檔案 ID 不變就是同一張圖，放心讓邊緣節點留一天
      "cache-control": "public, max-age=86400",
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
