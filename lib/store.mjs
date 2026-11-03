// 게시글 저장 (Supabase). 환경변수 SUPABASE_URL, SUPABASE_KEY(publishable 키)가 있어야 동작.
const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_KEY || "";
export const hasStore = !!(URL_ && KEY);

async function rest(path, opts = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: KEY, "content-type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

// 글쓰기 남용 방지: IP당 10분에 10건
const hits = new Map();
function allowed(ip) {
  const now = Date.now(), W = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => now - t < W);
  if (list.length >= 10) { hits.set(ip, list); return false; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < W)) hits.delete(k);
  return true;
}

const str = (v, max, min = 0) => (typeof v === "string" && v.trim().length >= min && v.length <= max ? v.trim() : null);

export async function listAll() {
  const [questions, answers, cases] = await Promise.all([
    rest("questions?select=id,title,body,author,created_at&order=created_at.desc&limit=300"),
    rest("answers?select=id,question_key,body,author,created_at&order=created_at.asc&limit=2000"),
    rest("cases?select=id,title,kind,subj,tools,team,score,body,img,author,created_at&order=created_at.desc&limit=300"),
  ]);
  return { questions, answers, cases };
}

// 챗봇에 넣을 최근 게시글 요약 (1분 캐시)
let cache = { at: 0, text: "" };
export async function recentForChat() {
  if (!hasStore) return "";
  if (Date.now() - cache.at < 60_000) return cache.text;
  try {
    const { questions, answers, cases } = await listAll();
    const ans = k => answers.filter(a => a.question_key === k).map(a => a.body.slice(0, 300)).join(" | ");
    const exAns = [...new Set(answers.filter(a => a.question_key.startsWith("ex:")).map(a => a.question_key))]
      .map(k => `- 질문 「${k.slice(3)}」에 달린 새 답변: ${ans(k)}`);
    const Q = questions.slice(0, 30).map(q => { const a = ans("q" + q.id); return `- 질문 「${q.title}」: ${q.body.slice(0, 300) || "(내용 없음)"}${a ? " / 답변: " + a : " / 아직 답변 없음"}`; });
    const C = cases.slice(0, 30).map(c => `- 사례 「${c.title}」(${c.subj}, ${c.kind}, ${c.team || "-"}, 프로그램: ${(c.tools || []).join(", ")}): ${c.body.slice(0, 400)}`);
    const text = [...C, ...Q, ...exAns].join("\n");
    cache = { at: Date.now(), text };
    return text;
  } catch (e) { console.error("recent error:", e.message); return cache.text; }
}

export async function handlePosts(req, res, readJson) {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
  if (!hasStore) return send(503, { error: "no_store" });
  try {
    if (req.method === "GET") return send(200, await listAll());
    if (req.method !== "POST") return send(405, { error: "method" });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";
    if (!allowed(ip)) return send(429, { error: "too_many" });
    let b;
    try { b = req.body !== undefined ? (typeof req.body === "string" ? JSON.parse(req.body) : req.body) : await readJson(req, 600_000); }
    catch { return send(400, { error: "bad_json" }); }
    const author = str(b?.author, 20) || "익명";
    let table, row;
    if (b?.type === "question") {
      const title = str(b.title, 120, 1), body = str(b.body ?? "", 3000);
      if (title === null || body === null) return send(400, { error: "bad_input" });
      table = "questions"; row = { title, body, author };
    } else if (b?.type === "answer") {
      const key = str(b.question_key, 140, 2), body = str(b.body, 3000, 1);
      if (!key || !/^(q\d+|ex:.+)$/.test(key) || !body) return send(400, { error: "bad_input" });
      table = "answers"; row = { question_key: key, body, author };
    } else if (b?.type === "case") {
      const title = str(b.title, 120, 1), body = str(b.body ?? "", 5000);
      const kind = ["개인", "팀 교육"].includes(b.kind) ? b.kind : null;
      const subj = ["국어", "수학", "영어", "과학", "사회", "기타"].includes(b.subj) ? b.subj : null;
      const tools = Array.isArray(b.tools) ? b.tools.filter(t => typeof t === "string" && t.trim()).slice(0, 6).map(t => t.trim().slice(0, 40)) : [];
      const team = str(b.team ?? "", 40) ?? "";
      const score = Number.isFinite(+b.score) ? Math.min(10, Math.max(0, +b.score)) : null;
      const img = b.img == null ? null : (typeof b.img === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.img) && b.img.length <= 450_000 ? b.img : undefined);
      if (title === null || body === null || !kind || !subj || img === undefined) return send(400, { error: "bad_input" });
      table = "cases"; row = { title, body, kind, subj, tools, team, score, img, author };
    } else return send(400, { error: "bad_type" });
    const [saved] = await rest(table, { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify(row) });
    cache.at = 0;
    return send(200, { ok: true, row: saved });
  } catch (e) {
    console.error("posts error:", e.message);
    return send(500, { error: "server" });
  }
}
