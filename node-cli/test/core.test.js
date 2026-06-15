// 코어 end-to-end 테스트 (node --test). UI 없이 Agent Loop 를 mock 으로 검증.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { connectMcpServers } from "../src/mcp.js";
import { loadPlugins } from "../src/plugins.js";
import hwpxPlugin from "../plugins/hwpx_read.mjs";

// 테스트용 최소 ZIP(저장 방식) 빌더 — HWPX 컨테이너를 흉내낸다.
function le16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function le32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function buildStoredZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.data, "utf8");
    const local = Buffer.concat([le32(0x04034b50), le16(20), le16(0), le16(0), le16(0), le16(0), le32(0), le32(data.length), le32(data.length), le16(name.length), le16(0), name, data]);
    locals.push(local);
    centrals.push(Buffer.concat([le32(0x02014b50), le16(20), le16(20), le16(0), le16(0), le16(0), le16(0), le32(0), le32(data.length), le32(data.length), le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), name]));
    offset += local.length;
  }
  const localsBuf = Buffer.concat(locals);
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([le32(0x06054b50), le16(0), le16(0), le16(files.length), le16(files.length), le32(cd.length), le32(localsBuf.length), le16(0)]);
  return Buffer.concat([localsBuf, cd, eocd]);
}

import { Config } from "../src/config.js";
import { LLMClient, toAnthropicBody } from "../src/llm.js";
import { AgentLoop, Step } from "../src/loop.js";
import { scanNodeModules } from "../src/plugins.js";
import { loadSkills, renderSkill } from "../src/skills.js";
import { Toolbox, ToolError, diffLines, toolSchemas } from "../src/tools.js";

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

test("스트리밍: onToken 으로 받은 조각의 합 = 최종 content", async () => {
  const client = new LLMClient({ provider: "mock", apiKey: "", model: "mock-agent" });
  let acc = "";
  const reply = await client.chat([{ role: "user", content: "안녕" }], [], (ch) => { acc += ch; });
  assert.strictEqual(acc, reply.content);
  assert.ok(acc.length > 0);
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

test("플러그인: 추가 도구로 등록되고 실행/스키마/승인 판정된다", async () => {
  const ws = tmpWs();
  const plugin = {
    name: "echo_upper",
    description: "대문자로",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    mutating: true,
    handler: async (args) => `RESULT:${(args.text || "").toUpperCase()}`,
  };
  const tb = new Toolbox(ws, false, [plugin, { error: "bad.js: 깨짐" }]);

  assert.strictEqual(tb.plugins.length, 1);
  assert.deepStrictEqual(tb.pluginErrors, ["bad.js: 깨짐"]);
  assert.strictEqual(tb.isMutating("echo_upper"), true); // 승인 필요
  const res = await tb.execute("echo_upper", { text: "hi" });
  assert.strictEqual(res.output, "RESULT:HI");

  // 모델에게 노출되는 스키마에도 포함
  const schemas = toolSchemas(false, tb.plugins);
  assert.ok(schemas.some((s) => s.function.name === "echo_upper"));
});

test("내장 스킬: 빈 작업폴더에서도 기본 스킬이 딸려온다(설치 시 공유)", () => {
  const skills = loadSkills(tmpWs());
  // 패키지에 동봉된 기본 스킬은 cwd 와 무관하게 로드되어야 한다.
  for (const name of ["explain", "review", "summarize", "tour", "plan", "eli5", "rubberduck", "quiz", "haiku", "todo", "loop"]) {
    assert.ok(skills[name], `${name} 내장 스킬`);
    assert.ok(skills[name].description, `${name} 설명`);
  }
});

test("스킬: 마크다운 로드 + $ARGUMENTS 치환", () => {
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, ".cdsa", "skills"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".cdsa", "skills", "greet.md"),
    "---\ndescription: 인사\n---\n$ARGUMENTS 에게 정중히 인사해줘.",
    "utf8"
  );
  const skills = loadSkills(ws);
  assert.ok(skills.greet);
  assert.strictEqual(skills.greet.description, "인사");
  assert.strictEqual(renderSkill(skills.greet, "철수"), "철수 에게 정중히 인사해줘.");
});

test("npm 플러그인 자동 발견: cdsa-harness-plugin-* 패키지를 로드", async () => {
  const ws = tmpWs();
  const nm = path.join(ws, "node_modules");
  const pkgDir = path.join(nm, "cdsa-harness-plugin-demo");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "cdsa-harness-plugin-demo", version: "1.0.0", type: "module", main: "index.mjs" }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(pkgDir, "index.mjs"),
    `export default {
       tools: [{ name: "demo_tool", description: "데모", parameters: { type: "object", properties: {} }, handler: async () => "ok" }],
       skills: [{ name: "demoskill", description: "데모 스킬", body: "데모 $ARGUMENTS" }],
     };`,
    "utf8"
  );

  const res = await scanNodeModules(nm);
  assert.ok(res.plugins.some((p) => p.name === "demo_tool"), "plugin 발견");
  assert.ok(res.skills.some((s) => s.name === "demoskill"), "skill 발견");
  const tool = res.plugins.find((p) => p.name === "demo_tool");
  assert.strictEqual(await tool.handler({}, {}), "ok");
});

test("MCP 클라이언트: 서버 연결 → 도구 발견 → 호출", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const server = path.join(here, "..", "test-fixtures", "mock-mcp-server.mjs");
  const mcp = await connectMcpServers({ mock: { command: process.execPath, args: [server] } });
  try {
    assert.strictEqual(mcp.errors.length, 0, mcp.errors.join("; "));
    assert.strictEqual(mcp.servers[0].count, 1);
    const tool = mcp.tools.find((t) => t.name === "mcp__mock__echo");
    assert.ok(tool, "echo 도구 등록됨");
    assert.strictEqual(tool.mutating, false); // readOnlyHint → 승인 불필요
    const out = await tool.handler({ text: "hi" });
    assert.strictEqual(out, "echo:hi");
  } finally {
    mcp.closeAll();
  }
});

test("내장 플러그인: 빈 폴더에서도 hwpx_read 가 로드된다", async () => {
  const plugins = await loadPlugins(tmpWs());
  assert.ok(plugins.some((p) => p.name === "hwpx_read"), "hwpx_read 내장 플러그인");
});

test("HWPX 파서: .hwpx(zip+xml)에서 본문 텍스트 추출", async () => {
  const ws = tmpWs();
  const xml = `<?xml version="1.0"?><hml><hp:p><hp:t>안녕하세요 공공기관</hp:t></hp:p><hp:p><hp:t>민원 처리 안내문입니다.</hp:t></hp:p></hml>`;
  const zip = buildStoredZip([
    { name: "Contents/section0.xml", data: xml },
    { name: "mimetype", data: "application/hwp+zip" },
  ]);
  fs.writeFileSync(path.join(ws, "doc.hwpx"), zip);
  const out = await hwpxPlugin.handler({ path: "doc.hwpx" }, { workspace: ws });
  assert.match(out, /안녕하세요 공공기관/);
  assert.match(out, /민원 처리 안내문/);
});

test(".hwp(구버전)은 안내 메시지를 준다", async () => {
  const out = await hwpxPlugin.handler({ path: "old.hwp" }, { workspace: tmpWs() });
  assert.match(out, /hwpx/i);
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
