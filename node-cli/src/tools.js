// 하네스가 제공하는 도구들. 모두 작업 폴더(workspace) 안으로만 접근 제한(sandbox).
// LLM 은 생각만 하고, 실제 파일 조작/명령 실행은 전부 여기서 이뤄진다.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const TOOL_LABELS = {
  list_dir: "폴더 보기",
  read_file: "파일 읽기",
  write_file: "파일 쓰기",
  edit_file: "부분 수정",
  search_files: "파일 검색",
  run_shell: "셸 실행",
  spawn_agent: "서브에이전트",
};

// 사용자 승인이 필요한(환경을 바꾸는) 도구
export const MUTATING_TOOLS = new Set(["write_file", "edit_file", "run_shell"]);

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
  constructor(workspace, allowShell = false, plugins = []) {
    this.workspace = path.resolve(workspace);
    fs.mkdirSync(this.workspace, { recursive: true });
    this.allowShell = allowShell;
    // 정상 로드된 플러그인만 도구로 사용(로드 에러는 따로 보관해 표시). 이름 중복은 먼저 것 우선.
    const seen = new Set();
    this.plugins = plugins.filter(
      (p) => p && p.name && typeof p.handler === "function" && !seen.has(p.name) && seen.add(p.name)
    );
    this.pluginErrors = plugins.filter((p) => p && p.error).map((p) => p.error);
    this._pluginMap = new Map(this.plugins.map((p) => [p.name, p]));
  }

  // 실행 전 사용자 승인이 필요한 도구인가? (환경을 바꾸는 내장 도구 + mutating 플러그인)
  isMutating(name) {
    if (MUTATING_TOOLS.has(name)) return true;
    const p = this._pluginMap.get(name);
    return Boolean(p && p.mutating);
  }

  label(name) {
    if (TOOL_LABELS[name]) return TOOL_LABELS[name];
    const p = this._pluginMap.get(name);
    return p ? `플러그인:${name}` : name;
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

  // /undo 용: 마지막 파일 변경 1건을 기억해 되돌릴 수 있게 한다(단순 프리미티브).
  _backup(target) {
    this.lastChange = {
      target,
      rel: this.rel(target),
      old: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null, // null = 새 파일이었음
    };
  }

  undoLast() {
    if (!this.lastChange) throw new ToolError("되돌릴 파일 변경이 없습니다.");
    const { target, rel, old } = this.lastChange;
    this.lastChange = null;
    if (old === null) {
      fs.rmSync(target, { force: true });
      return { ok: true, output: `${rel} 생성을 취소했습니다(파일 삭제).` };
    }
    fs.writeFileSync(target, old, "utf8");
    return { ok: true, output: `${rel} 을 마지막 변경 이전 상태로 되돌렸습니다.` };
  }

  writeFile(rel, content) {
    const target = this._resolve(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existed = fs.existsSync(target);
    this._backup(target);
    fs.writeFileSync(target, content || "", "utf8");
    const verb = existed ? "수정" : "생성";
    return {
      ok: true,
      output: `${this.rel(target)} 파일을 ${verb}했습니다 (${(content || "").length}자).`,
      detail: content || "",
    };
  }

  // 부분 수정: old_text 를 딱 한 번 찾아 new_text 로 바꾼다(전체 덮어쓰기 불필요).
  _computeEdit(rel, oldText, newText) {
    const target = this._resolve(rel);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new ToolError(`파일이 없습니다: ${rel}`);
    }
    if (!oldText) throw new ToolError("old_text 가 비어 있습니다.");
    const cur = fs.readFileSync(target, "utf8");
    const count = cur.split(oldText).length - 1;
    if (count === 0) throw new ToolError("old_text 를 파일에서 찾지 못했습니다. 파일을 다시 read_file 로 확인하세요.");
    if (count > 1) throw new ToolError(`old_text 가 ${count}번 일치합니다 — 주변 문맥을 포함해 더 길게 지정하세요.`);
    return { target, cur, next: cur.replace(oldText, newText ?? "") };
  }

  previewEdit(rel, oldText, newText) {
    try {
      const { target, cur, next } = this._computeEdit(rel, oldText, newText);
      return { path: this.rel(target), diff: diffLines(cur, next).filter((l) => !l.startsWith(" ")).join("\n") || "(변화 없음)" };
    } catch (e) {
      return { path: rel, diff: `(미리보기 불가: ${e.message})` };
    }
  }

  editFile(rel, oldText, newText) {
    const { target, next } = this._computeEdit(rel, oldText, newText);
    this._backup(target);
    fs.writeFileSync(target, next, "utf8");
    return { ok: true, output: `${this.rel(target)} 부분 수정 완료 (old ${oldText.length}자 → new ${(newText ?? "").length}자).` };
  }

  // 파일명 + 내용 검색(재귀). node_modules/.git 등 노이즈 제외, 대소문자 무시.
  searchFiles(query, sub = ".") {
    if (!query || !query.trim()) throw new ToolError("검색어가 비어 있습니다.");
    const q = query.toLowerCase();
    const rootDir = this._resolve(sub);
    const SKIP = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv"]);
    const nameHits = [];
    const contentHits = [];
    let scanned = 0;
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (scanned > 2000 || contentHits.length >= 40) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(full);
          continue;
        }
        scanned++;
        const rel = this.rel(full);
        if (e.name.toLowerCase().includes(q)) nameHits.push(rel);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.size > 512 * 1024) continue; // 큰 파일 스킵
        let text;
        try {
          text = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (text.includes(" ")) continue; // 바이너리 스킵
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && contentHits.length < 40; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            contentHits.push(`${rel}:${i + 1}  ${lines[i].trim().slice(0, 120)}`);
          }
        }
      }
    };
    walk(rootDir);
    const parts = [];
    if (nameHits.length) parts.push(`[파일명 일치 ${nameHits.length}건]\n` + nameHits.slice(0, 20).join("\n"));
    if (contentHits.length) parts.push(`[내용 일치]\n` + contentHits.join("\n"));
    return { ok: true, output: parts.join("\n\n") || `'${query}' 검색 결과가 없습니다.` };
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

  async execute(name, args = {}) {
    if (name === "list_dir") return this.listDir(args.path || ".");
    if (name === "read_file") return this.readFile(args.path || "");
    if (name === "write_file") return this.writeFile(args.path || "", args.content || "");
    if (name === "edit_file") return this.editFile(args.path || "", args.old_text || "", args.new_text ?? "");
    if (name === "search_files") return this.searchFiles(args.query || "", args.path || ".");
    if (name === "run_shell") return this.runShell(args.command || "");
    const plugin = this._pluginMap.get(name);
    if (plugin) {
      let result;
      try {
        result = await plugin.handler(args, { workspace: this.workspace });
      } catch (e) {
        throw new ToolError(`플러그인 '${name}' 실행 오류: ${e.message}`);
      }
      const output = typeof result === "string" ? result : result?.output ?? JSON.stringify(result);
      return { ok: true, output: String(output) };
    }
    throw new ToolError(`알 수 없는 도구입니다: ${name}`);
  }
}

export function toolSchemas(allowShell = false, plugins = []) {
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
          "새 파일을 만들거나 파일 전체를 덮어쓴다. 기존 파일의 일부만 고칠 땐 write_file 대신 edit_file 을 써라. 사용자 승인 후 적용된다.",
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
    {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "기존 파일의 일부만 수정한다(권장). old_text 는 파일 안에서 정확히 한 번만 일치해야 하며 new_text 로 치환된다. 사용자 승인 후 적용된다.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "수정할 파일의 상대 경로" },
            old_text: { type: "string", description: "바꿀 기존 텍스트(문맥 포함, 파일에서 유일해야 함)" },
            new_text: { type: "string", description: "새 텍스트" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_files",
        description: "작업 폴더에서 파일명·파일내용을 재귀 검색한다(대소문자 무시). 어떤 파일에 뭐가 있는지 찾을 때 사용.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "검색어" },
            path: { type: "string", description: "검색 시작 폴더(기본 '.')" },
          },
          required: ["query"],
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
  // 플러그인이 제공하는 도구를 모델에게도 노출한다.
  for (const p of plugins) {
    if (!p || !p.name || typeof p.handler !== "function") continue;
    schemas.push({
      type: "function",
      function: {
        name: p.name,
        description: (p.description || `플러그인 도구 ${p.name}`) + (p.mutating ? " (승인 필요)" : ""),
        parameters: p.parameters || { type: "object", properties: {} },
      },
    });
  }
  return schemas;
}
