// Tab 자동완성 — readline completer (의존성 0).
// 지원: /슬래시명령(내장+스킬) · /provider 인자 · @파일명 멘션(작업 폴더 최상위)
import fs from "node:fs";

export const BUILTIN_COMMANDS = [
  "/help", "/guide", "/tutorial", "/about",
  "/setup", "/provider", "/model", "/models", "/update",
  "/teach", "/stream", "/color", "/auto",
  "/context", "/status", "/cost", "/config", "/sessions",
  "/workspace", "/cd", "/init", "/memory",
  "/skills", "/plugins", "/mcp",
  "/new", "/clear", "/reset", "/compact", "/resume", "/undo",
  "/quit", "/exit",
];

// ctx: { skills(): {name:...}, workspace(): string|null, providers: string[] }
export function makeCompleter(ctx) {
  return (line) => {
    // 1) /provider <인자> 자동완성
    if (line.startsWith("/provider ")) {
      const frag = line.slice("/provider ".length);
      const hits = (ctx.providers || [])
        .filter((p) => p.startsWith(frag))
        .map((p) => "/provider " + p);
      return [hits, line];
    }
    // 2) 슬래시 명령(내장 + 스킬) — 첫 단어 입력 중일 때
    if (line.startsWith("/") && !line.includes(" ")) {
      let skills = {};
      try {
        skills = ctx.skills() || {};
      } catch { /* 초기화 전 */ }
      const names = [...new Set([...BUILTIN_COMMANDS, ...Object.keys(skills).map((s) => "/" + s)])].sort();
      const hits = names.filter((n) => n.startsWith(line));
      return [hits.length ? hits : names, line];
    }
    // 3) @파일명 멘션 — 작업 폴더 최상위 파일
    const m = /@([\w가-힣./\\-]*)$/.exec(line);
    if (m) {
      let ws = null;
      try {
        ws = ctx.workspace();
      } catch { /* 초기화 전 */ }
      if (ws) {
        let files = [];
        try {
          files = fs.readdirSync(ws).filter((f) => !f.startsWith("."));
        } catch { /* ignore */ }
        const head = line.slice(0, m.index);
        const hits = files.filter((f) => f.startsWith(m[1])).map((f) => head + "@" + f);
        return [hits, line];
      }
    }
    return [[], line];
  };
}
