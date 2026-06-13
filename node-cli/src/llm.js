// LLM 호출 계층. OpenAI / OpenRouter (OpenAI 호환) / Anthropic(Claude) + mock.
// Node 18+ 내장 fetch 사용 → 외부 의존성 없음.
//
// 모든 provider 의 응답을 아래 한 가지 형태로 정규화해서 돌려준다(교육 모드용 메타 포함):
//   { content, toolCalls:[{id,name,args}], usage:{input,output,total}|null,
//     latencyMs, request:{ provider, endpoint, model, temperature, toolCount, bodyBytes } }

export class LLMError extends Error {}

const ENDPOINTS = {
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
};

export class LLMClient {
  constructor({ provider, apiKey, model, temperature = 0.2, maxTokens = 1024, timeout = 60000 }) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.timeout = timeout;
  }

  async chat(messages, tools) {
    if (this.provider === "mock") return mockChat(messages);
    if (this.provider === "anthropic") return this._anthropicChat(messages, tools);
    if (ENDPOINTS[this.provider]) return this._openaiChat(messages, tools);
    throw new LLMError(`지원하지 않는 provider 입니다: ${this.provider}`);
  }

  async _post(url, headers, body) {
    const json = JSON.stringify(body);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    const started = Date.now();
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: json, signal: ctrl.signal });
    } catch (e) {
      throw new LLMError(`네트워크 오류: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMError(`API 오류 ${res.status}: ${trim(text) || res.statusText}`);
    }
    return { payload: await res.json(), latencyMs, bodyBytes: Buffer.byteLength(json, "utf8") };
  }

  // --- OpenAI / OpenRouter (chat/completions 형식) ---
  async _openaiChat(messages, tools) {
    const url = ENDPOINTS[this.provider];
    const body = { model: this.model, messages, temperature: this.temperature };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://github.com/cdsassj00/miniharness";
      headers["X-Title"] = "CDSA Harness";
    }
    const { payload, latencyMs, bodyBytes } = await this._post(url, headers, body);
    const parsed = parseOpenAiReply(payload);
    return {
      ...parsed,
      latencyMs,
      request: this._meta(url, tools, bodyBytes),
    };
  }

  // --- Anthropic (messages 형식) ---
  async _anthropicChat(messages, tools) {
    const url = ENDPOINTS.anthropic;
    const body = toAnthropicBody(messages, tools, this.model, this.temperature, this.maxTokens);
    const headers = {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
    const { payload, latencyMs, bodyBytes } = await this._post(url, headers, body);
    const parsed = parseAnthropicReply(payload);
    return {
      ...parsed,
      latencyMs,
      request: this._meta(url, tools, bodyBytes),
    };
  }

  _meta(endpoint, tools, bodyBytes) {
    return {
      provider: this.provider,
      endpoint,
      model: this.model,
      temperature: this.temperature,
      toolCount: tools ? tools.length : 0,
      bodyBytes,
    };
  }
}

function trim(s) {
  s = String(s || "");
  return s.length > 400 ? s.slice(0, 400) + " …" : s;
}

function parseOpenAiReply(payload) {
  const msg = payload?.choices?.[0]?.message;
  if (!msg) {
    throw new LLMError(`예상치 못한 응답 형식입니다: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  const toolCalls = [];
  for (const tc of msg.tool_calls || []) {
    let args = {};
    try {
      args =
        typeof tc.function?.arguments === "string"
          ? JSON.parse(tc.function.arguments || "{}")
          : tc.function?.arguments || {};
    } catch {
      args = { _raw: tc.function?.arguments };
    }
    toolCalls.push({ id: tc.id || `call_${toolCalls.length}`, name: tc.function?.name || "", args });
  }
  const u = payload.usage;
  const usage = u
    ? { input: u.prompt_tokens ?? null, output: u.completion_tokens ?? null, total: u.total_tokens ?? null }
    : null;
  return { content: msg.content ?? null, toolCalls, usage };
}

// 내부(OpenAI 형식) 메시지를 Anthropic messages 형식으로 변환.
// - system 메시지 → 최상위 system 필드
// - assistant tool_calls → content 의 tool_use 블록
// - tool 메시지 → user 의 tool_result 블록 (연속된 것은 하나의 user 로 합침)
export function toAnthropicBody(messages, tools, model, temperature, maxTokens) {
  let system = "";
  const out = [];
  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n" : "") + (m.content || "");
    } else if (m.role === "user") {
      pushUserBlock(out, { type: "text", text: m.content || "" });
    } else if (m.role === "assistant") {
      const content = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try {
          input = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
      }
      out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
    } else if (m.role === "tool") {
      pushUserBlock(out, { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content || "" });
    }
  }
  const body = { model, max_tokens: maxTokens, system, messages: out, temperature };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  return body;
}

// 직전 메시지가 user 면 블록을 이어붙이고, 아니면 새 user 메시지를 만든다.
function pushUserBlock(out, block) {
  const last = out[out.length - 1];
  if (last && last.role === "user") last.content.push(block);
  else out.push({ role: "user", content: [block] });
}

function parseAnthropicReply(payload) {
  if (payload?.type === "error") {
    throw new LLMError(`Anthropic 오류: ${payload.error?.message || JSON.stringify(payload)}`);
  }
  const blocks = payload?.content || [];
  let text = "";
  const toolCalls = [];
  for (const b of blocks) {
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, args: b.input || {} });
  }
  const u = payload?.usage;
  const usage = u
    ? {
        input: u.input_tokens ?? null,
        output: u.output_tokens ?? null,
        total: (u.input_tokens || 0) + (u.output_tokens || 0),
      }
    : null;
  return { content: text || null, toolCalls, usage };
}

// ---------------------------------------------------------------------------
// Mock 에이전트: 키 없이 Agent Loop 전체를 체험.
// 인사/잡담엔 그냥 대화로 답하고, 파일 작업을 시킬 때만 도구 데모를 돌린다.
// ---------------------------------------------------------------------------
const FILE_TASK_RE =
  /(파일|폴더|디렉|notes|\.txt|\.md|\.js|읽|쓰|수정|고치|만들|생성|추가|삭제|편집|list|read|write|만들어|적어|기록)/i;

function mockReturn(extra) {
  return { usage: null, latencyMs: 1, request: { provider: "mock", endpoint: "(mock)", model: "mock-agent", temperature: 0, toolCount: 0, bodyBytes: 0 }, ...extra };
}

function mockChat(messages) {
  const toolMsgs = messages.filter((m) => m.role === "tool");
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const phase = toolMsgs.length;

  // 아직 도구를 쓰기 전 + 파일 작업 요청이 아니면 → 그냥 대화로 응답(도구 X)
  if (phase === 0 && !FILE_TASK_RE.test(lastUser)) {
    return mockReturn({
      content:
        "안녕하세요! 저는 CDSA Harness 의 mock(연습) 에이전트예요. 실제 AI 는 아니고, " +
        "에이전트가 도구로 파일을 다루는 흐름을 보여주는 데모입니다.\n" +
        "예) \"notes.txt 맨 아래에 할 일 3개 추가해줘\" 처럼 파일 작업을 시켜보세요. " +
        "진짜 AI 와 대화하려면 /setup 으로 OpenAI·Claude 키를 연결하면 됩니다.",
      toolCalls: [],
    });
  }

  if (phase === 0) {
    return mockReturn({
      content: "작업 폴더 구조부터 확인하겠습니다.",
      toolCalls: [{ id: "mock_1", name: "list_dir", args: { path: "." } }],
    });
  }
  if (phase === 1) {
    const target = guessFile(toolMsgs[0].content || "", lastUser);
    return mockReturn({
      content: `\`${target}\` 파일을 읽어 현재 내용을 확인하겠습니다.`,
      toolCalls: [{ id: "mock_2", name: "read_file", args: { path: target } }],
    });
  }
  if (phase === 2) {
    const target = guessFile(toolMsgs[0].content || "", lastUser);
    const current = toolMsgs[1].content || "";
    const base = /파일이 없습니다|경로가 없습니다/.test(current) ? "" : current;
    const addition = `# (CDSA Harness mock 에이전트가 추가) 요청: ${lastUser.trim().slice(0, 60)}`;
    const newContent = (base.replace(/\n+$/, "") + "\n\n" + addition + "\n").replace(/^\n+/, "");
    return mockReturn({
      content: `\`${target}\` 에 메모 한 줄을 추가하는 수정을 제안합니다.`,
      toolCalls: [{ id: "mock_3", name: "write_file", args: { path: target, content: newContent } }],
    });
  }
  return mockReturn({
    content:
      "완료했습니다. 방금까지의 흐름이 바로 하네스의 Agent Loop 입니다:\n" +
      "① 폴더 보기 → ② 파일 읽기 → ③ 수정 제안 → ④ 승인 → ⑤ 저장 → ⑥ 결과를 다시 모델에 전달.\n" +
      "실제 LLM 으로 같은 흐름을 보려면 /setup 으로 키를 연결하세요.",
    toolCalls: [],
  });
}

function guessFile(listing, userText) {
  const files = [];
  for (const line of listing.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[FILE]")) {
      const rest = t.slice("[FILE]".length).trim();
      const name = rest.split("  ")[0].trim();
      if (name) files.push(name);
    }
  }
  for (const name of files) {
    if (userText.includes(name)) return name;
  }
  const m = userText.match(/[\w./-]+\.(txt|md|js|json|py|ts|csv)/i);
  if (m) return m[0];
  return files[0] || "notes.txt";
}
