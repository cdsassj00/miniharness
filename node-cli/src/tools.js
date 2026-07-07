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
  multi_edit: "복수 부분수정",
  search_files: "파일 검색",
  glob: "패턴 파일찾기",
  grep: "정규식 검색",
  webfetch: "웹 읽기",
  run_shell: "셸 실행",
  spawn_agent: "서브에이전트",
  todo_write: "할일 기록",
  todo_read: "할일 보기",
  question: "사용자에게 질문",
};

// 사용자 승인이 필요한(환경을 바꾸는) 도구
export const MUTATING_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "run_shell"]);

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
        `작업 폴더 밖 경로입니다: ${rel} — 현재 작업 폴더는 ${this.workspace} 입니다. 다른 폴더에서 작업하려면 사용자가 /workspace <경로> 로 변경할 수 있다고 안내하세요.`
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

  // 다단계 undo/redo — 변경 전 스냅샷을 스택에 쌓는다(최대 50). OpenCode /undo /redo 대응.
  _backup(target) {
    this.undoStack = this.undoStack || [];
    this.redoStack = [];
    this.undoStack.push({
      target,
      rel: this.rel(target),
      old: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null, // null = 새 파일이었음
    });
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  _applySnapshot(snap, intoStack) {
    const cur = fs.existsSync(snap.target) ? fs.readFileSync(snap.target, "utf8") : null;
    intoStack.push({ target: snap.target, rel: snap.rel, old: cur });
    if (snap.old === null) {
      fs.rmSync(snap.target, { force: true });
      return `${snap.rel} 생성을 취소했습니다(파일 삭제).`;
    }
    fs.mkdirSync(path.dirname(snap.target), { recursive: true });
    fs.writeFileSync(snap.target, snap.old, "utf8");
    return `${snap.rel} 을 이전 상태로 되돌렸습니다.`;
  }

  undoLast() {
    if (!this.undoStack || !this.undoStack.length) throw new ToolError("되돌릴 파일 변경이 없습니다.");
    this.redoStack = this.redoStack || [];
    const msg = this._applySnapshot(this.undoStack.pop(), this.redoStack);
    return { ok: true, output: msg + ` (undo 남은 ${this.undoStack.length} · redo 가능 ${this.redoStack.length})` };
  }

  redoLast() {
    if (!this.redoStack || !this.redoStack.length) throw new ToolError("다시 적용할 변경이 없습니다.");
    this.undoStack = this.undoStack || [];
    const snap = this.redoStack.pop();
    const cur = fs.existsSync(snap.target) ? fs.readFileSync(snap.target, "utf8") : null;
    this.undoStack.push({ target: snap.target, rel: snap.rel, old: cur });
    if (snap.old === null) fs.rmSync(snap.target, { force: true });
    else {
      fs.mkdirSync(path.dirname(snap.target), { recursive: true });
      fs.writeFileSync(snap.target, snap.old, "utf8");
    }
    return { ok: true, output: `${snap.rel} 변경을 다시 적용했습니다. (undo ${this.undoStack.length} · redo ${this.redoStack.length})` };
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

  // 한 파일에 여러 부분수정을 원자적으로(전부 성공해야 적용, 승인 1회) — OpenCode patch 대응.
  _computeMultiEdit(rel, edits) {
    const target = this._resolve(rel);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new ToolError(`파일이 없습니다: ${rel}`);
    if (!Array.isArray(edits) || !edits.length) throw new ToolError("edits 배열이 비어 있습니다.");
    const orig = fs.readFileSync(target, "utf8");
    let cur = orig;
    edits.forEach((e, i) => {
      const o = e.old_text ?? "";
      if (!o) throw new ToolError(`edits[${i}]: old_text 가 비어 있습니다.`);
      const cnt = cur.split(o).length - 1;
      if (cnt === 0) throw new ToolError(`edits[${i}]: old_text 를 찾지 못했습니다.`);
      if (cnt > 1) throw new ToolError(`edits[${i}]: old_text 가 ${cnt}번 일치 — 더 길게 지정하세요.`);
      cur = cur.replace(o, e.new_text ?? "");
    });
    return { target, orig, next: cur };
  }

  previewMultiEdit(rel, edits) {
    try {
      const { target, orig, next } = this._computeMultiEdit(rel, edits);
      return { path: this.rel(target), diff: diffLines(orig, next).filter((l) => !l.startsWith(" ")).join("\n") || "(변화 없음)" };
    } catch (e) {
      return { path: rel, diff: `(미리보기 불가: ${e.message})` };
    }
  }

  multiEdit(rel, edits) {
    const { target, next } = this._computeMultiEdit(rel, edits);
    this._backup(target);
    fs.writeFileSync(target, next, "utf8");
    return { ok: true, output: `${this.rel(target)} 에 ${edits.length}건 부분수정 적용 완료.` };
  }

  // glob 패턴 → 정규식 (** = 깊이무관, * = 세그먼트 내, ? = 한 글자)
  _globToRe(pattern) {
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "*") {
        if (pattern[i + 1] === "*") { re += "(?:.*)"; i++; if (pattern[i + 1] === "/") i++; }
        else re += "[^/]*";
      } else if (ch === "?") re += "[^/]";
      else re += ch.replace(/[.+^$()|[\]{}\\]/g, "\\$&");
    }
    return new RegExp("^" + re + "$");
  }

  _walkFiles(sub, cb) {
    const SKIP = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv"]);
    const rootDir = this._resolve(sub);
    const stack = [rootDir];
    let visited = 0;
    while (stack.length && visited < 5000) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP.has(e.name) && !e.name.startsWith(".")) stack.push(full);
        } else {
          visited++;
          if (cb(full, this.rel(full).replace(/\\/g, "/")) === false) return;
        }
      }
    }
  }

  globFiles(pattern, sub = ".") {
    if (!pattern || !pattern.trim()) throw new ToolError("pattern 이 비어 있습니다.");
    const re = this._globToRe(pattern.trim());
    const hits = [];
    this._walkFiles(sub, (full, rel) => {
      if (re.test(rel) || re.test(path.basename(rel))) {
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* */ }
        hits.push({ rel, mtime });
        if (hits.length >= 200) return false;
      }
    });
    hits.sort((a, b) => b.mtime - a.mtime);
    const out = hits.slice(0, 100).map((h) => h.rel).join("\n");
    return { ok: true, output: out || `'${pattern}' 에 맞는 파일이 없습니다.` };
  }

  grepFiles(pattern, sub = ".", fileGlob = "") {
    if (!pattern || !pattern.trim()) throw new ToolError("pattern 이 비어 있습니다.");
    let re;
    try { re = new RegExp(pattern, "i"); } catch (e) { throw new ToolError(`정규식 오류: ${e.message}`); }
    const fileRe = fileGlob ? this._globToRe(fileGlob) : null;
    const hits = [];
    this._walkFiles(sub, (full, rel) => {
      if (fileRe && !fileRe.test(rel) && !fileRe.test(path.basename(rel))) return;
      let st; try { st = fs.statSync(full); } catch { return; }
      if (st.size > 512 * 1024) return;
      let text; try { text = fs.readFileSync(full, "utf8"); } catch { return; }
      if (text.includes("\u0000")) return;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${rel}:${i + 1}  ${lines[i].trim().slice(0, 140)}`);
          if (hits.length >= 60) return false;
        }
      }
    });
    return { ok: true, output: hits.join("\n") || `/${pattern}/ 일치 없음.` };
  }

  // 웹 페이지 텍스트 읽기(태그 제거). 폐쇄망이면 네트워크 오류를 정중히 반환.
  async webFetch(url) {
    if (!/^https?:\/\//i.test(url || "")) throw new ToolError("http(s) URL 이 필요합니다.");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "cdsa-harness" } });
    } catch (e) {
      throw new ToolError(`웹 요청 실패: ${e.message} (폐쇄망일 수 있음)`);
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new ToolError(`HTTP ${res.status}`);
    let text = await res.text();
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length > 8000) text = text.slice(0, 8000) + "\n... (이후 생략)";
    return { ok: true, output: `[${url}]\n${text || "(본문 없음)"}` };
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
    if (name === "multi_edit") return this.multiEdit(args.path || "", args.edits || []);
    if (name === "search_files") return this.searchFiles(args.query || "", args.path || ".");
    if (name === "glob") return this.globFiles(args.pattern || "", args.path || ".");
    if (name === "grep") return this.grepFiles(args.pattern || "", args.path || ".", args.glob || "");
    if (name === "webfetch") return this.webFetch(args.url || "");
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
  schemas.push(
    {
      type: "function",
      function: {
        name: "multi_edit",
        description: "한 파일에 여러 부분수정을 한 번에 적용한다(전부 성공해야 적용, 승인 1회). 같은 파일을 여러 곳 고칠 때 edit_file 반복 대신 사용.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "수정할 파일 상대 경로" },
            edits: { type: "array", items: { type: "object", properties: { old_text: { type: "string" }, new_text: { type: "string" } }, required: ["old_text", "new_text"] }, description: "순서대로 적용할 치환 목록" },
          },
          required: ["path", "edits"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "글롭 패턴으로 파일을 찾는다(예: **/*.js, docs/*.md). 최신 수정순.",
        parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "시작 폴더(기본 .)" } }, required: ["pattern"] },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "정규식으로 파일 내용을 검색한다. glob 인자로 대상 파일을 좁힐 수 있다.",
        parameters: { type: "object", properties: { pattern: { type: "string", description: "정규식" }, path: { type: "string" }, glob: { type: "string", description: "대상 파일 글롭(선택)" } }, required: ["pattern"] },
      },
    },
    {
      type: "function",
      function: {
        name: "webfetch",
        description: "웹 페이지(URL)를 가져와 텍스트로 읽는다. 문서·자료 확인용. 사용자 승인 후 실행된다.",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
    },
    {
      type: "function",
      function: {
        name: "todo_write",
        description: "여러 단계 작업의 할일 목록을 기록/갱신한다. 3단계 이상 작업을 시작할 때, 그리고 각 단계 완료 시 상태를 갱신하라.",
        parameters: {
          type: "object",
          properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "done"] } }, required: ["content", "status"] } } },
          required: ["todos"],
        },
      },
    },
    { type: "function", function: { name: "todo_read", description: "현재 할일 목록을 읽는다.", parameters: { type: "object", properties: {} } } },
    {
      type: "function",
      function: {
        name: "question",
        description: "작업 진행에 꼭 필요한 결정을 사용자에게 직접 묻는다. 선택지가 있으면 choices 로 제공. 남용하지 말 것.",
        parameters: { type: "object", properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" }, description: "선택지(선택)" } }, required: ["question"] },
      },
    }
  );
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
