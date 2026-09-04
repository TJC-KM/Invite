// 邀請卡 Worker —— 公開路徑的骨架
//
// HTML 不寫在這個檔案裡。card.html 是用 import 進來的純文字，
// 這樣裡面有多少反引號、${}、引號都不會影響 JS。

import CARD_HTML from "./card.html";
import NOTFOUND_HTML from "./notfound.html";
import ADMIN_HTML from "./admin.html";
import { readSheet, updateCell, appendRow, listFolder, fetchFile, thumbnailUrl } from "./google.js";

const CODE_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    if (path === "") {
      return Response.redirect(env.CHURCH_SITE || "https://li-ming-tjc.org", 302);
    }

    if (path === "robots.txt") {
      return new Response("User-agent: *\nDisallow: /admin\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (path.startsWith("img/")) {
      return imageProxy(path.slice(4), env, ctx);
    }

    // PDF 第一頁的預覽圖
    if (path.startsWith("thumb/")) {
      return thumbProxy(path.slice(6), env, ctx);
    }

    // 「我要參加」是公開的，不帶金鑰——但只認得完整正確的代碼
    if (path === "api/rsvp") return rsvp(request, env);

    // 維護介面和它的 API 全在 /admin 底下，Access 才能用單一路徑一次保護到
    if (path === "admin" || path === "list") return adminPage(url, env);
    if (path.startsWith("admin/api/")) return api(path.slice(10), request, url, env);

    const code = path.toLowerCase();
    if (!CODE_RE.test(code)) return notFound(env);

    const invite = await loadInvite(code, env);
    if (!invite || invite.狀態 === "已停用") return notFound(env);

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

const 分頁 = { 邀請: "邀請名單", 活動: "活動", 模板: "信件模板", 附件: "附件", 設定: "設定檔" };
const CACHE_TTL = 120; // 秒。只作用在公開卡片；維護介面一律讀即時資料

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
// 維護介面一律傳 { 即時: true }：那裡的人剛改完試算表，
// 看到五分鐘前的舊資料只會以為壞了。公開卡片才需要快取擋在前面
async function loadConfig(env, { 即時 = false } = {}) {
  if (env.CACHE && !即時) {
    const hit = await env.CACHE.get("cfg:v1", "json");
    if (hit) return hit;
  }

  const [活動, 模板, 附件, 設定列] = await Promise.all([
    readSheet(env, 分頁.活動),
    readSheet(env, 分頁.模板),
    readSheet(env, 分頁.附件),
    // 設定檔分頁是選配的。沒建也不會壞，程式自己有一套預設文案
    readSheet(env, 分頁.設定).catch(() => []),
  ]);

  const 文案 = {};
  for (const r of 設定列) {
    const k = String(r.代號 || "").trim();
    if (k) 文案[k] = String(r.內容 ?? "");
  }

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

  const cfg = { 活動, 模板, 附件, 文案, 檔案清單, 海報清單 };
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
    稱呼: r.稱呼,
    稱謂: r.稱謂,
    邀請人: r.邀請人,
    狀態: r.狀態,
    個人化開場: r.個人化開場,
    客製內文: r.客製內文,
    開啟次數: Number(r.開啟次數) || 0,
    活動,
    附件,
    信件內文,
    文案: cfg.文案 || {},
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
      return i < 0 ? null : 欄名(i);
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

/* ── 文案（設定檔分頁）─────────────────────────
   卡片上的字句放試算表，改字不用改程式、不用重新部署。
   沒建分頁或某一則沒填，就用這裡的預設值
   ──────────────────────────────────────────────── */

const 預設文案 = {
  參加按鈕: "我要參加",
  "參加按鈕-多場": "我要參加．{活動}",
  回覆確認: "已經收到了，{邀請人}會再跟你聯絡　🙏",
  "回覆確認-多場": "{活動}　已經收到了 🙏",
  地圖按鈕: "查看地圖",
  附件標題: "Testimony",
  稱謂選項: "先生,小姐,弟兄,姊妹,同學,老師,平安",
  稱呼建議: "阿姨,叔叔,伯父,伯母,學長,學姐,女兒,女婿",
  預設地點: "黎明教會",
  邀請開頭: "{邀請人} 誠摯邀請你",
  署名: "你的朋友　{邀請人}　敬上",
  LINE訊息: "{對象全稱}平安，我是{邀請人}。\n誠摯邀請你參加{活動}，這是給你的邀請卡：\n{網址}",
};

function 文案(來源, 代號, 變數) {
  const 樣板 = (來源 && 來源[代號]) || 預設文案[代號] || "";
  return 代入(樣板, 變數 || {});
}

function 代入(樣板, 變數) {
  // 不能用 \w——JS 的 \w 只認 ASCII，{活動} 這種中文變數名一個都比對不到
  return String(樣板).replace(/\{([^{}]{1,20})\}/g, (m, k) => (k in 變數 ? String(變數[k]) : m));
}

/* ────────────────────────────────────────────────
   渲染
   ──────────────────────────────────────────────── */

function renderCard(inv, env) {
  const 詞 = inv.文案;                  // 設定檔分頁的文案，附件區與按鈕都會用到

  // 稱呼是「卡片上怎麼叫他」，對象姓名是「名單上他是誰」——兩件事。
  // 填了稱呼就整張卡片都用它，也不再接稱謂（「阿姨小姐」很怪）
  const 有稱呼 = !!String(inv.稱呼 || "").trim();
  const 全名 = esc(有稱呼 ? inv.稱呼 : inv.對象姓名);
  const 敬稱 = 有稱呼 ? "" : esc(inv.稱謂 || "");
  const 邀請人 = esc(inv.邀請人);
  const 活動 = inv.活動 || [];
  const 首場 = 活動[0];

  // 開場白永遠在最前面，後面接信件本文——本文可能是模板，
  // 也可能是新增當下就改過的版本（客製內文）
  const 本文 = inv.客製內文
    ? String(inv.客製內文).split(/\n\s*\n/)
    : inv.信件內文 || [];
  const 信 = [inv.個人化開場, ...本文].filter(Boolean).map((p, i) => {
    // 先逃脫整段，再把變數換成 <mark>——順序反了就等於開放試算表注入 HTML
    const 內容 = esc(p)
      .replace(/\{對象\}/g, `<mark>${全名}</mark>`)
      .replace(/\{對象全稱\}/g, `<mark>${全名}${敬稱}</mark>`)
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
      ? `<a class="attach-card" href="https://drive.google.com/file/d/${esc(主檔)}/preview" target="_blank" rel="noopener">
        <div class="peek"><img src="/thumb/${esc(主檔)}" alt="${esc(a.名稱)} 第一頁" loading="lazy"></div>
        <div class="attach">
          <div class="ic">📖</div>
          <div><div class="t">${esc(a.名稱)}</div><div class="s">${esc(a.說明 || "點開閱讀全文")}</div></div>
        </div>
      </a>`
      : "";
    return `
  <div class="sec">
    <div class="sec-h">${esc(文案(詞, "附件標題", {}))}</div>
    ${頁 ? `<div class="ev-name">${esc(a.名稱)}</div>` : ""}
    ${頁}
    ${下載}
  </div>`;
  }).join("\n");

  const 活動名 = 活動.map((e) => e.名稱).join("、");

  // 一場一顆按鈕。複選時要知道他答應的是哪一場，只寫「我要參加」等於沒寫
  const 參加鈕 = (活動.length ? 活動 : [null]).map((ev) => {
    const 代號 = ev ? esc(ev.活動代號) : "";
    const 單場 = !ev || 活動.length === 1;
    const 變數 = { 邀請人, 對象: 全名, 活動: ev ? esc(ev.名稱) : "" };
    const 字 = 文案(詞, 單場 ? "參加按鈕" : "參加按鈕-多場", 變數);
    const 確認 = 文案(詞, 單場 ? "回覆確認" : "回覆確認-多場", 變數);
    return `<div class="joinbox">
        <button class="btn btn-1 join" type="button"
                data-code="${esc(inv.代碼 || "")}" data-ev="${代號}">${字}</button>
        <div class="joined" hidden>${確認}</div>
      </div>`;
  }).join("\n      ");

  return fill(CARD_HTML, {
    code: esc(inv.代碼 || ""),
    joinButtons: 參加鈕,
    inviteLead: 文案(詞, "邀請開頭", { 邀請人: `<b>${邀請人}</b>` }),
    sign: 文案(詞, "署名", { 邀請人: `<mark>${邀請人}</mark>` }),
    mapLabel: esc(文案(詞, "地圖按鈕", {})),
    churchSite: esc(env.CHURCH_SITE || "https://li-ming-tjc.org"),
    pageTitle: `${inv.邀請人} 邀請你參加${首場 ? 首場.名稱 : "聚會"}`,
    ogTitle: `${inv.邀請人} 邀請你參加${活動名 || "聚會"}`,
    ogDesc: 首場 ? `${首場.日期} ${首場.時間}　${首場.地點}` : "",
    ogImage: 首場 && 首場.海報 ? `${env.SITE_ORIGIN || ""}/img/${首場.海報}` : "",
    churchEn: esc(env.CHURCH_NAME_EN || "TRUE JESUS CHURCH"),
    churchZh: esc(env.CHURCH_NAME || "真耶穌教會　黎明教會"),
    churchMeta: `${esc(env.CHURCH_ADDRESS || "")}<br>${esc(env.CHURCH_PHONE || "")}`,
    churchPhone: esc(env.CHURCH_PHONE || ""),
    who: 全名,
    hon: 敬稱,
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

function notFound(env) {
  return new Response(fill(NOTFOUND_HTML, {
    churchSite: esc((env && env.CHURCH_SITE) || "https://li-ming-tjc.org"),
  }), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// LINE、Facebook 那類預覽爬蟲：照樣給網頁，但不算開啟次數
function isPreviewBot(ua) {
  return /line|facebookexternalhit|twitterbot|slackbot|whatsapp|discordbot|bot|crawler|spider/i.test(ua || "");
}

/* ────────────────────────────────────────────────
   維護介面　—— 新增邀請、複製連結、用 LINE 傳送、停用
   ──────────────────────────────────────────────── */

async function adminPage(url, env) {
  const 站台 = env.SITE_ORIGIN || url.origin;

  if (url.searchParams.get("refresh") === "1" && env.CACHE) {
    const 列 = await readSheet(env, 分頁.邀請);
    await Promise.all([
      env.CACHE.delete("cfg:v1"),
      ...列.map((r) => env.CACHE.delete(`inv:${String(r.代碼 || "").toLowerCase()}`)),
    ]);
  }

  const [全部, cfg] = await Promise.all([
    readSheet(env, 分頁.邀請),
    loadConfig(env, { 即時: true }),
  ]);

  // 邀請人清單先算出來，這是唯一會無條件出現在頁面上的名單
  const 邀請人們 = [...全部.reduce((m, r) => {
    const n = String(r.邀請人 || "").trim();
    if (n) m.set(n, (m.get(n) || 0) + 1);
    return m;
  }, new Map())].sort((a, b) => b[1] - a[1]);

  // 沒指定邀請人就什麼都不列。名單是別人的個資，不該一打開就攤在畫面上
  const 查詢 = String(url.searchParams.get("from") || "").trim();
  const 列 = 查詢
    ? 全部.filter((r) => String(r.邀請人 || "").trim() === 查詢)
    : [];

  const rows = 列
    .filter((r) => r.代碼)
    .map((r) => {
      const inv = 組合(r, cfg);
      const 網址 = `${站台}/${r.代碼}`;
      const 活動名 = inv.活動.map((e) => e.名稱).join("、") || "聚會";
      const 叫他 = String(r.稱呼 || "").trim();
      const 訊息 = 文案(cfg.文案, "LINE訊息", {
        對象: 叫他 || r.對象姓名,
        稱謂: 叫他 ? "" : (r.稱謂 || ""),
        對象全稱: 叫他 || `${r.對象姓名}${r.稱謂 || ""}`,
        邀請人: r.邀請人,
        活動: 活動名,
        網址,
      });

      const 停用了 = r.狀態 === "已停用";
      const 狀態類 = r.狀態 === "已發送" ? "sent" : 停用了 ? "off" : "";
      const 次數 = Number(r.開啟次數) || 0;

      return `
  <div class="card${停用了 ? " off" : ""}">
    <div class="top">
      <span class="who">${esc(r.對象姓名)}${esc(r.稱呼 ? "" : r.稱謂 || "")}</span>
      ${r.稱呼 ? `<span class="pill">卡片上叫「${esc(r.稱呼)}」</span>` : ""}
      <span class="pill ${狀態類}">${esc(r.狀態 || "草稿")}</span>
      ${次數 ? `<span class="pill opened">開啟 ${次數} 次</span>` : ""}
      ${逗號(r.回覆).map((v) => {
        const e = cfg.活動.find((x) => x.活動代號 === v);
        return `<span class="pill join">參加 ${esc(e ? e.名稱 : v)}</span>`;
      }).join("")}
    </div>
    <div class="meta">${esc(r.邀請人)} 邀請　·　${esc(活動名)}${
      inv.附件.length ? `　·　附 ${esc(inv.附件[0].名稱)}` : ""
    }</div>
    <div class="url">${esc(網址)}</div>
    <div class="acts">
      <a class="lnk" href="${esc(網址)}" target="_blank" rel="noopener">預覽</a>
      <a class="lnk" href="/admin?from=${encodeURIComponent(r.邀請人 || "")}&edit=${encodeURIComponent(r.代碼)}#f">修改</a>
      <a class="lnk" href="https://line.me/R/msg/text/?${encodeURIComponent(訊息)}"
         target="_blank" rel="noopener">用 LINE 傳送</a>
      <button data-copy="${esc(訊息)}">複製訊息</button>
      ${停用了
        ? `<button data-act="草稿" data-code="${esc(r.代碼)}">恢復</button>`
        : `<button data-act="已發送" data-code="${esc(r.代碼)}">標記已發送</button>
      <button data-act="已停用" data-code="${esc(r.代碼)}">停用</button>`}
    </div>
  </div>`;
    })
    .join("\n");

  const 啟用中 = (清單) => 清單.filter((x) => 有效(x.啟用));

  // 活動日期過了就不該再出現在勾選清單裡。沒填日期的一律保留——
  // 少填一個欄位不該讓活動憑空消失
  const 今天 = 台北日期();
  const 還沒過 = (e) => {
    const d = String(e.海報活動日期 || "").trim();
    return !d || d >= 今天;
  };

  // 匯入面板只在按下按鈕後出現，平常不打擾
  const 要匯入 = url.searchParams.get("import") === "1";
  let 匯入面板 = "";
  if (要匯入) {
    const { 可匯入, 檔名不符 } = await 海報候選(env, cfg);
    匯入面板 = `
      <div class="find">
        <h2>從海報資料夾匯入活動</h2>
        <p class="hint" style="margin:0 0 10px">
          只列出日期還沒到、而且活動分頁裡還沒有的海報。
          匯入後「時間」和「標語」要自己補——那兩樣在海報圖片裡，檔名看不出來。
        </p>
        ${可匯入.length ? `
        <div class="checks">
          ${可匯入.map((x) => `
            <label class="check">
              <input type="checkbox" name="poster" value="${esc(x.id)}" checked>
              <span>${esc(x.名稱)}<br><span class="d">${esc(x.日期)}　代號 ${esc(x.代號)}</span></span>
            </label>`).join("")}
        </div>
        <div class="acts" style="margin-top:11px">
          <button id="doImport" class="go" style="width:auto">匯入勾選的 ${可匯入.length} 場</button>
          <a class="lnk" href="/admin">取消</a>
        </div>` : `<div class="ask">沒有可以匯入的海報——日期還沒到的都已經在活動分頁裡了</div>`}
        ${檔名不符.length ? `
        <p class="hint" style="margin-top:11px">
          這些檔名不符合 <code>yyyy-MM-dd 活動名</code>，沒辦法自動判讀：<br>
          ${檔名不符.map((n) => esc(n)).join("、")}
        </p>` : ""}
      </div>`;
  }

  // 編輯模式：帶 ?edit=<代碼> 就把那一筆填進表單
  const 編輯代碼 = String(url.searchParams.get("edit") || "").toLowerCase();
  const 編輯中 = 編輯代碼
    ? 全部.find((r) => String(r.代碼 || "").toLowerCase() === 編輯代碼)
    : null;
  const v = (k) => esc(編輯中 ? 編輯中[k] || "" : "");

  const 提示 = 查詢
    ? `<div class="ask">${esc(查詢)} 目前沒有邀請</div>`
    : `<div class="ask">選一位邀請人，或在上面輸入姓名<br>
      <span style="font-size:.82rem">名單不會一次全部列出來——那是別人的個資</span></div>`;

  // 說明文字：卡片上放什麼、不放什麼，外加一張真的能點的範例
  const 範例 = 全部.find((r) => r.代碼);
  const 範例連結 = 範例
    ? ` <a href="${站台}/${esc(範例.代碼)}" target="_blank" rel="noopener">看一張範例</a>`
    : "";
  const 說明 =
    "卡片上只有邀請函、活動資訊與見證，沒有電話、地址這類敏感資料。" + 範例連結;

  const html = fill(ADMIN_HTML, {
    count: 全部.length,
    note: 說明,
    origin: esc(站台),
    from: esc(查詢),
    rows: 匯入面板 + (rows || 提示),

    fromChips: 邀請人們
      .map(([n]) =>
        `<a class="chip${n === 查詢 ? " on" : ""}" href="/admin?from=${encodeURIComponent(n)}">${esc(n)}</a>`)
      .join(""),

    formTitle: 編輯中 ? `修改「${esc(編輯中.對象姓名)}」` : "新增邀請",
    submitLabel: 編輯中 ? "儲存修改" : "產生邀請連結",
    editCode: 編輯中 ? esc(編輯中.代碼) : "",
    cancelRow: 編輯中
      ? `<a class="lnk" href="/admin?from=${encodeURIComponent(編輯中.邀請人 || "")}">取消</a>`
      : "",
    vName: v("對象姓名"),
    vHon: v("稱謂"),
    vNick: v("稱呼"),
    vFrom: v("邀請人"),
    vOpen: v("個人化開場"),
    vCustom: v("客製內文"),

    // 模板全文給前端用——「以模板為底稿」那顆按鈕要把它填進客製內文
    tmplBodies: JSON.stringify(
      Object.fromEntries(啟用中(cfg.模板).map((t) => [t.模板代號, t.內文 || ""]))
    ),

    eventChecks: 啟用中(cfg.活動)
      .filter((e) => 還沒過(e) || (編輯中 && 逗號(編輯中.活動).includes(e.活動代號)))
      .map((e) => `
      <label class="check">
        <input type="checkbox" name="活動" value="${esc(e.活動代號)}"${
          編輯中 && 逗號(編輯中.活動).includes(e.活動代號) ? " checked" : ""}>
        <span>${esc(e.名稱)}<br><span class="d">${esc(e.日期 || "")} ${esc(e.時間 || "")}</span></span>
      </label>`).join(""),

    tmplOptions: 啟用中(cfg.模板)
      .map((t) => `<option value="${esc(t.模板代號)}"${
        編輯中 && 編輯中.信件模板 === t.模板代號 ? " selected" : ""
      }>${esc(t.名稱 || t.模板代號)}</option>`)
      .join(""),

    // 54 篇見證照主題分組，不然選單會是一條看不完的長清單
    attachOptions: 分組附件(啟用中(cfg.附件), 編輯中 ? 逗號(編輯中.附件) : []),

    // 稱謂與稱呼的建議清單來自設定檔，維護的人自己加減；兩欄都仍可自由輸入
    honOptions: 逗號(文案(cfg.文案, "稱謂選項", {}))
      .map((v) => `<option value="${esc(v)}"></option>`).join(""),
    nickOptions: 逗號(文案(cfg.文案, "稱呼建議", {}))
      .map((v) => `<option value="${esc(v)}"></option>`).join(""),

    // 邀請人打過一次就會出現在建議清單裡，避免「陳志成／陳誌成」
    fromOptions: 邀請人們
      .map(([n]) => `<option value="${esc(n)}"></option>`).join(""),
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

// 附件代號長這樣：04-04-禱告生活-蘇真玉。中間那段是主題，拿來分組
function 分組附件(附件, 已選 = []) {
  const 群 = new Map();
  for (const a of 附件) {
    const m = String(a.附件代號).match(/^\d+-\d+-([^-]+)-/);
    const 主題 = m ? m[1] : "其他";
    if (!群.has(主題)) 群.set(主題, []);
    群.get(主題).push(a);
  }
  return [...群]
    .map(([主題, 清單]) => `<optgroup label="${esc(主題)}">${清單
      .map((a) => `<option value="${esc(a.附件代號)}"${
        已選.includes(a.附件代號) ? " selected" : ""
      }>${esc(a.名稱)}</option>`)
      .join("")}</optgroup>`)
    .join("");
}

/* ── 從海報資料夾匯入活動 ───────────────────────
   海報檔名的慣例是 yyyy-MM-dd 活動名，日期、名稱、代號、排序
   都能從檔名推出來，檔案 ID 也不用手抄。
   時間和標語推不出來（那些在海報圖片裡），留給人補
   ──────────────────────────────────────────────── */

// 台北的今天，格式 2026-08-28。sv-SE 的日期寫法剛好就是 ISO
function 台北日期() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
}

const 週 = ["日", "一", "二", "三", "四", "五", "六"];

function 解析海報(f) {
  const m = String(f.name).match(/^(\d{4})-(\d{2})-(\d{2})[\s_-]+(.+?)(?:\.[A-Za-z0-9]{1,5})?$/);
  if (!m) return null;
  const [, y, mo, d, 名稱] = m;
  const 星期 = 週[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()];
  return {
    id: f.id,
    檔名: f.name,
    日期字: `${y}-${mo}-${d}`,
    代號: `${y.slice(2)}${mo}-${名稱.trim()}`,
    名稱: 名稱.trim(),
    日期: `${+y} 年 ${+mo} 月 ${+d} 日（${星期}）`,
    排序: Number(`${y.slice(2)}${mo}${d}`),
  };
}

async function 海報候選(env, cfg) {
  if (!env.POSTER_FOLDER) return { 可匯入: [], 檔名不符: [] };

  let files = [];
  try { files = await listFolder(env, env.POSTER_FOLDER); } catch (e) { return { 可匯入: [], 檔名不符: [] }; }

  const 今天 = 台北日期();
  const 有海報 = new Set(cfg.活動.map((e) => e.海報).filter(Boolean));
  const 有代號 = new Set(cfg.活動.map((e) => e.活動代號));

  const 圖 = files.filter((f) => String(f.mimeType || "").startsWith("image/"));
  const 檔名不符 = 圖.filter((f) => !解析海報(f)).map((f) => f.name);

  const 可匯入 = 圖
    .map(解析海報)
    .filter(Boolean)
    .filter((x) => x.日期字 >= 今天)          // 過期的活動不匯入
    .filter((x) => !有海報.has(x.id) && !有代號.has(x.代號))
    .sort((a, b) => a.排序 - b.排序);

  return { 可匯入, 檔名不符 };
}

async function 匯入活動(body, env) {
  const 要的 = new Set((body.檔案 || []).map(String));
  if (!要的.size) return json({ ok: false, error: "沒有勾選任何海報" }, 400);

  // 這裡讀快取會出事：兩個人同時匯入，晚的那個看到的是舊清單，
  // 就會把同一場再寫一次
  const cfg = await loadConfig(env, { 即時: true });
  const { 可匯入 } = await 海報候選(env, cfg);
  const 地點 = 文案(cfg.文案, "預設地點", {}) || "黎明教會";

  const 進去的 = [];
  for (const x of 可匯入) {
    if (!要的.has(x.id)) continue;
    await appendRow(env, 分頁.活動, {
      活動代號: x.代號,
      名稱: x.名稱,
      標語: "",
      日期: x.日期,
      時間: "",
      地點,
      海報: x.id,
      海報活動日期: x.日期字,      // 2026-08-29。用來判斷這場過了沒
      地圖連結: "",
      啟用: "是",
      排序: x.排序,
    });
    進去的.push(x.代號);
  }

  if (env.CACHE) await env.CACHE.delete("cfg:v1");
  return json({ ok: true, 匯入: 進去的 });
}

/* ────────────────────────────────────────────────
   寫入 API　—— 施做計畫 E1
   ──────────────────────────────────────────────── */

async function api(動作, request, url, env) {
  if (request.method !== "POST") return json({ ok: false, error: "只收 POST" }, 405);

  try {
    const body = await request.json();
    if (動作 === "setup") return await 補欄位(env);
    if (動作 === "invite") return await 新增邀請(body, env, url);
    if (動作 === "update") return await 修改邀請(body, env);
    if (動作 === "status") return await 改狀態(body, env);
    return notFound(env);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// 補上程式需要、但早期試算表沒有的欄位。跑一次就好，重複跑不會有事
async function 補欄位(env) {
  const 加了 = [];

  const 確保欄位 = async (分頁名, 欄位們) => {
    const 列 = await readSheet(env, 分頁名);
    const 標題 = Object.keys(列[0] || {}).filter((k) => k !== "_row");
    for (const 名 of 欄位們) {
      if (標題.includes(名)) continue;
      await updateCell(env, 分頁名, `${欄名(標題.length)}1`, 名);
      標題.push(名);
      加了.push(`${分頁名}.${名}`);
    }
    return 標題;
  };

  await 確保欄位(分頁.邀請, ["稱呼", "回覆", "回覆時間"]);
  const 活動標題 = await 確保欄位(分頁.活動, ["海報活動日期"]);

  // 舊的活動列是手動建的，沒有機器讀得懂的日期。從中文日期欄回填一次
  const 回填 = [];
  const c = 活動標題.indexOf("海報活動日期");
  if (c >= 0) {
    for (const e of await readSheet(env, 分頁.活動)) {
      if (String(e.海報活動日期 || "").trim()) continue;
      const d = 解析中文日期(e.日期);
      if (!d) continue;
      await updateCell(env, 分頁.活動, `${欄名(c)}${e._row}`, d);
      回填.push(`${e.活動代號} → ${d}`);
    }
  }

  if (env.CACHE) await env.CACHE.delete("cfg:v1");
  return json({ ok: true, 加了, 回填 });
}

// 「2026 年 9 月 13 日（日）」→ 2026-09-13。抓第一個日期就好
function 解析中文日期(文字) {
  const m = String(文字 || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/);
  if (!m) return "";
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

async function 新增邀請(body, env, url) {
  const 姓名 = String(body.對象姓名 || "").trim();
  const 邀請人 = String(body.邀請人 || "").trim();
  if (!姓名) return json({ ok: false, error: "要填對象姓名" }, 400);
  if (!邀請人) return json({ ok: false, error: "要填邀請人" }, 400);

  const 既有 = await readSheet(env, 分頁.邀請);
  const 用過 = new Set(既有.map((r) => String(r.代碼 || "").toLowerCase()));

  let 代碼 = "";
  for (let i = 0; i < 20 && !代碼; i++) {
    const 試 = 產生代碼();
    if (!用過.has(試)) 代碼 = 試;
  }
  if (!代碼) return json({ ok: false, error: "產不出沒撞到的代碼，再試一次" }, 500);

  await appendRow(env, 分頁.邀請, {
    代碼,
    對象姓名: 姓名,
    稱呼: String(body.稱呼 || "").trim(),
    稱謂: String(body.稱謂 || "").trim(),
    邀請人,
    活動: String(body.活動 || "").trim(),
    信件模板: String(body.信件模板 || "").trim(),
    個人化開場: String(body.個人化開場 || "").trim(),
    客製內文: String(body.客製內文 || "").trim(),
    附件: String(body.附件 || "").trim(),
    狀態: "草稿",
    建立時間: 台北時間(),
    建立者: "維護介面",
    開啟次數: 0,
    最後開啟: "",
    回覆: "",
    回覆時間: "",
  });

  // 寫進試算表的同時就把快取清掉，連結產生當下就是對的（規格第 2 節）
  if (env.CACHE) await env.CACHE.delete("cfg:v1");

  const cfg = await loadConfig(env, { 即時: true });
  const 活動名 = 逗號(body.活動)
    .map((代號) => (cfg.活動.find((e) => e.活動代號 === 代號) || {}).名稱)
    .filter(Boolean)
    .join("、") || "聚會";
  const 網址 = `${env.SITE_ORIGIN || url.origin}/${代碼}`;

  return json({
    ok: true,
    代碼,
    網址,
    訊息:
      `${姓名}${body.稱謂 || ""}平安，我是${邀請人}。\n` +
      `誠摯邀請你參加${活動名}，這是給你的邀請卡：\n${網址}`,
  });
}

// 修改一筆邀請。代碼不動——動了等於換網址，已發出的連結會失效
async function 修改邀請(body, env) {
  const code = String(body.代碼 || "").toLowerCase();
  if (!CODE_RE.test(code)) return json({ ok: false, error: "代碼不對" }, 400);

  const 列 = await readSheet(env, 分頁.邀請);
  const r = 列.find((x) => String(x.代碼 || "").toLowerCase() === code);
  if (!r) return json({ ok: false, error: "找不到這筆邀請" }, 404);

  const 標題 = Object.keys(列[0]).filter((k) => k !== "_row");
  const 可改 = ["對象姓名", "稱呼", "稱謂", "邀請人", "活動", "信件模板", "個人化開場", "客製內文", "附件"];

  const 改了 = [];
  for (const 名 of 可改) {
    if (!(名 in body)) continue;
    const i = 標題.indexOf(名);
    if (i < 0) continue;
    const 新值 = String(body[名] ?? "").trim();
    if (新值 === String(r[名] ?? "").trim()) continue;   // 沒變就不寫
    await updateCell(env, 分頁.邀請, `${欄名(i)}${r._row}`, 新值);
    改了.push(名);
  }

  if (env.CACHE) await env.CACHE.delete(`inv:${code}`);
  return json({ ok: true, 改了 });
}

async function 改狀態(body, env) {
  const 代碼 = String(body.代碼 || "").toLowerCase();
  const 狀態 = String(body.狀態 || "").trim();
  if (!["草稿", "已發送", "已停用"].includes(狀態)) {
    return json({ ok: false, error: "狀態只能是草稿／已發送／已停用" }, 400);
  }

  const 列 = await readSheet(env, 分頁.邀請);
  const r = 列.find((x) => String(x.代碼 || "").toLowerCase() === 代碼);
  if (!r) return json({ ok: false, error: "找不到這筆邀請" }, 404);

  const 標題 = Object.keys(列[0]).filter((k) => k !== "_row");
  const i = 標題.indexOf("狀態");
  if (i < 0) return json({ ok: false, error: "試算表沒有「狀態」欄" }, 500);

  await updateCell(env, 分頁.邀請, `${欄名(i)}${r._row}`, 狀態);
  if (env.CACHE) await env.CACHE.delete(`inv:${代碼}`);

  return json({ ok: true, 狀態 });
}

/* ── 我要參加 ─────────────────────────────────────
   公開路徑上唯一會寫入的東西。防線有三道：
   1. 只認完整正確的 12 碼——猜不到就打不到
   2. 同一個代碼一分鐘內只寫一次（KV 擋著）
   3. 已經回覆過就不再寫，重複按沒有意義
   ──────────────────────────────────────────────── */

async function rsvp(request, env) {
  if (request.method !== "POST") return json({ ok: false }, 405);

  try {
    const body = await request.json();
    const code = String(body.代碼 || "").toLowerCase();
    const 選的 = String(body.活動 || "").trim();
    if (!CODE_RE.test(code)) return json({ ok: false }, 400);

    // 節流的鍵要帶活動——不然複選時按了第一場，第二場會被自己擋掉
    const 鎖 = `rsvp:${code}:${選的}`;
    if (env.CACHE && (await env.CACHE.get(鎖))) return json({ ok: true, 已記錄: true });

    const 列 = await readSheet(env, 分頁.邀請);
    const r = 列.find((x) => String(x.代碼 || "").toLowerCase() === code);
    if (!r || r.狀態 === "已停用") return json({ ok: false }, 404);

    // 只接受這張卡片真的邀了的活動，其他一律不寫
    const 邀了 = 逗號(r.活動);
    if (選的 && !邀了.includes(選的)) return json({ ok: false }, 400);

    const 標題 = Object.keys(列[0]).filter((k) => k !== "_row");
    const c1 = 標題.indexOf("回覆");
    const c2 = 標題.indexOf("回覆時間");
    if (c1 < 0) return json({ ok: false, error: "試算表還沒有「回覆」欄" }, 500);

    const 已回 = 逗號(r.回覆);
    const 這次 = 選的 || (邀了.length === 1 ? 邀了[0] : "我要參加");
    if (!已回.includes(這次)) {
      const 全部 = [...已回, 這次].join(",");
      await updateCell(env, 分頁.邀請, `${欄名(c1)}${r._row}`, 全部);
      if (c2 >= 0) await updateCell(env, 分頁.邀請, `${欄名(c2)}${r._row}`, 台北時間());
    }

    if (env.CACHE) await env.CACHE.put(鎖, "1", { expirationTtl: 60 });
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false }, 500);
  }
}

// 0→A、25→Z、26→AA。欄位多起來之後 String.fromCharCode 會算錯
function 欄名(i) {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

// 字集刻意拿掉 0 1 i l o，念出來或手打才不會混（規格第 8 節）
function 產生代碼() {
  const A = "23456789abcdefghjkmnpqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => A[b % A.length]).join("");
}

function 台北時間() {
  return new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// 見證 PDF 的第一頁預覽。Drive 產的縮圖網址會過期，
// 所以每次快取沒中就重新問一次，抓下來自己快取一天
async function thumbProxy(fileId, env, ctx) {
  if (!/^[\w-]{10,}$/.test(fileId)) return new Response("Not found", { status: 404 });

  const cache = caches.default;
  const key = new Request(`https://thumb.local/${fileId}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  const url = await thumbnailUrl(env, fileId, 600);
  if (!url) return new Response("沒有預覽圖", { status: 404 });

  const upstream = await fetch(url);
  if (!upstream.ok) return new Response("預覽圖讀不到", { status: 502 });

  const res = new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") || "image/png",
      "cache-control": "public, max-age=86400",
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
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
