// 兩套系統（邀請卡、心得回饋）都會用到的小工具。
//
// 這裡只放「跟哪一套無關」的東西：跳脫、填樣板、日期、代碼、JSON 回應。
// 只要開始冒出「這個函式是給回饋用的」念頭，就該搬去 feedback.js

import NOTFOUND_HTML from "./notfound.html";

export function fill(tpl, data) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in data ? String(data[k]) : ""));
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

export function notFound(env) {
  return new Response(fill(NOTFOUND_HTML, {
    churchSite: esc((env && env.CHURCH_SITE) || "https://li-ming-tjc.org"),
  }), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// LINE、Facebook 那類預覽爬蟲：照樣給網頁，但不算開啟次數
export function isPreviewBot(ua) {
  return /line|facebookexternalhit|twitterbot|slackbot|whatsapp|discordbot|bot|crawler|spider/i.test(ua || "");
}

export function 欄名(i) {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

// 字集刻意拿掉 0 1 i l o，念出來或手打才不會混（規格第 8 節）
export function 產生代碼() {
  const A = "23456789abcdefghjkmnpqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => A[b % A.length]).join("");
}

export function 台北時間() {
  return new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function 代入(樣板, 變數) {
  // 不能用 \w——JS 的 \w 只認 ASCII，{活動} 這種中文變數名一個都比對不到
  return String(樣板).replace(/\{([^{}]{1,20})\}/g, (m, k) => (k in 變數 ? String(變數[k]) : m));
}

// 台北的今天，格式 2026-08-28。sv-SE 的日期寫法剛好就是 ISO
export function 台北日期() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
}
