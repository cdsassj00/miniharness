// 테스트용 최소 MCP stdio 서버. JSON-RPC 2.0, 줄바꿈 구분.
// initialize → tools/list → tools/call(echo) 만 구현.
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1.0.0" } } });
  } else if (msg.method === "notifications/initialized") {
    // 알림: 응답 없음
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "입력을 그대로 돌려준다",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    });
  } else if (msg.method === "tools/call") {
    const text = (msg.params && msg.params.arguments && msg.params.arguments.text) || "";
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo:${text}` }] } });
  } else if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
