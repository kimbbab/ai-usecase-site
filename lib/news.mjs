// AX 뉴스 모음: 네이버 뉴스에서 모으고, Claude Haiku 5.5로 관련 없는 기사를 거르고 분류해 Supabase에 저장.
// 매일 아침 Vercel 예약 실행(vercel.json crons)이 /api/news-refresh 를 부릅니다.
// 필요한 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET (네이버 검색 API, 주소가 바뀌면 NAVER_NEWS_URL)
import Anthropic from "@anthropic-ai/sdk";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_KEY || "";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const QUERIES = ["AX 전환", "AI 전환 기업", "생성형 AI 도입 업무", "AI 에이전트 도입", "AI 업무 자동화", "출판 AI", "AI 교과서", "에듀테크 AI"];
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
  "thelec.kr": "디일렉", "kyosu.net": "교수신문", "hansbiz.co.kr": "한스경제", "globalepic.co.kr": "글로벌이코노믹", "dailysmart.co.kr": "스마트경제",
  "venturesquare.net": "벤처스퀘어", "platum.kr": "플래텀", "itbiznews.com": "IT비즈뉴스", "boannews.com": "보안뉴스", "datanet.co.kr": "데이터넷",
  "ciokorea.com": "CIO Korea", "itworld.co.kr": "ITWorld", "edaily.co.kr": "이데일리", "news.einfomax.co.kr": "연합인포맥스", "sisajournal.com": "시사저널",
  "unn.net": "한국대학신문", "eduinnews.co.kr": "교육플러스", "edunews.co.kr": "에듀뉴스", "ebs.co.kr": "EBS", "kookje.co.kr": "국제신문", "busan.com": "부산일보",
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
  const u = `${base}${base.includes("?") ? "&" : "?"}query=${encodeURIComponent(q)}&display=100&sort=sim&format=json`;
  const id = process.env.NAVER_CLIENT_ID, secret = process.env.NAVER_CLIENT_SECRET;
  const r = await fetch(u, { headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": secret }, signal: AbortSignal.timeout(10000) });
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
    max_tokens: 1500,
    output_config: { effort: "low" },
    system: "당신은 출판사 편집자를 위한 AX(AI 전환) 뉴스 큐레이터입니다. 기사 제목과 요약만 보고 판단합니다. 없는 내용을 지어내지 않습니다.",
    messages: [{ role: "user", content:
      `아래 기사 중 AI가 기사의 중심인 것만 고르세요: 기업·기관의 AI 전환(AX), 업무에 AI를 쓰는 사례, 교육·출판 분야 AI, AI 관련 정책, 업무용 AI 도구.\n` +
      `AI가 곁가지로만 나오는 기사(실적·주가·투자·공장·설비·인사·단순 수주), 광고성·코인·연예·단순 행사 홍보 기사, 같은 내용의 중복 기사는 뺍니다. 애매하면 뺍니다.\n` +
      `분류는 ${CATS.join(", ")} 중 하나입니다.\n` +
      `JSON 배열만 답하세요. 예: [{"i":0,"cat":"기업 AX"},{"i":3,"cat":"교육·출판"}]\n\n${list}` }],
  }, { timeout: 40000, maxRetries: 0 });
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  try {
    const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    return arr.filter(a => items[a.i] && CATS.includes(a.cat)).map(a => ({ ...items[a.i], cat: a.cat }));
  } catch { return []; }
}

// ===== AI 업데이트: 새 AI 모델·기능·서비스 출시 소식 (AI 소식 화면) =====
const UPD = "AI 업데이트";
// 11/5 첫 수집분(주제와 먼 기사 섞임)은 화면에서 숨김
const AX_FROM = "2026-11-05T00:05:00Z";
const UPD_QUERIES = ["ChatGPT 새 기능", "오픈AI 출시", "클로드 출시", "앤트로픽 공개", "제미나이 새 기능", "구글 AI 출시", "코파일럿 새 기능", "하이퍼클로바X 출시", "AI 모델 공개", "AI 신기능 업데이트"];

async function classifyUpdates(items, known) {
  if (!client || !items.length) return [];
  const list = items.map((x, i) => `${i}. ${x.title}${x.summary ? " — " + x.summary.slice(0, 110) : ""} (${x.source})`).join("\n");
  const msg = await client.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 1500,
    output_config: { effort: "low" },
    system: "당신은 출판사 편집자에게 새 AI 도구 소식을 알려 주는 큐레이터입니다. 기사 제목과 요약만 보고 판단합니다. 없는 내용을 지어내지 않습니다.",
    messages: [{ role: "user", content:
      `아래 기사 중 AI 회사가 새 AI 모델, 새 기능, 새 서비스, 요금제 변화를 실제로 출시하거나 공식 발표한 기사만 고르세요. (예: "ChatGPT 이미지 2.6, GIF 만들기 기능 추가")\n` +
      `전망·칼럼·주가·투자·소송·인사·행사 홍보·루머, 기업이 AI를 도입했다는 기사는 뺍니다. 같은 소식을 다룬 기사가 여러 개면 가장 잘 설명한 기사 하나만 고릅니다.\n` +
      (known.length ? `이미 실은 소식(다시 고르지 않음): ${known.join(" / ")}\n` : "") +
      `각 항목: co=회사(OpenAI, Anthropic, Google, Microsoft, Meta, 네이버, 카카오, 삼성, LG 등), product=제품·기능 이름(짧고 구체적으로, 예: "ChatGPT"가 아니라 "ChatGPT 그룹 채팅"), what=무엇이 새로 됐는지 40자 이내 한 문장.\n` +
      `JSON 배열만 답하세요. 예: [{"i":2,"co":"OpenAI","product":"ChatGPT Images 2.6","what":"이미지로 짧은 GIF를 만드는 기능 추가"}]\n\n${list}` }],
  }, { timeout: 40000, maxRetries: 0 });
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  try {
    const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    return arr.filter(a => items[a.i] && a.co && a.product && a.what)
      .map(a => ({ ...items[a.i], cat: UPD, co: String(a.co).slice(0, 30), product: String(a.product).slice(0, 60), summary: String(a.what).slice(0, 120) }));
  } catch { return []; }
}

// 검색어 여러 개를 동시에 불러, 이미 실은 기사와 겹치는 것을 뺌
async function gather(p, queries, seen, errors) {
  const lists = await Promise.all(queries.map(q => FETCH[p](q).catch(e => { console.error("news fetch", p, q, e.message); if (errors.length < 2) errors.push(e.message.slice(0, 160)); return []; })));
  const got = [], titles = new Set();
  for (const x of lists.flat()) {
    const k = x.title.replace(/\s+/g, "");
    if (!seen.has(x.url) && !seen.has(k) && !titles.has(k)) { titles.add(k); got.push(x); }
  }
  return got.sort((a, b) => b.published_at.localeCompare(a.published_at));
}
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const fresh = (rows) => rows[0] && Date.now() - new Date(rows[0].fetched_at).getTime() < MIN_GAP_H * 3600e3;

async function refreshPortal(p, force, onlyFetch = false) {
  const t0 = Date.now();
  if (!hasKey(p)) return { portal: p, error: "no_key" };
  const lastAx = await rest(`news?select=fetched_at&portal=eq.${p}&cat=neq.${encodeURIComponent(UPD)}&fetched_at=gte.${AX_FROM}&order=fetched_at.desc&limit=1`);
  const lastUp = await rest(`news?select=fetched_at&portal=eq.${p}&cat=eq.${encodeURIComponent(UPD)}&order=fetched_at.desc&limit=1`);
  const doAx = force || !fresh(lastAx), doUp = force || !fresh(lastUp);
  if (!doAx && !doUp) return { portal: p, skipped: true, last: lastAx[0].fetched_at };
  const prev = await rest(`news?select=url,title,cat,co,product&portal=eq.${p}&order=fetched_at.desc&limit=1000`);
  const seen = new Set(prev.flatMap(x => [x.url, x.title.replace(/\s+/g, "")]));
  const known = prev.filter(x => x.cat === UPD && x.product).slice(0, 40).map(x => `${x.co} ${x.product}`);
  const errors = [], fail = tag => e => { console.error(tag, e.message); if (errors.length < 3) errors.push(tag + ": " + e.message.slice(0, 120)); return []; };
  const [ax, up] = await Promise.all([doAx ? gather(p, QUERIES, seen, errors) : [], doUp ? gather(p, UPD_QUERIES, seen, errors) : []]);
  if (onlyFetch) return { portal: p, fetched: ax.length, updates: up.length, ms: Date.now() - t0, sample: up.slice(0, 3).map(x => x.title), ...(errors.length ? { errors } : {}) };
  const axUrls = new Set();
  const [pickedAx, pickedUp] = await Promise.all([
    Promise.all(chunks(ax.slice(0, 120), 20).map(c => classify(c).catch(fail("classify")))).then(r => r.flat()),
    Promise.all(chunks(up.slice(0, 80), 40).map(c => classifyUpdates(c, known).catch(fail("updates")))).then(r => r.flat()),
  ]);
  pickedAx.forEach(x => axUrls.add(x.url));
  // 같은 제품 소식은 하나만
  const prodSeen = new Set(known.map(k => k.replace(/\s+/g, "").toLowerCase()));
  const upRows = pickedUp.filter(x => { const k = (x.co + x.product).replace(/\s+/g, "").toLowerCase(); if (prodSeen.has(k) || axUrls.has(x.url)) return false; prodSeen.add(k); return true; });
  const axRows = pickedAx.map(x => ({ ...x, co: null, product: null }));
  const rows = [...axRows, ...upRows];
  if (rows.length) await rest("news?on_conflict=url", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(rows) });
  return { portal: p, fetched: ax.length, saved: axRows.length, updates: upRows.length, ...(errors.length ? { errors } : {}) };
}

export async function refreshNews(force = false, onlyFetch = false) {
  if (!URL_ || !KEY) return { error: "no_store" };
  const out = [];
  for (const p of PORTALS) {
    try { out.push(await refreshPortal(p, force, onlyFetch)); } catch (e) { console.error("news refresh", p, e.message); out.push({ portal: p, error: "failed" }); }
  }
  return { results: out };
}

export async function handleNewsRefresh(req, res) {
  const send = (c, o) => { res.writeHead(c, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const secret = process.env.CRON_SECRET;
  const force = !!secret && req.headers.authorization === `Bearer ${secret}`;
  // ?check=1 은 모으기만 해 보고 저장·분류는 하지 않음 (점검용)
  const onlyFetch = /[?&]check=1/.test(req.url || "");
  try { send(200, await refreshNews(force || onlyFetch, onlyFetch)); } catch (e) { console.error("news refresh", e.message); send(500, { error: "server" }); }
}

export async function handleNews(req, res) {
  const send = (c, o) => { res.writeHead(c, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" }); res.end(JSON.stringify(o)); };
  if (!URL_ || !KEY) return send(503, { error: "no_store" });
  try {
    const cols = "id,url,title,summary,source,cat,co,product,portal,published_at";
    const [news, updates] = await Promise.all([
      rest(`news?select=${cols}&portal=eq.naver&cat=neq.${encodeURIComponent(UPD)}&fetched_at=gte.${AX_FROM}&order=published_at.desc.nullslast&limit=200`),
      rest(`news?select=${cols}&portal=eq.naver&cat=eq.${encodeURIComponent(UPD)}&order=published_at.desc.nullslast&limit=200`),
    ]);
    send(200, { news, updates });
  } catch (e) { console.error("news list", e.message); send(500, { error: "server" }); }
}
