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

test("edit_file: 부분 수정 성공/유일성 검사/미존재 오류", async () => {
  const ws = tmpWs();
  fs.writeFileSync(path.join(ws, "a.txt"), "hello world\nhello again\n", "utf8");
  const tb = new Toolbox(ws);
  // 여러 번 일치 → 오류
  assert.throws(() => tb.editFile("a.txt", "hello", "bye"), /일치/);
  // 못 찾음 → 오류
  assert.throws(() => tb.editFile("a.txt", "없는텍스트", "x"), /찾지 못했/);
  // 유일 일치 → 성공
  const r = tb.editFile("a.txt", "hello world", "안녕 세계");
  assert.match(r.output, /부분 수정 완료/);
  assert.strictEqual(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "안녕 세계\nhello again\n");
  // 미리보기는 파일을 바꾸지 않는다
  const before = fs.readFileSync(path.join(ws, "a.txt"), "utf8");
  const pv = tb.previewEdit("a.txt", "hello again", "다시 안녕");
  assert.match(pv.diff, /\+다시 안녕/);
  assert.strictEqual(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), before);
});

test("search_files: 파일명·내용 검색, node_modules 제외", async () => {
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
  fs.mkdirSync(path.join(ws, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(path.join(ws, "docs", "minwon-guide.txt"), "민원 처리 절차 안내\n둘째 줄", "utf8");
  fs.writeFileSync(path.join(ws, "node_modules", "junk", "x.txt"), "민원 노이즈", "utf8");
  const tb = new Toolbox(ws);
  const r = tb.searchFiles("민원");
  assert.match(r.output, /minwon-guide\.txt/);
  assert.match(r.output, /민원 처리 절차/);
  assert.ok(!r.output.includes("node_modules"), "node_modules 는 제외");
});

test("ollama: 기본 로컬 엔드포인트 + base_url 우선", () => {
  const client = new LLMClient({ provider: "ollama", apiKey: "", model: "qwen2.5:7b" });
  assert.match(client._endpoint("ollama"), /11434\/v1\/chat\/completions/);
  const custom = new LLMClient({ provider: "ollama", apiKey: "", model: "m", baseUrl: "http://10.0.0.5:11434/v1/chat/completions" });
  assert.strictEqual(custom._endpoint("ollama"), "http://10.0.0.5:11434/v1/chat/completions");
  const cfg = new Config({ provider: "ollama" });
  assert.strictEqual(cfg.isReady(), true, "ollama 는 키 없이 사용 가능");
});

test("undo: 수정 되돌리기 + 새 파일 생성 취소", async () => {
  const ws = tmpWs();
  const tb = new Toolbox(ws);
  // 되돌릴 게 없으면 오류
  assert.throws(() => tb.undoLast(), /없습니다/);
  // 기존 파일 수정 → undo 로 원복
  fs.writeFileSync(path.join(ws, "a.txt"), "원본", "utf8");
  tb.writeFile("a.txt", "변경됨");
  assert.strictEqual(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "변경됨");
  assert.match(tb.undoLast().output, /되돌렸습니다/);
  assert.strictEqual(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "원본");
  // 새 파일 생성 → undo 로 삭제
  tb.writeFile("new.txt", "신규");
  assert.match(tb.undoLast().output, /취소/);
  assert.ok(!fs.existsSync(path.join(ws, "new.txt")));
  // edit_file 도 백업된다
  fs.writeFileSync(path.join(ws, "b.txt"), "hello world", "utf8");
  tb.editFile("b.txt", "world", "CDSA");
  tb.undoLast();
  assert.strictEqual(fs.readFileSync(path.join(ws, "b.txt"), "utf8"), "hello world");
});

test("renderMarkdown: 제목/굵게/코드/목록/펜스 마커 처리", async () => {
  const { renderMarkdown } = await import("../src/ui.js");
  const md = "# 제목\n- 항목 **중요** 사항\n`code` 와 평문\n```js\nconst a=1;\n```\n끝";
  const lines = renderMarkdown(md).join("\n");
  assert.ok(!lines.includes("# 제목"), "# 마커 제거");
  assert.ok(lines.includes("제목"));
  assert.ok(lines.includes("• "), "글머리 변환");
  assert.ok(!lines.includes("**"), "굵게 마커 제거");
  assert.ok(!/```/.test(lines), "펜스 마커 제거");
  assert.ok(lines.includes("const a=1;"), "코드 내용 유지");
  assert.ok(lines.includes("끝"));
});

test("서브에이전트: spawn_agent 위임→결과 회수, 중첩 방지, usage 합산", async () => {
  const ws = tmpWs();
  const toolsSeen = [];
  // 스크립트된 가짜 LLM: 1) 부모가 위임 2) 자식이 결과 3) 부모가 최종 보고
  const fakeClient = {
    chat: async (messages, tools) => {
      toolsSeen.push(tools.map((t) => t.function.name));
      const n = toolsSeen.length;
      if (n === 1)
        return { content: "하위에 위임합니다", toolCalls: [{ id: "s1", name: "spawn_agent", args: { task: "메모 요약", context: "배경정보" } }], usage: { input: 10, output: 5, total: 15 }, latencyMs: 1, request: {} };
      if (n === 2) {
        // 자식 프롬프트에 배경+위임 라벨이 들어갔는지 확인
        const u = messages.find((m) => m.role === "user");
        assert.match(u.content, /\[배경\]/);
        assert.match(u.content, /\[위임된 작업\]/);
        return { content: "하위 작업 결과: 요약본", toolCalls: [], usage: { input: 7, output: 3, total: 10 }, latencyMs: 1, request: {} };
      }
      return { content: "최종 보고", toolCalls: [], usage: null, latencyMs: 1, request: {} };
    },
  };
  const events = [];
  const loop = new AgentLoop({
    config: new Config({ provider: "mock", workspace: ws, max_steps: 5 }),
    client: fakeClient,
    toolbox: new Toolbox(ws),
    onEvent: (e) => events.push(e),
    approvalCallback: async () => ({ approved: true }),
  });
  const finalText = await loop.run("큰 일 시켜줘");

  assert.strictEqual(finalText, "최종 보고");
  assert.ok(toolsSeen[0].includes("spawn_agent"), "최상위엔 spawn_agent 노출");
  assert.ok(!toolsSeen[1].includes("spawn_agent"), "서브에이전트엔 미노출(중첩 방지)");
  const toolMsg = loop.messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /요약본/, "자식 결과가 부모 tool 메시지로");
  assert.ok(events.some((e) => e.data && e.data.sub), "자식 이벤트에 sub 마커");
  assert.strictEqual(loop.usage.input, 17, "usage 합산(부모10+자식7)");
  assert.strictEqual(loop.usage.calls, 3);
});

test("자동완성: 슬래시명령·스킬·/provider·@파일", async () => {
  const { makeCompleter, BUILTIN_COMMANDS } = await import("../src/completion.js");
  const ws = tmpWs();
  fs.writeFileSync(path.join(ws, "memo.txt"), "x", "utf8");
  fs.writeFileSync(path.join(ws, "민원.hwpx"), "x", "utf8");
  const comp = makeCompleter({
    skills: () => ({ minwon: {}, gongmun: {} }),
    workspace: () => ws,
    providers: ["openai", "ollama", "openrouter"],
  });
  // 슬래시: 내장+스킬 합쳐서 접두 매칭
  const [c1] = comp("/mi");
  assert.ok(c1.includes("/minwon"));
  const [c2] = comp("/mo");
  assert.ok(c2.includes("/model") && c2.includes("/models"));
  assert.ok(BUILTIN_COMMANDS.includes("/compact"));
  // /provider 인자
  const [c3] = comp("/provider ol");
  assert.deepStrictEqual(c3, ["/provider ollama"]);
  // @파일 멘션 (한글 파일 포함)
  const [c4] = comp("이거 요약해줘 @me");
  assert.deepStrictEqual(c4, ["이거 요약해줘 @memo.txt"]);
  const [c5] = comp("@민");
  assert.deepStrictEqual(c5, ["@민원.hwpx"]);
  // 일반 텍스트는 무후보
  const [c6] = comp("그냥 문장");
  assert.deepStrictEqual(c6, []);
});

test("시스템 프롬프트: 자기 사용법(MCP 설정 등) 포함", () => {
  const ws = tmpWs();
  const loop = new AgentLoop({
    config: new Config({ provider: "mock", workspace: ws }),
    client: {}, toolbox: new Toolbox(ws), onEvent: () => {}, approvalCallback: async () => ({ approved: true }),
  });
  const sp = loop._systemPrompt();
  assert.match(sp, /mcpServers/, "MCP 설정법 포함");
  assert.match(sp, /config\.json/);
  assert.match(sp, /\/models/);
  assert.match(sp, /접근할 수 없다.*답하지 마세요/s, "앵무새 방지 문구");
});

test("selectMenu: 비TTY 에선 undefined(폴백 신호)", async () => {
  const { selectMenu } = await import("../src/select.js");
  const r = await selectMenu(["a", "b"], { title: "t" });
  assert.strictEqual(r, undefined);
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
