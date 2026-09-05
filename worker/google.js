// Google 存取層：簽 JWT → 換權杖 → 讀試算表／讀雲端硬碟
//
// Worker 不是人，沒辦法用 Google 帳號登入。做法是拿服務帳戶的私鑰簽一張
// JWT，向 Google 換一小時效期的 access token。Workers 內建 WebCrypto，
// 不需要任何第三方套件。

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  // 心得回饋要上傳檔案，所以不能只有 readonly。
  // 注意：完整範圍不等於看得到整個雲端硬碟——仍然只碰得到分享給服務帳戶的東西
  "https://www.googleapis.com/auth/drive",
].join(" ");

// 快取鍵帶著範圍的版本號。改了 SCOPES 就要跟著加號碼——
// 否則舊範圍的權杖會繼續被拿來用，症狀是莫名其妙的 403 insufficient scopes
const TOKEN_KEY = "tok:v2-drive";

// 同一個 isolate 內重複使用，省下 KV 的往返
let memoToken = null; // { token, exp }

export async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);

  if (memoToken && memoToken.exp > now + 60) return memoToken.token;

  if (env.CACHE) {
    const cached = await env.CACHE.get(TOKEN_KEY, "json");
    if (cached && cached.exp > now + 60) {
      memoToken = cached;
      return cached.token;
    }
  }

  const key = parseKey(env.GOOGLE_KEY);
  const claim = {
    iss: key.client_email,
    scope: SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const header = { alg: "RS256", typ: "JWT" };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signature = await sign(body, key.private_key);
  const assertion = `${body}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    // Google 的錯誤訊息很有用，原樣往上丟。最常見的是 invalid_grant：
    // 十之八九是私鑰格式壞了（\n 沒還原），不是權限問題
    throw new Error(`換權杖失敗 ${res.status}：${JSON.stringify(data)}`);
  }

  const token = data.access_token;
  const exp = now + (data.expires_in || 3600);
  memoToken = { token, exp };
  if (env.CACHE) {
    await env.CACHE.put(TOKEN_KEY, JSON.stringify(memoToken), {
      expirationTtl: Math.max(60, (data.expires_in || 3600) - 300),
    });
  }
  return token;
}

// secret 存的是整份服務帳戶 JSON
function parseKey(raw) {
  if (!raw) throw new Error("找不到 GOOGLE_KEY，先跑 wrangler secret put GOOGLE_KEY");
  let key;
  try {
    key = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_KEY 不是合法的 JSON，應該貼整份金鑰檔");
  }
  if (!key.client_email || !key.private_key) {
    throw new Error("GOOGLE_KEY 缺少 client_email 或 private_key");
  }
  return key;
}

async function sign(data, pem) {
  const der = pemToBinary(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data)
  );
  return b64url(sig);
}

function pemToBinary(pem) {
  // JSON 裡的私鑰是 "-----BEGIN PRIVATE KEY-----\n..." 這種形式。
  // 若金鑰被貼成單行（\n 變成字面上的反斜線 n），這裡一併救回來。
  const text = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  const body = text
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(input) {
  let bin;
  if (typeof input === "string") {
    bin = String.fromCharCode(...new TextEncoder().encode(input));
  } else {
    bin = String.fromCharCode(...new Uint8Array(input));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ── 試算表 ───────────────────────────────────── */

// 讀一張分頁，回傳物件陣列。第一列是標題列，用標題文字當 key，
// 所以欄位順序可以隨意調、加欄位也不會壞。
// 每筆多帶一個 _row（試算表列號），寫回去時才不用重新找列。
export async function readSheet(env, tab) {
  const token = await getAccessToken(env);
  const range = encodeURIComponent(`${tab}!A1:Z1000`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}` +
    `/values/${range}?majorDimension=ROWS`;

  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`讀分頁「${tab}」失敗 ${res.status}：${JSON.stringify(data)}`);

  const rows = data.values || [];
  if (!rows.length) return [];
  const head = rows[0].map((h) => String(h).trim());

  return rows.slice(1)
    .map((r, i) => {
      const o = { _row: i + 2 };
      head.forEach((h, n) => { if (h) o[h] = (r[n] ?? "").toString().trim(); });
      return o;
    })
    .filter((o) => head.some((h) => h && o[h]));  // 整列空白就跳過
}

// 更新單一儲存格。開啟次數用得到
export async function updateCell(env, tab, a1, value) {
  const token = await getAccessToken(env);
  const range = encodeURIComponent(`${tab}!${a1}`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}` +
    `/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ values: [[value]] }),
  });
  if (!res.ok) throw new Error(`寫入 ${tab}!${a1} 失敗 ${res.status}`);
}

/* ── 雲端硬碟 ─────────────────────────────────── */

// 列出資料夾內容，依檔名排序。多頁掃描件靠檔名帶頁碼決定頁序
export async function listFolder(env, folderId) {
  const token = await getAccessToken(env);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  // supportsAllDrives / includeItemsFromAllDrives：若資料夾在「共用雲端硬碟」，
  // 少了這兩個參數 Drive 會回傳空清單而且不報錯——很難查的一種錯
  const url =
    `https://www.googleapis.com/drive/v3/files?q=${q}` +
    `&fields=files(id,name,mimeType,size)&orderBy=name&pageSize=200` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true`;

  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`列出資料夾失敗 ${res.status}：${JSON.stringify(data)}`);
  return data.files || [];
}

export async function fetchFile(env, fileId) {
  const token = await getAccessToken(env);
  return fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

// 新增一列。照標題列的順序組值，所以欄位順序被調動也不會錯位
export async function appendRow(env, tab, 資料) {
  const token = await getAccessToken(env);

  const head = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}` +
      `/values/${encodeURIComponent(`${tab}!A1:Z1`)}`,
    { headers: { authorization: `Bearer ${token}` } }
  ).then((r) => r.json());

  const 標題 = (head.values && head.values[0]) || [];
  if (!標題.length) throw new Error(`分頁「${tab}」沒有標題列`);
  const values = [標題.map((h) => 資料[String(h).trim()] ?? "")];

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}` +
    `/values/${encodeURIComponent(`${tab}!A1`)}:append` +
    `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`新增到「${tab}」失敗 ${res.status}：${JSON.stringify(data)}`);
  return data;
}

// Drive 會自動幫 PDF 產第一頁的縮圖。網址是短效的，所以每次都要重新問，
// 拿到之後由 Worker 抓下來快取——外面不會看到 Google 的網址
export async function thumbnailUrl(env, fileId, size = 600) {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}` +
      `?fields=thumbnailLink&supportsAllDrives=true`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return "";
  const data = await res.json();
  if (!data.thumbnailLink) return "";
  return data.thumbnailLink.replace(/=s\d+.*$/, `=s${size}`);
}
