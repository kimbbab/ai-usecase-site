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
