// 코어 end-to-end 테스트 (node --test). UI 없이 Agent Loop 를 mock 으로 검증.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Config } from "../src/config.js";
import { LLMClient } from "../src/llm.js";
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
