// 세션 로그(JSONL). 하네스는 "무슨 일이 있었는지"를 남긴다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function sessionsDir() {
  const d = path.join(os.homedir(), ".cdsa_harness", "sessions");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export class SessionLog {
  constructor(filePath) {
    this.path = filePath;
  }

  static create() {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const log = new SessionLog(path.join(sessionsDir(), `session-${ts}.jsonl`));
    log._append({ type: "session_start", time: Date.now() });
    return log;
  }

  _append(obj) {
    try {
      fs.appendFileSync(this.path, JSON.stringify(obj) + "\n", "utf8");
    } catch {
      // 로그 실패가 앱을 멈추게 하지 않는다.
    }
  }

  record(ev) {
    this._append({
      type: "event",
      time: Date.now(),
      step: ev.step,
      title: ev.title,
      detail: ev.detail,
      data: ev.data || {},
    });
  }

  close() {
    this._append({ type: "session_end", time: Date.now() });
  }
}
