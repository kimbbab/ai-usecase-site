// 코너명 회의 페이지(/corner/): 함께 고치는 회의록 + 각자 쓰는 Claude Opus 5.5 챗봇.
// 회의록은 Supabase 표 corner_minutes 에 "고칠 때마다 한 줄씩" 쌓입니다(맨 마지막 줄이 현재 회의록).
// base_id 가 unique 라서 두 사람이 같은 판을 동시에 저장하면 한 명만 들어가고, 나머지는 합쳐서 다시 저장합니다.
import Anthropic, { toFile } from "@anthropic-ai/sdk";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_KEY || "";
const hasStore = !!(URL_ && KEY);
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const MODEL = "claude-opus-5-5";

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

// ---------- 챗봇 (각자 따로, 회의록은 참고하지 않음) ----------
const SYSTEM = "당신은 Claude입니다. 출판사 편집자들이 Claude를 자유롭게 써 보는 화면입니다. 묻는 말에 한국어로 명확하고 간단하게 답하세요. 필요할 때만 목록이나 표를 쓰세요.";
const WINDOW = 10 * 60 * 1000;
const chatOk = limiter(40, WINDOW); // 사무실은 IP 하나를 여럿이 쓰므로 넉넉히
const PER_DAY = Number(process.env.CORNER_DAILY_LIMIT || 400);
let day = new Date().toDateString(), dayCount = 0;

// 첨부: 사용자 메시지에 files: [{id, kind: "image"|"pdf", name}] (먼저 /api/corner-file 로 올려 받은 id)
const FILE_ID = /^file_[A-Za-z0-9_-]{6,80}$/;
function cleanFiles(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > 5) return null;
  const out = [];
  for (const f of files) {
    if (!f || !FILE_ID.test(f.id) || !["image", "pdf"].includes(f.kind)) return null;
    out.push({ id: f.id, kind: f.kind, name: typeof f.name === "string" ? f.name.slice(0, 100) : "" });
  }
  return out;
}

function cleanMessages(body) {
  const m = Array.isArray(body?.messages) ? body.messages.slice(-30) : null;
  if (!m) return null;
  while (m.length && m[0]?.role !== "user") m.shift();
  if (!m.length) return null;
  let total = 0, nFiles = 0;
  const out = [];
  for (let i = 0; i < m.length; i++) {
    const x = m[i], want = i % 2 === 0 ? "user" : "assistant";
    if (!x || x.role !== want || typeof x.content !== "string" || !x.content.trim()) return null;
    if (x.content.length > (want === "user" ? 120000 : 40000)) return null;
    total += x.content.length;
    if (want === "assistant") { out.push({ role: "assistant", content: x.content }); continue; }
    const files = cleanFiles(x.files);
    if (!files) return null;
    nFiles += files.length;
    if (!files.length) { out.push({ role: "user", content: x.content }); continue; }
    const blocks = files.map(f => f.kind === "image"
      ? { type: "image", source: { type: "file", file_id: f.id } }
      : { type: "document", source: { type: "file", file_id: f.id }, ...(f.name ? { title: f.name } : {}) });
    blocks.push({ type: "text", text: x.content });
    out.push({ role: "user", content: blocks });
  }
  if (total > 400_000 || nFiles > 20 || m[m.length - 1].role !== "user") return null;
  return out;
}

// 파일 올리기: 이미지·PDF를 Anthropic Files API에 7일 보관으로 올리고 id만 돌려줌
// (Vercel 요청 크기 제한 4.5MB 때문에 파일 하나는 3.2MB까지)
const FILE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
const fileOk = limiter(30, 10 * 60 * 1000);
export async function handleCornerFile(req, res, readJson) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  if (!client) return send(res, 503, { error: "no_key" });
  if (!fileOk(ipOf(req))) return send(res, 429, { error: "ip" });
  let b;
  try { b = await readBody(req, readJson, 4_600_000); } catch { return send(res, 400, { error: "too_big" }); }
  const type = b?.type, name = typeof b?.name === "string" ? b.name.replace(/[\\/]/g, "_").slice(0, 100) || "file" : "file";
  if (!FILE_TYPES.includes(type) || typeof b?.data !== "string") return send(res, 400, { error: "bad_type" });
  const buf = Buffer.from(b.data, "base64");
  if (!buf.length || buf.length > 3_300_000) return send(res, 400, { error: "too_big" });
  try {
    const meta = await client.files.upload({ file: await toFile(buf, name, { type }), expires_in_seconds: 7 * 24 * 3600 });
    return send(res, 200, { id: meta.id, kind: type === "application/pdf" ? "pdf" : "image", name });
  } catch (e) {
    console.error("corner file error:", e?.status, e?.message);
    return send(res, 502, { error: "upload" });
  }
}

export async function handleCornerChat(req, res, readJson) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  if (!client) return send(res, 503, { error: "no_key" });
  if (new Date().toDateString() !== day) { day = new Date().toDateString(); dayCount = 0; }
  if (dayCount >= PER_DAY) return send(res, 429, { error: "daily" });
  if (!chatOk(ipOf(req))) return send(res, 429, { error: "ip" });
  let b;
  try { b = await readBody(req, readJson, 2_000_000); } catch { return send(res, 400, { error: "bad_json" }); }
  const messages = cleanMessages(b);
  if (!messages) return send(res, 400, { error: "bad_messages" });
  dayCount++;

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
    }, { signal: ac.signal });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") res.write(ev.delta.text);
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "max_tokens") res.write("\n\n(답이 길어 중간에 끊겼어요. '이어서 써 줘'라고 하면 계속합니다.)");
    if (final.stop_reason === "refusal") res.write("\n\n(이 질문에는 답할 수 없어요.)");
    res.end();
  } catch (e) {
    if (ac.signal.aborted) return;
    console.error("corner chat error:", e?.status, e?.message);
    if ((e?.status === 400 || e?.status === 404) && /file/i.test(e?.message || "")) res.end("\n[[FILE_GONE]]");
    else res.end("\n[[ERROR]]");
  }
}
