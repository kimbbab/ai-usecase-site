// 챗봇 처리 (Render 서버와 Vercel 함수가 같이 씀).
// API 키는 환경변수 ANTHROPIC_API_KEY 에만 둡니다.
import Anthropic from "@anthropic-ai/sdk";
import SYSTEM from "./system-prompt.mjs";

const MODEL = "claude-haiku-5-5";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export const hasKey = !!client;

// 남용 방지: IP당 10분에 20회, 하루 DAILY_LIMIT회(기본 1000). 서버(인스턴스)마다 따로 셈.
const WINDOW = 10 * 60 * 1000, PER_IP = 20, PER_DAY = Number(process.env.DAILY_LIMIT || 1000);
const hits = new Map();
let day = new Date().toDateString(), dayCount = 0;
function allowed(ip) {
  const now = Date.now();
  if (new Date().toDateString() !== day) { day = new Date().toDateString(); dayCount = 0; hits.clear(); }
  if (dayCount >= PER_DAY) return "daily";
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (list.length >= PER_IP) { hits.set(ip, list); return "ip"; }
  list.push(now); hits.set(ip, list); dayCount++;
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < WINDOW)) hits.delete(k);
  return "ok";
}

// 입력 검사: 최근 8개, user/assistant 번갈아, 마지막은 user, 글자 수 제한
function clean(body) {
  const m = Array.isArray(body?.messages) ? body.messages.slice(-8) : null;
  if (!m) return null;
  while (m.length && m[0]?.role !== "user") m.shift();
  if (!m.length) return null;
  for (let i = 0; i < m.length; i++) {
    const x = m[i], want = i % 2 === 0 ? "user" : "assistant";
    if (!x || x.role !== want || typeof x.content !== "string") return null;
    if (!x.content.trim() || x.content.length > (want === "user" ? 500 : 3000)) return null;
  }
  if (m[m.length - 1].role !== "user") return null;
  return m.map(x => ({ role: x.role, content: x.content }));
}

function readJson(req, limit = 40_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too_big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("bad_json")); } });
    req.on("error", reject);
  });
}

export async function handleChat(req, res) {
  const fail = (code, msg) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: msg })); };
  if (req.method !== "POST") return fail(405, "method");
  if (!client) return fail(503, "no_key");
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";
  const ok = allowed(ip);
  if (ok !== "ok") return fail(429, ok);
  let body;
  try { body = req.body !== undefined ? (typeof req.body === "string" ? JSON.parse(req.body) : req.body) : await readJson(req); }
  catch (e) { return fail(400, "bad_json"); }
  const messages = clean(body);
  if (!messages) return fail(400, "bad_messages");

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
    }, { signal: ac.signal });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") res.write(ev.delta.text);
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "max_tokens") res.write("\n(답이 길어 중간에 끊겼어요. 더 좁혀서 물어봐 주세요.)");
    if (final.stop_reason === "refusal") res.write("\n(이 질문에는 답할 수 없어요.)");
    res.end();
  } catch (e) {
    if (ac.signal.aborted) return;
    console.error("chat error:", e?.status, e?.message);
    res.end("\n[[ERROR]]");
  }
}
