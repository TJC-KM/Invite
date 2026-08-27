// 邀請卡 Worker —— 公開路徑的骨架
//
// HTML 不寫在這個檔案裡。card.html 是用 import 進來的純文字，
// 這樣裡面有多少反引號、${}、引號都不會影響 JS。

import CARD_HTML from "./card.html";
import NOTFOUND_HTML from "./notfound.html";

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
   資料層　—— 施做計畫 B6 完成後換掉這裡
   現在回傳一筆假資料，讓版面先跑起來
   ──────────────────────────────────────────────── */

async function loadInvite(code, env) {
  // TODO(B6): 先查 KV `inv:<code>`，沒有就讀試算表，讀完寫回 KV（TTL 300 秒）
  return {
    代碼: code,
    對象姓名: "王小明",
    稱謂: "先生",
    邀請人: "陳志成",
    狀態: "已發送",
    個人化開場: "",
    客製內文: "",
    活動: [
      {
        名稱: "黎明教會福音茶會「啡常時刻」",
        日期: "2026 年 9 月 13 日（日）",
        時間: "14:00 – 16:00",
        地點: "黎明教會 二樓會堂",
        標語: "人生總是在努力，但使生命不再渴的元素是什麼？<br>喝一杯咖啡，認識那位使人永不乾渴的主。",
        海報: "", // Drive 檔案 ID；空的就不顯示海報（/img 還沒做完之前先留空）
      },
    ],
    附件: [
      // { 名稱:"蘇真玉姊妹見證", 說明:"6 頁", 類型:"圖片集", 檔案:["id1","id2"], 原始檔:"pdfId" }
    ],
    信件內文: [
      "親愛的{對象}平安：",
      "有一件生命中很重要的事，我一直想找個機會跟你分享。",
      "我們平常見面聊天，談工作、家庭、生活中的大小事，彼此雖然熟悉，卻不一定有機會談到生命中最深的感受。",
      "誠摯邀請你抽空到教會坐坐，一起查考聖經、認識這位賜平安的神。",
    ],
  };
}

async function countOpen(code, invite, env) {
  // TODO(C5): 開啟次數 +1、最後開啟寫成現在時間
  // 列號跟著 inv:<code> 一起快取，省一次「找列」的查詢
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
    const 下載 = a.原始檔
      ? `<a class="attach" href="/img/${esc(a.原始檔)}" target="_blank" rel="noopener">
        <div class="ic">📄</div>
        <div><div class="t">下載完整 PDF</div><div class="s">${esc(a.說明 || "")}</div></div>
      </a>`
      : "";
    return `
  <div class="sec">
    <div class="sec-h">Enclosed</div>
    <div class="ev-name">${esc(a.名稱)}</div>
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
   圖片代理　—— 施做計畫 C3
   ──────────────────────────────────────────────── */

async function imageProxy(fileId, env, ctx) {
  if (!/^[\w-]{10,}$/.test(fileId)) return new Response("Not found", { status: 404 });

  const cache = caches.default;
  const key = new Request(`https://img.local/${fileId}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  // TODO(C3): 用服務帳戶權杖打 Drive API
  // const token = await getAccessToken(env);
  // const upstream = await fetch(
  //   `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
  //   { headers: { authorization: `Bearer ${token}` } }
  // );
  // const res = new Response(upstream.body, {
  //   headers: {
  //     "content-type": upstream.headers.get("content-type") || "image/jpeg",
  //     "cache-control": "public, max-age=86400",
  //   },
  // });
  // ctx.waitUntil(cache.put(key, res.clone()));
  // return res;

  return new Response("圖片代理還沒接上（C3）", { status: 501 });
}
