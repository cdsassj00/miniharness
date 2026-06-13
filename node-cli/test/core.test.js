// 코어 end-to-end 테스트 (node --test). UI 없이 Agent Loop 를 mock 으로 검증.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Config } from "../src/config.js";
import { LLMClient, toAnthropicBody } from "../src/llm.js";
import { AgentLoop, Step } from "../src/loop.js";
import { Toolbox, ToolError, diffLines } from "../src/tools.js";

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdsa-"));
}

test("sandbox: 작업 폴더 밖 접근은 막힌다", () => {
  const tb = new Toolbox(tmpWs());
  assert.throws(() => tb.readFile("../../etc/passwd"), ToolError);
});

test("diffLines: 추가/삭제 라인을 표시한다", () => {
  const d = diffLines("a\nb\n", "a\nc\n");
  assert.ok(d.some((l) => l.startsWith("-b")));
  assert.ok(d.some((l) => l.startsWith("+c")));
});

test("mock 전체 루프: 승인하면 파일이 수정된다", async () => {
  const ws = tmpWs();
  fs.writeFileSync(path.join(ws, "notes.txt"), "처음 내용\n", "utf8");
  const cfg = new Config({ provider: "mock", model: "mock-agent", workspace: ws, approval_mode: "manual", max_steps: 6 });
  const events = [];
  const loop = new AgentLoop({
    config: cfg,
    client: new LLMClient({ provider: "mock", apiKey: "", model: "mock-agent" }),
    toolbox: new Toolbox(ws),
    onEvent: (e) => events.push(e),
    approvalCallback: async () => ({ approved: true }),
  });
  await loop.run("notes.txt 에 메모를 추가해줘");

  const steps = events.map((e) => e.step);
  for (const s of [Step.USER_INPUT, Step.BUILD_CONTEXT, Step.MODEL_CALL, Step.TOOL_RUN, Step.APPROVAL, Step.DONE]) {
    assert.ok(steps.includes(s), `단계 누락: ${s}`);
  }
  const content = fs.readFileSync(path.join(ws, "notes.txt"), "utf8");
  assert.ok(content.includes("CDSA Harness mock 에이전트가 추가"));
});

test("mock: 인사에는 도구 없이 대화로만 답한다", async () => {
  const client = new LLMClient({ provider: "mock", apiKey: "", model: "mock-agent" });
  const reply = await client.chat([{ role: "user", content: "안녕" }], []);
  assert.strictEqual(reply.toolCalls.length, 0);
  assert.match(reply.content, /mock/);
});

test("정규화된 응답에 usage/latency/request 메타가 있다", async () => {
  const client = new LLMClient({ provider: "mock", apiKey: "", model: "mock-agent" });
  const reply = await client.chat([{ role: "user", content: "파일 만들어줘" }], []);
  assert.ok("usage" in reply && "latencyMs" in reply && "request" in reply);
  assert.strictEqual(reply.request.provider, "mock");
});

test("Anthropic 변환: system 분리 + tool_use/tool_result 매핑", () => {
  const messages = [
    { role: "system", content: "규칙" },
    { role: "user", content: "안녕" },
    {
      role: "assistant",
      content: "확인",
      tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    },
    { role: "tool", tool_call_id: "t1", content: "파일내용" },
  ];
  const tools = [{ type: "function", function: { name: "read_file", description: "읽기", parameters: { type: "object" } } }];
  const body = toAnthropicBody(messages, tools, "claude-x", 0.2, 1024);

  assert.strictEqual(body.system, "규칙");
  assert.strictEqual(body.messages[0].role, "user");
  // assistant turn 에 tool_use 블록
  const asst = body.messages.find((m) => m.role === "assistant");
  assert.ok(asst.content.some((b) => b.type === "tool_use" && b.name === "read_file"));
  // tool 결과는 user 의 tool_result 블록으로
  const toolResult = body.messages.find((m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"));
  assert.ok(toolResult);
  // tools 스키마 변환(input_schema)
  assert.strictEqual(body.tools[0].name, "read_file");
  assert.ok(body.tools[0].input_schema);
});

test("거부하면 파일은 그대로다", async () => {
  const ws = tmpWs();
  const original = "건드리면 안 됨\n";
  fs.writeFileSync(path.join(ws, "notes.txt"), original, "utf8");
  const cfg = new Config({ provider: "mock", workspace: ws, approval_mode: "manual", max_steps: 6 });
  const loop = new AgentLoop({
    config: cfg,
    client: new LLMClient({ provider: "mock", apiKey: "", model: "mock-agent" }),
    toolbox: new Toolbox(ws),
    onEvent: () => {},
    approvalCallback: async () => ({ approved: false, reason: "거부" }),
  });
  await loop.run("notes.txt 수정해줘");
  assert.strictEqual(fs.readFileSync(path.join(ws, "notes.txt"), "utf8"), original);
});
