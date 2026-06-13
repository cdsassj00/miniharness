// LLM 호출 계층. OpenAI / OpenRouter (OpenAI 호환) + 키 없이 체험하는 mock.
// Node 18+ 내장 fetch 사용 → 외부 의존성 없음.

export class LLMError extends Error {}

const ENDPOINTS = {
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

export class LLMClient {
  constructor({ provider, apiKey, model, temperature = 0.2, timeout = 60000 }) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.timeout = timeout;
  }

  async chat(messages, tools) {
    if (this.provider === "mock") return mockChat(messages);
    if (!ENDPOINTS[this.provider]) {
      throw new LLMError(`지원하지 않는 provider 입니다: ${this.provider}`);
    }
    return this._httpChat(messages, tools);
  }

  async _httpChat(messages, tools) {
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
      headers["HTTP-Referer"] = "https://github.com/cdsa-harness";
      headers["X-Title"] = "CDSA Harness";
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new LLMError(`네트워크 오류: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMError(`API 오류 ${res.status}: ${text || res.statusText}`);
    }
    const payload = await res.json();
    return parseOpenAiReply(payload);
  }
}

function parseOpenAiReply(payload) {
  const msg = payload?.choices?.[0]?.message;
  if (!msg) {
    throw new LLMError(
      `예상치 못한 응답 형식입니다: ${JSON.stringify(payload).slice(0, 300)}`
    );
  }
  const toolCalls = [];
  for (const tc of msg.tool_calls || []) {
    let args = {};
    try {
      args = typeof tc.function?.arguments === "string"
        ? JSON.parse(tc.function.arguments || "{}")
        : tc.function?.arguments || {};
    } catch {
      args = { _raw: tc.function?.arguments };
    }
    toolCalls.push({ id: tc.id || `call_${toolCalls.length}`, name: tc.function?.name || "", args });
  }
  return { content: msg.content ?? null, toolCalls };
}

// ---------------------------------------------------------------------------
// Mock 에이전트: 키 없이 Agent Loop 전체를 체험.
// 히스토리에 쌓인 tool 결과 개수로 '현재 단계'를 판단하는 결정형 에이전트.
// ---------------------------------------------------------------------------
function mockChat(messages) {
  const toolMsgs = messages.filter((m) => m.role === "tool");
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const phase = toolMsgs.length;

  if (phase === 0) {
    return {
      content: "작업 폴더 구조부터 확인하겠습니다.",
      toolCalls: [{ id: "mock_1", name: "list_dir", args: { path: "." } }],
    };
  }
  if (phase === 1) {
    const target = guessFile(toolMsgs[0].content || "", lastUser);
    return {
      content: `\`${target}\` 파일을 읽어 현재 내용을 확인하겠습니다.`,
      toolCalls: [{ id: "mock_2", name: "read_file", args: { path: target } }],
    };
  }
  if (phase === 2) {
    const target = guessFile(toolMsgs[0].content || "", lastUser);
    const current = toolMsgs[1].content || "";
    const addition = `\n\n# (CDSA Harness mock 에이전트가 추가) 요청: ${lastUser.trim().slice(0, 60)}`;
    const newContent = current.replace(/\n+$/, "") + addition + "\n";
    return {
      content: `\`${target}\` 끝에 메모 한 줄을 추가하는 수정을 제안합니다.`,
      toolCalls: [{ id: "mock_3", name: "write_file", args: { path: target, content: newContent } }],
    };
  }
  return {
    content:
      "완료했습니다. 방금까지의 흐름이 바로 하네스의 Agent Loop 입니다:\n" +
      "① 작업 폴더 보기 → ② 파일 읽기 → ③ 파일 수정 제안 → ④ 사용자 승인 → ⑤ 저장 → ⑥ 결과를 다시 모델에 전달.\n" +
      "실제 LLM 을 쓰려면 --provider openai --model ... 와 API Key 를 설정하세요.",
    toolCalls: [],
  };
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
  return files[0] || "notes.txt";
}
