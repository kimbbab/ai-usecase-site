// AX 뉴스 모음: Google 뉴스 RSS에서 모으고 Claude Haiku 5.5로 관련 없는 기사를 거르고 분류해 Supabase에 저장.
// 매일 아침 Vercel 예약 실행(vercel.json crons)이 /api/news-refresh 를 부릅니다.
import Anthropic from "@anthropic-ai/sdk";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_KEY || "";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const QUERIES = ["AX 전환", "AI 전환 기업 업무", "생성형 AI 업무 자동화", "출판 AI", "교과서 AI", "에듀테크 AI"];
export const CATS = ["기업 AX", "교육·출판", "정책·제도", "기술·도구"];
const MIN_GAP_H = 6; // 이 시간 안에 이미 모았으면 다시 모으지 않음(남용·비용 방지)

async function rest(path, opts = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, "content-type": "application/json", ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const unxml = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
const tag = (item, t) => { const m = item.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? unxml(m[1]) : ""; };

async function fetchQuery(q) {
  const u = `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:3d")}&hl=ko&gl=KR&ceid=KR:ko`;
  const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (ai-usecase-site news)" } });
  if (!r.ok) throw new Error(`rss ${r.status}`);
  return parseRss(await r.text());
}

export function parseRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 15).map(m => {
    const it = m[1], source = tag(it, "source");
    let title = unxml(tag(it, "title"));
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const d = new Date(tag(it, "pubDate"));
    return { url: tag(it, "link"), title, source, published_at: isNaN(d) ? null : d.toISOString() };
  }).filter(x => x.url.startsWith("https://") && x.title);
}

async function classify(items) {
  if (!client || !items.length) return items.map(x => ({ ...x, cat: "기타" }));
  const list = items.map((x, i) => `${i}. ${x.title} (${x.source})`).join("\n");
  const msg = await client.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 3000,
    output_config: { effort: "low" },
    system: "당신은 출판사 편집자를 위한 AX(AI 전환) 뉴스 큐레이터입니다. 기사 제목만 보고 판단합니다. 제목에 없는 내용을 지어내지 않습니다.",
    messages: [{ role: "user", content:
      `아래 기사 중 기업·기관의 AI 전환(AX), 업무에 AI를 쓰는 사례, 교육·출판 분야 AI, AI 관련 정책, 업무용 AI 도구와 관련된 것만 고르고 분류하세요.\n` +
      `광고성·주가·코인·연예·단순 행사 홍보 기사와 같은 내용의 중복 기사는 뺍니다.\n` +
      `분류는 ${CATS.join(", ")} 중 하나입니다.\n` +
      `JSON 배열만 답하세요. 예: [{"i":0,"cat":"기업 AX"},{"i":3,"cat":"교육·출판"}]\n\n${list}` }],
  });
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  try {
    const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    return arr.filter(a => items[a.i] && CATS.includes(a.cat)).map(a => ({ ...items[a.i], cat: a.cat }));
  } catch { return items.map(x => ({ ...x, cat: "기타" })); }
}

export async function refreshNews(force = false) {
  if (!URL_ || !KEY) return { error: "no_store" };
  const last = await rest("news?select=fetched_at&order=fetched_at.desc&limit=1");
  if (!force && last[0] && Date.now() - new Date(last[0].fetched_at).getTime() < MIN_GAP_H * 3600e3) return { skipped: true, last: last[0].fetched_at };
  const seen = new Set((await rest("news?select=url,title&order=fetched_at.desc&limit=600")).flatMap(x => [x.url, x.title]));
  const got = [], titles = new Set();
  for (const q of QUERIES) {
    try { for (const x of await fetchQuery(q)) { const k = x.title.replace(/\s+/g, ""); if (!seen.has(x.url) && !seen.has(x.title) && !titles.has(k)) { titles.add(k); got.push(x); } } }
    catch (e) { console.error("rss error", q, e.message); }
  }
  const picked = await classify(got.slice(0, 60));
  if (picked.length) await rest("news?on_conflict=url", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(picked) });
  return { fetched: got.length, saved: picked.length };
}

export async function handleNewsRefresh(req, res) {
  const send = (c, o) => { res.writeHead(c, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const secret = process.env.CRON_SECRET;
  const force = !!secret && req.headers.authorization === `Bearer ${secret}`;
  try { send(200, await refreshNews(force)); } catch (e) { console.error("news refresh", e.message); send(500, { error: "server" }); }
}

export async function handleNews(req, res) {
  const send = (c, o) => { res.writeHead(c, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" }); res.end(JSON.stringify(o)); };
  if (!URL_ || !KEY) return send(503, { error: "no_store" });
  try { send(200, { news: await rest("news?select=id,url,title,source,cat,published_at&order=published_at.desc.nullslast&limit=150") }); }
  catch (e) { console.error("news list", e.message); send(500, { error: "server" }); }
}
