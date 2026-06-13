// 하네스가 제공하는 도구들. 모두 작업 폴더(workspace) 안으로만 접근 제한(sandbox).
// LLM 은 생각만 하고, 실제 파일 조작/명령 실행은 전부 여기서 이뤄진다.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const TOOL_LABELS = {
  list_dir: "폴더 보기",
  read_file: "파일 읽기",
  write_file: "파일 수정",
  run_shell: "셸 실행",
};

// 사용자 승인이 필요한(환경을 바꾸는) 도구
export const MUTATING_TOOLS = new Set(["write_file", "run_shell"]);

export class ToolError extends Error {}

// 간단한 LCS 기반 unified diff (교육용 표시). +추가 / -삭제 / (공백)유지
export function diffLines(oldText, newText) {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(" " + a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push("-" + a[i]);
      i++;
    } else {
      out.push("+" + b[j]);
      j++;
    }
  }
  while (i < m) out.push("-" + a[i++]);
  while (j < n) out.push("+" + b[j++]);
  return out;
}

export class Toolbox {
  constructor(workspace, allowShell = false) {
    this.workspace = path.resolve(workspace);
    fs.mkdirSync(this.workspace, { recursive: true });
    this.allowShell = allowShell;
  }

  _resolve(rel) {
    rel = (rel || ".").trim();
    const candidate = path.resolve(this.workspace, rel);
    const root = this.workspace + path.sep;
    if (candidate !== this.workspace && !candidate.startsWith(root)) {
      throw new ToolError(
        `작업 폴더 밖 경로에는 접근할 수 없습니다: ${rel} (허용 루트: ${this.workspace})`
      );
    }
    return candidate;
  }

  rel(p) {
    const r = path.relative(this.workspace, p);
    return r === "" ? "." : r;
  }

  listDir(rel = ".") {
    const target = this._resolve(rel);
    if (!fs.existsSync(target)) throw new ToolError(`경로가 없습니다: ${rel}`);
    const stat = fs.statSync(target);
    if (stat.isFile()) return { ok: true, output: `(파일) ${this.rel(target)}` };
    const names = fs.readdirSync(target).sort();
    if (names.length === 0) return { ok: true, output: "(빈 폴더)" };
    const lines = names.map((name) => {
      const full = path.join(target, name);
      const s = fs.statSync(full);
      const kind = s.isDirectory() ? "DIR " : "FILE";
      const size = s.isDirectory() ? "" : `  ${s.size}B`;
      return `[${kind}] ${this.rel(full)}${size}`;
    });
    return { ok: true, output: lines.join("\n") };
  }

  readFile(rel) {
    const target = this._resolve(rel);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new ToolError(`파일이 없습니다: ${rel}`);
    }
    let text = fs.readFileSync(target, "utf8");
    if (text.length > 20000) text = text.slice(0, 20000) + "\n... (이후 생략)";
    return { ok: true, output: text, detail: text };
  }

  // write_file 의 '제안' 미리보기. 실제로 쓰지는 않는다.
  previewWrite(rel, content) {
    const target = this._resolve(rel);
    let old = "";
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      old = fs.readFileSync(target, "utf8");
    }
    const diff = diffLines(old, content || "").join("\n") || "(내용 변화 없음)";
    return { path: this.rel(target), diff };
  }

  writeFile(rel, content) {
    const target = this._resolve(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existed = fs.existsSync(target);
    fs.writeFileSync(target, content || "", "utf8");
    const verb = existed ? "수정" : "생성";
    return {
      ok: true,
      output: `${this.rel(target)} 파일을 ${verb}했습니다 (${(content || "").length}자).`,
      detail: content || "",
    };
  }

  runShell(command) {
    if (!this.allowShell) {
      throw new ToolError("셸 실행이 설정에서 비활성화되어 있습니다(allow_shell=false).");
    }
    if (!command || !command.trim()) throw new ToolError("실행할 명령이 비어 있습니다.");
    let out;
    let code = 0;
    try {
      out = execSync(command, {
        cwd: this.workspace,
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      code = e.status ?? 1;
      out = (e.stdout || "") + (e.stderr ? "\n[stderr]\n" + e.stderr : "");
    }
    out = (out || "").trim() || "(출력 없음)";
    if (out.length > 8000) out = out.slice(0, 8000) + "\n... (이후 생략)";
    return { ok: code === 0, output: `$ ${command}\n(exit=${code})\n${out}` };
  }

  execute(name, args = {}) {
    if (name === "list_dir") return this.listDir(args.path || ".");
    if (name === "read_file") return this.readFile(args.path || "");
    if (name === "write_file") return this.writeFile(args.path || "", args.content || "");
    if (name === "run_shell") return this.runShell(args.command || "");
    throw new ToolError(`알 수 없는 도구입니다: ${name}`);
  }
}

export function toolSchemas(allowShell = false) {
  const schemas = [
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "작업 폴더(workspace) 안의 폴더 내용을 나열한다.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "작업 폴더 기준 상대 경로. 루트는 '.'" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "작업 폴더 안의 텍스트 파일을 읽어 내용을 반환한다.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "읽을 파일의 상대 경로" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          "작업 폴더 안의 파일을 새 내용으로 만들거나 덮어쓴다. 전체 파일 내용을 content 로 전달. 사용자 승인 후 적용된다.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "저장할 파일의 상대 경로" },
            content: { type: "string", description: "파일 전체 내용" },
          },
          required: ["path", "content"],
        },
      },
    },
  ];
  if (allowShell) {
    schemas.push({
      type: "function",
      function: {
        name: "run_shell",
        description: "작업 폴더에서 셸 명령을 실행한다. 사용자 승인 후 실행된다.",
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "실행할 명령" } },
          required: ["command"],
        },
      },
    });
  }
  return schemas;
}
