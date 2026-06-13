// MCP (Model Context Protocol) 클라이언트 — 상호운용의 핵심.
// Claude Code · Cursor · Zed 등에서 쓰는 'MCP 서버'를 그대로 붙여 쓴다.
// 설정은 그 도구들과 동일한 형식:
//   "mcpServers": { "이름": { "command": "npx", "args": ["-y","..."], "env": {} } }
//
// stdio 전송(JSON-RPC 2.0, 줄바꿈 구분). 외부 의존성 없음(node child_process).
import { spawn } from "node:child_process";

const PROTOCOL_VERSION = "2024-11-05";

export class McpServer {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec || {};
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.tools = [];
  }

  async start(timeout = 20000) {
    if (!this.spec.command) throw new Error("command 가 없습니다");
    this.proc = spawn(this.spec.command, this.spec.args || [], {
      env: { ...process.env, ...(this.spec.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", () => {}); // 서버 로그는 무시
    this.proc.on("error", (e) => this._failAll(e));
    this.proc.on("exit", () => this._failAll(new Error("MCP 서버 프로세스 종료")));

    await this._request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "cdsa-harness", version: "0.5.0" } },
      timeout
    );
    this._notify("notifications/initialized", {});
    const list = await this._request("tools/list", {}, timeout);
    this.tools = (list && list.tools) || [];
    return this.tools;
  }

  _onData(chunk) {
    this.buf += chunk.toString("utf8");
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 프레이밍 깨진 줄 무시
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  _request(method, params, timeout = 20000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} 시간초과`));
      }, timeout);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.proc.stdin.write(payload);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _notify(method, params) {
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      /* ignore */
    }
  }

  _failAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  async callTool(name, args) {
    const res = await this._request("tools/call", { name, arguments: args || {} });
    const parts = ((res && res.content) || []).map((b) =>
      b.type === "text" ? b.text : b.type === "json" ? JSON.stringify(b.json) : `[${b.type}]`
    );
    const text = parts.join("\n") || (res && res.isError ? "(오류)" : "(빈 결과)");
    return res && res.isError ? `MCP 오류: ${text}` : text;
  }

  stop() {
    try {
      this.proc && this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}

// 여러 MCP 서버에 연결하고, 각 도구를 '플러그인 형식' tool def 로 변환해 돌려준다.
// (Toolbox/loop 가 플러그인과 동일하게 다룰 수 있음)
export async function connectMcpServers(servers = {}) {
  const out = { tools: [], servers: [], errors: [], instances: [] };
  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || spec.disabled) continue;
    const srv = new McpServer(name, spec);
    try {
      const tools = await srv.start();
      out.instances.push(srv);
      out.servers.push({ name, count: tools.length });
      for (const t of tools) {
        const readOnly = t.annotations && t.annotations.readOnlyHint === true;
        out.tools.push({
          name: `mcp__${name}__${t.name}`,
          description: t.description || `MCP(${name}) 도구 ${t.name}`,
          parameters: t.inputSchema || { type: "object", properties: {} },
          mutating: !readOnly, // 읽기전용 힌트가 없으면 보수적으로 승인 필요
          handler: async (args) => srv.callTool(t.name, args),
          source: `mcp:${name}`,
        });
      }
    } catch (e) {
      out.errors.push(`${name}: ${e.message}`);
      srv.stop();
    }
  }
  out.closeAll = () => out.instances.forEach((s) => s.stop());
  return out;
}
