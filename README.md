# 콘텐츠본부 AI 활용 사례 (사이트)

- `public/` : 사이트 화면(강의 · 활용사례 · Q&A)
- `lib/chat.mjs` : 챗봇 질문을 Claude Haiku 5.5(`claude-haiku-5-5`)로 보내는 부분
- `lib/system-prompt.mjs` : 챗봇 규칙과 사이트 자료 (화면 내용을 고치면 여기도 같이 고치기)
- `lib/store.mjs` : 질문·답변·사례 저장(Supabase 프로젝트 ai-usecase-site, 서울)
- `api/chat.mjs`, `api/posts.mjs` : Vercel용 / `server.mjs` + `render.yaml` : Render용

## API 키
키는 코드에 넣지 않습니다. 배포한 곳의 환경변수 `ANTHROPIC_API_KEY`에만 넣습니다.
키가 없으면 챗봇은 "예시 답변"으로 동작합니다.
Anthropic Console에서 월 사용 한도(spend limit)를 걸어 두는 것을 권장합니다.

## 글 저장
환경변수 `SUPABASE_URL`, `SUPABASE_KEY`(publishable 키)가 있으면 질문·답변·사례가 저장되어 모두에게 보입니다. 없으면 예전처럼 화면에만 추가됩니다.
지우기·고치기는 아직 화면에 없고, Supabase 대시보드(Table Editor)에서 합니다. 글쓰기는 IP당 10분에 10건까지.
새로 올린 글은 챗봇도 1분 안에 읽어서 답에 씁니다.

## AX 뉴스
`lib/news.mjs`: 네이버 뉴스 검색 API(네이버 클라우드 API Hub)에서 AX·교육·출판 AI 기사를 모아 Claude Haiku 5.5로 관련 기사만 고르고 분류해 Supabase `news` 표(`portal` = naver)에 저장합니다.
환경변수: `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`(주소가 바뀌면 `NAVER_NEWS_URL`). 키가 없으면 건너뜁니다.
Vercel 예약 실행(`vercel.json`, 매일 22:00 UTC = 한국 07:00)이 `/api/news-refresh`를 부릅니다. 6시간 안에 이미 모았으면 다시 모으지 않습니다.

## 남용 방지
- IP당 10분에 20회, 하루 1000회(`DAILY_LIMIT`로 변경). 서버마다 따로 세므로 대략적인 제한입니다.
- 질문 500자, 최근 대화 8개까지만 전송

## 배포
- Vercel: vercel.com/new 에서 이 저장소 Import → Environment Variables에 `ANTHROPIC_API_KEY` 추가 → Deploy (설정은 기본값 그대로)
- Render: render.yaml 로 Web Service 생성 → Environment에 `ANTHROPIC_API_KEY` 추가

## 내 컴퓨터에서 실행
```
npm install
ANTHROPIC_API_KEY=... npm start   # http://localhost:3000
```

## 코너명 회의 페이지 (/corner/)
- 왼쪽 회의록: 접속한 사람 모두가 함께 고침. 2.5초마다 새 판을 받아 내 수정과 합침(diff-match-patch). 저장은 Supabase `corner_minutes` 표에 고칠 때마다 한 줄씩 쌓임(맨 끝 줄이 현재 회의록, `base_id` unique로 동시 저장 충돌 감지). 예전 판은 표에서 볼 수 있음.
- 오른쪽 '나만 엑사원' 탭: K-EXAONE 2.5(`lib/exaone.mjs`, effort high, 스트리밍), 각자 브라우저에만 대화 저장, 회의록은 보내지 않음. `/api/corner-chat`. IP당 10분 40회, 하루 `CORNER_DAILY_LIMIT`(기본 400)회.
- 파일 첨부(📎·끌어놓기·붙여넣기, 한 번에 5개, 파일당 5MB): 엑사원은 글만 읽으므로 PDF(pdf.js)·워드(mammoth)·엑셀(SheetJS)·텍스트를 브라우저에서 글자로 바꿔 질문에 붙임(15만 자까지). 이미지·스캔 PDF·hwp는 안 됨.
- 11/9 사용자 요청으로 이 페이지에서 Claude API는 뺌(사이트 메인 챗봇은 그대로).
- 표 만들기(Supabase SQL):
```sql
create table public.corner_minutes (
  id bigint generated always as identity primary key,
  base_id bigint not null unique,
  body text not null check (char_length(body) <= 50000),
  author text not null default '익명' check (char_length(author) <= 20),
  created_at timestamptz not null default now()
);
alter table public.corner_minutes enable row level security;
create policy "anyone can read corner minutes" on public.corner_minutes for select to anon using (true);
create policy "anyone can add corner minutes" on public.corner_minutes for insert to anon with check (true);
```
- 함께 채팅(오른쪽 '함께 채팅' 탭, `lib/room.mjs`, `/api/corner-room`): 참가자 모두의 단체 채팅. 글에 `@엑사원`이 있으면 최근 40개 대화를 보고 K-EXAONE 2.5(`k-exaone_v2.5`, `https://api.exaone.ai/v1/chat/completions`, OpenAI 형식, reasoning_effort low)가 답함. 환경변수 `EXAONE_API_KEY`. AI 부르기 IP당 10분 40번, 하루 `ROOM_DAILY_LIMIT`(기본 400)번.
- 함께 채팅 표(Supabase SQL):
```sql
create table public.corner_chat (
  id bigint generated always as identity primary key,
  author text not null check (char_length(author) between 1 and 20),
  body text not null check (char_length(body) between 1 and 20000),
  bot text check (bot in ('claude','exaone')),  -- claude는 예전 기록용
  reply_to bigint,
  created_at timestamptz not null default now()
);
alter table public.corner_chat enable row level security;
create policy "anyone can read corner chat" on public.corner_chat for select to anon using (true);
create policy "anyone can add corner chat" on public.corner_chat for insert to anon with check (true);
```
