// 路由。這個檔案只做一件事：看路徑，決定交給誰。
//
// 兩套系統住在同一個 Worker：
//   邀請卡    invite.js   —— 12 碼代碼、/e/、/admin
//   心得回饋  feedback.js —— /f/ 開頭的全部
// 共用的 Google 存取在 google.js，共用的小工具在 lib.js。
//
// 加新功能前先看一眼這裡：路徑衝到了會很難查

import { 卡片, eventPage, adminPage, api, rsvp, imageProxy, thumbProxy } from "./invite.js";
import { 回饋路由 } from "./feedback.js";
import { notFound } from "./lib.js";

const CODE_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    if (path === "") {
      return Response.redirect(env.CHURCH_SITE || "https://li-ming-tjc.org", 302);
    }

    if (path === "robots.txt") {
      return new Response("User-agent: *\nDisallow: /admin\nDisallow: /f/\n", {
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

    // 公開活動頁。沒有任何個人資訊，可以貼到粉專、社群、群組
    if (path.startsWith("e/")) {
      return eventPage(decodeURIComponent(path.slice(2)), env);
    }

    // 「我要參加」是公開的，不帶金鑰——但只認得完整正確的代碼
    if (path === "api/rsvp") return rsvp(request, env);

    // 維護介面和它的 API 全在 /admin 底下，Access 才能用單一路徑一次保護到
    if (path === "admin" || path === "list") return adminPage(url, env);
    if (path.startsWith("admin/api/")) return api(path.slice(10), request, url, env);

    // 心得回饋整套都在 /f/ 底下（含 /f/admin、/f/api/…）
    if (path === "f" || path.startsWith("f/")) {
      return (await 回饋路由(path.replace(/^f\/?/, ""), request, url, env, ctx)) || notFound(env);
    }

    const code = path.toLowerCase();
    if (!CODE_RE.test(code)) return notFound(env);

    return (await 卡片(code, request, env, ctx)) || notFound(env);
  },
};
