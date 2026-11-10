// 코너명 회의 페이지(/corner/): 함께 고치는 회의록. (함께 채팅은 lib/room.mjs)
// 회의록은 Supabase 표 corner_minutes 에 "고칠 때마다 한 줄씩" 쌓입니다(맨 마지막 줄이 현재 회의록).
// base_id 가 unique 라서 두 사람이 같은 판을 동시에 저장하면 한 명만 들어가고, 나머지는 합쳐서 다시 저장합니다.

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_KEY || "";
const hasStore = !!(URL_ && KEY);

export const DEFAULT_MINUTES = `신간 교재 코너명 회의록

(지금까지 나온 내용을 여기에 붙여 넣어 주세요. 접속한 사람 모두가 함께 고칠 수 있고, 몇 초 안에 서로의 화면에 반영됩니다.)

1. 교재 개요
-

2. 코너 목록과 후보 이름
- 코너 1:
  후보:
- 코너 2:
  후보:

3. 정해진 것

4. 더 논의할 것
`;

const ipOf = req => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

function limiter(perWindow, windowMs) {
  const hits = new Map();
  return ip => {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (list.length >= perWindow) { hits.set(ip, list); return false; }
    list.push(now); hits.set(ip, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    return true;
  };
}

async function readBody(req, readJson, limit) {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  return readJson(req, limit);
}

// ---------- 회의록 ----------
async function latest() {
  const r = await fetch(`${URL_}/rest/v1/corner_minutes?select=id,body,author,created_at&order=id.desc&limit=1`, { headers: { apikey: KEY } });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const [row] = await r.json();
  return row || { id: 0, body: DEFAULT_MINUTES, author: "", created_at: null };
}

const saveOk = limiter(400, 10 * 60 * 1000); // 타자 치는 동안 자주 저장되므로 넉넉히

export async function handleCornerMinutes(req, res, readJson) {
  if (!hasStore) return send(res, 503, { error: "no_store" });
  try {
    if (req.method === "GET") {
      const after = Number(new URL(req.url, "http://x").searchParams.get("after"));
      const row = await latest();
      if (Number.isFinite(after) && after === row.id && row.id !== 0) return send(res, 200, { same: true, id: row.id });
      return send(res, 200, row);
    }
    if (req.method !== "POST") return send(res, 405, { error: "method" });
    if (!saveOk(ipOf(req))) return send(res, 429, { error: "too_many" });
    let b;
    try { b = await readBody(req, readJson, 200_000); } catch { return send(res, 400, { error: "bad_json" }); }
    const base_id = Number(b?.base_id), body = b?.body;
    if (!Number.isInteger(base_id) || base_id < 0 || typeof body !== "string" || body.length > 50000) return send(res, 400, { error: "bad_input" });
    const author = (typeof b.author === "string" && b.author.trim().slice(0, 20)) || "익명";
    const r = await fetch(`${URL_}/rest/v1/corner_minutes`, {
      method: "POST",
      headers: { apikey: KEY, "content-type": "application/json", prefer: "return=representation" },
      body: JSON.stringify({ base_id, body, author }),
    });
    if (r.status === 409) return send(res, 409, { error: "conflict", latest: await latest() });
    if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const [row] = await r.json();
    return send(res, 200, { id: row.id, author: row.author, created_at: row.created_at });
  } catch (e) {
    console.error("corner minutes error:", e.message);
    return send(res, 500, { error: "store" });
  }
}
