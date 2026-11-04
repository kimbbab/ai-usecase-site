// AX 뉴스 모음: 네이버 뉴스에서 모으고, Claude Haiku 5.5로 관련 없는 기사를 거르고 분류해 Supabase에 저장.
// 매일 아침 Vercel 예약 실행(vercel.json crons)이 /api/news-refresh 를 부릅니다.
// 필요한 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET (네이버 검색 API, 주소가 바뀌면 NAVER_NEWS_URL)
import Anthropic from "@anthropic-ai/sdk";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_KEY || "";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const QUERIES = ["AX 전환", "AI 전환 기업", "생성형 AI 업무 자동화", "출판 AI", "교과서 AI", "에듀테크 AI"];
export const CATS = ["기업 AX", "교육·출판", "정책·제도", "기술·도구"];
export const PORTALS = ["naver"];
const MIN_GAP_H = 6; // 같은 포털을 이 시간 안에 다시 모으지 않음(남용·비용 방지)
const DAYS = 3; // 최근 며칠 기사만

async function rest(path, opts = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, "content-type": "application/json", ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// 검색 결과의 <b> 강조와 HTML 문자(&quot; 등)를 걷어냄
export function clean(s = "") {
  return s.replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

// 기사 주소로 언론사 이름 찾기 (없으면 도메인)
const PRESS = {
  "chosun.com": "조선일보", "joongang.co.kr": "중앙일보", "donga.com": "동아일보", "hani.co.kr": "한겨레", "khan.co.kr": "경향신문",
  "hankookilbo.com": "한국일보", "kmib.co.kr": "국민일보", "seoul.co.kr": "서울신문", "segye.com": "세계일보", "munhwa.com": "문화일보",
  "mk.co.kr": "매일경제", "hankyung.com": "한국경제", "sedaily.com": "서울경제", "edaily.co.kr": "이데일리", "mt.co.kr": "머니투데이",
  "fnnews.com": "파이낸셜뉴스", "heraldcorp.com": "헤럴드경제", "asiae.co.kr": "아시아경제", "ajunews.com": "아주경제", "newsis.com": "뉴시스",
  "yna.co.kr": "연합뉴스", "news1.kr": "뉴스1", "etnews.com": "전자신문", "zdnet.co.kr": "지디넷코리아", "ddaily.co.kr": "디지털데일리",
  "dt.co.kr": "디지털타임스", "inews24.com": "아이뉴스24", "bloter.net": "블로터", "aitimes.com": "AI타임스", "aitimes.kr": "인공지능신문",
  "it.chosun.com": "IT조선", "byline.network": "바이라인네트워크", "veritas-a.com": "베리타스알파", "edupress.kr": "에듀프레스",
  "eduinnews.co.kr": "교육플러스", "hangyo.com": "한국교육신문", "dhnews.co.kr": "대학저널", "kbs.co.kr": "KBS", "imbc.com": "MBC",
  "sbs.co.kr": "SBS", "jtbc.co.kr": "JTBC", "ytn.co.kr": "YTN", "mbn.co.kr": "MBN", "news.kmib.co.kr": "국민일보", "bizwatch.co.kr": "비즈워치",
  "thebell.co.kr": "더벨", "newspim.com": "뉴스핌", "nocutnews.co.kr": "노컷뉴스", "ohmynews.com": "오마이뉴스", "pressian.com": "프레시안",
  "kbookpaper.com": "한국출판문화신문", "bookdb.co.kr": "북DB", "kpipa.or.kr": "한국출판문화산업진흥원",
};
export function pressOf(u) {
  try {
    const h = new URL(u).hostname.replace(/^(www|m|news|n)\./, "");
    for (const d of Object.keys(PRESS).sort((a, b) => b.length - a.length)) if (h === d || h.endsWith("." + d)) return PRESS[d];
    return h;
  } catch { return ""; }
}

const recent = d => d && !isNaN(d) && Date.now() - d.getTime() < DAYS * 864e5;

// 네이버 뉴스 검색 API (하루 25,000회 무료)
export function parseNaver(json) {
  return (json.items || []).map(it => {
    const d = new Date(it.pubDate);
    const naver = /^https:\/\/n\.news\.naver\.com\//.test(it.link || "");
    const url = naver ? it.link : (it.originallink || it.link || "");
    return { url, title: clean(it.title), summary: clean(it.description).slice(0, 200), source: pressOf(it.originallink || it.link), published_at: recent(d) ? d.toISOString() : null, portal: "naver" };
  }).filter(x => /^https?:\/\//.test(x.url) && x.title && x.published_at);
}
async function fetchNaver(q) {
  // 네이버 검색 API는 네이버 클라우드 API Hub로 옮겨짐 (api.ncloud-docs.com/docs/naver-api-hub-search-news). 주소가 또 바뀌면 NAVER_NEWS_URL로 바꿈.
  const base = process.env.NAVER_NEWS_URL || "https://naverapihub.apigw.ntruss.com/search/v1/news";
  const u = `${base}${base.includes("?") ? "&" : "?"}query=${encodeURIComponent(q)}&display=50&sort=date&format=json`;
  const id = process.env.NAVER_CLIENT_ID, secret = process.env.NAVER_CLIENT_SECRET;
  const r = await fetch(u, { headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": secret } });
  if (!r.ok) throw new Error(`naver ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return parseNaver(await r.json());
}

const FETCH = { naver: fetchNaver };
export const hasKey = p => p === "naver" && !!(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);

async function classify(items) {
  if (!client || !items.length) return [];
  const list = items.map((x, i) => `${i}. ${x.title}${x.summary ? " — " + x.summary.slice(0, 90) : ""} (${x.source})`).join("\n");
  const msg = await client.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 3000,
    output_config: { effort: "low" },
    system: "당신은 출판사 편집자를 위한 AX(AI 전환) 뉴스 큐레이터입니다. 기사 제목과 요약만 보고 판단합니다. 없는 내용을 지어내지 않습니다.",
    messages: [{ role: "user", content:
      `아래 기사 중 기업·기관의 AI 전환(AX), 업무에 AI를 쓰는 사례, 교육·출판 분야 AI, AI 관련 정책, 업무용 AI 도구와 관련된 것만 고르고 분류하세요.\n` +
      `광고성·주가·코인·연예·단순 행사 홍보·인사 동정 기사와 같은 내용의 중복 기사는 뺍니다.\n` +
      `분류는 ${CATS.join(", ")} 중 하나입니다.\n` +
      `JSON 배열만 답하세요. 예: [{"i":0,"cat":"기업 AX"},{"i":3,"cat":"교육·출판"}]\n\n${list}` }],
  });
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  try {
    const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    return arr.filter(a => items[a.i] && CATS.includes(a.cat)).map(a => ({ ...items[a.i], cat: a.cat }));
  } catch { return []; }
}

async function refreshPortal(p, force) {
  if (!hasKey(p)) return { portal: p, error: "no_key" };
  const last = await rest(`news?select=fetched_at&portal=eq.${p}&order=fetched_at.desc&limit=1`);
  if (!force && last[0] && Date.now() - new Date(last[0].fetched_at).getTime() < MIN_GAP_H * 3600e3) return { portal: p, skipped: true, last: last[0].fetched_at };
  const seen = new Set((await rest(`news?select=url,title&portal=eq.${p}&order=fetched_at.desc&limit=800`)).flatMap(x => [x.url, x.title.replace(/\s+/g, "")]));
  const got = [], titles = new Set(), errors = [];
  for (const q of QUERIES) {
    try {
      for (const x of await FETCH[p](q)) {
        const k = x.title.replace(/\s+/g, "");
        if (!seen.has(x.url) && !seen.has(k) && !titles.has(k)) { titles.add(k); got.push(x); }
      }
    } catch (e) { console.error("news fetch", p, q, e.message); if (errors.length < 2) errors.push(e.message.slice(0, 160)); }
  }
  got.sort((a, b) => b.published_at.localeCompare(a.published_at));
  const picked = await classify(got.slice(0, 70));
  if (picked.length) await rest("news?on_conflict=url", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(picked) });
  return { portal: p, fetched: got.length, saved: picked.length, ...(errors.length ? { errors } : {}) };
}

export async function refreshNews(force = false) {
  if (!URL_ || !KEY) return { error: "no_store" };
  const out = [];
  for (const p of PORTALS) {
    try { out.push(await refreshPortal(p, force)); } catch (e) { console.error("news refresh", p, e.message); out.push({ portal: p, error: "failed" }); }
  }
  return { results: out };
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
  try {
    const cols = "id,url,title,summary,source,cat,portal,published_at";
    const news = await rest(`news?select=${cols}&portal=eq.naver&order=published_at.desc.nullslast&limit=200`);
    send(200, { news });
  } catch (e) { console.error("news list", e.message); send(500, { error: "server" }); }
}
