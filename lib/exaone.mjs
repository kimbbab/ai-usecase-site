// K-EXAONE 2.5 (LG AI연구원) 호출. OpenAI 형식. 키는 환경변수 EXAONE_API_KEY 에만.
// 문서: https://docs.exaone.ai/ko/docs/k-exaone-2.5  (텍스트 전용, 생각은 항상 켜짐)
const KEY = process.env.EXAONE_API_KEY || "";
const URL_ = process.env.EXAONE_URL || "https://api.exaone.ai/v1/chat/completions";
export const MODEL = "k-exaone_v2.5";
export const hasExaone = !!KEY;

function request(body, signal) {
  return fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, ...body }),
    signal,
  });
}

// 한 번에 답 받기 → { text, cut }
export async function exaoneChat(messages, { effort = "low", maxTokens = 8000 } = {}) {
  if (!KEY) throw new Error("no_key");
  const r = await request({ messages, max_tokens: maxTokens, reasoning_effort: effort });
  if (!r.ok) throw Object.assign(new Error(`exaone ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: r.status });
  const c = (await r.json())?.choices?.[0];
  return { text: String(c?.message?.content || "").trim(), cut: c?.finish_reason === "length" };
}

// 흘려 받기: 답 글자가 올 때마다 onText(조각). 끝나면 { cut } (생각 과정은 보내지 않음)
export async function exaoneStream(messages, onText, { effort = "high", maxTokens = 16000, signal } = {}) {
  if (!KEY) throw new Error("no_key");
  const r = await request({ messages, max_tokens: maxTokens, reasoning_effort: effort, stream: true }, signal);
  if (!r.ok) throw Object.assign(new Error(`exaone ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: r.status });
  const dec = new TextDecoder();
  let buf = "", cut = false, started = false;
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return { cut };
      let j; try { j = JSON.parse(data); } catch { continue; }
      const c = j?.choices?.[0];
      if (!c) continue;
      let t = c.delta?.content || "";
      if (!started) { t = t.replace(/^\s+/, ""); if (t) started = true; }
      if (t) onText(t);
      if (c.finish_reason === "length") cut = true;
    }
  }
  return { cut };
}
