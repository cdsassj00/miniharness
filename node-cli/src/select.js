// ↑↓ 방향키 인터랙티브 선택 메뉴 (의존성 0, raw keypress).
// TTY 가 아니면 null 을 즉시 반환 → 호출측이 번호 입력 폴백을 쓴다(파이프/CI 호환).
import readline from "node:readline";
import { c } from "./ui.js";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

export function selectMenu(items, { title = "", current = null, window = 12 } = {}) {
  const stdin = process.stdin;
  const out = process.stdout;
  if (!stdin.isTTY || !out.isTTY || !items.length) return Promise.resolve(undefined); // 미지원 → 호출측 폴백

  return new Promise((resolve) => {
    let idx = items.indexOf(current);
    if (idx < 0) idx = 0;
    let rendered = 0;
    let digits = "";
    let done = false;

    const clampTop = () => {
      let top = idx - Math.floor(window / 2);
      top = Math.max(0, Math.min(top, items.length - window));
      return Math.max(0, top);
    };

    const render = () => {
      if (rendered) out.write(`\x1b[${rendered}A`);
      let n = 0;
      const line = (s) => {
        out.write("\x1b[2K" + s + "\n");
        n++;
      };
      if (title) line(c.bold(c.cyan(title)));
      const top = clampTop();
      const end = Math.min(items.length, top + window);
      if (top > 0) line(c.dim(`   ↑ ${top}개 더`));
      for (let i = top; i < end; i++) {
        const isCur = i === idx;
        const tag = items[i] === current ? c.green("  ← 현재") : "";
        const num = c.dim(String(i + 1).padStart(2) + " ");
        if (isCur) line(c.cyan(c.bold("▸ ")) + num + c.bold(c.cyan(items[i])) + tag);
        else line("  " + num + items[i] + tag);
      }
      if (end < items.length) line(c.dim(`   ↓ ${items.length - end}개 더`));
      line(c.dim("↑↓ 이동 · Enter 선택 · 숫자 바로이동 · Esc/q 취소"));
      rendered = n;
    };

    // 기존 readline(rl)의 keypress 리스너를 잠시 떼어내 이중 처리를 막는다.
    readline.emitKeypressEvents(stdin);
    const saved = stdin.rawListeners("keypress");
    for (const l of saved) stdin.removeListener("keypress", l);
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
    } catch { /* 일부 환경 */ }
    stdin.resume();
    out.write(HIDE);

    const finish = (value) => {
      if (done) return;
      done = true;
      stdin.removeListener("keypress", onKey);
      try {
        stdin.setRawMode(Boolean(wasRaw));
      } catch { /* */ }
      for (const l of saved) stdin.on("keypress", l);
      // 메뉴 지우고 선택 결과 한 줄만 남긴다
      if (rendered) out.write(`\x1b[${rendered}A`);
      for (let i = 0; i < rendered; i++) out.write("\x1b[2K\n");
      out.write(`\x1b[${rendered}A`);
      out.write(SHOW);
      if (value !== null) out.write(c.dim("선택: ") + c.green(value) + "\n");
      else out.write(c.dim("(선택 취소)") + "\n");
      resolve(value);
    };

    const onKey = (str, key) => {
      if (done) return;
      const name = key && key.name;
      if ((key && key.ctrl && name === "c") || name === "escape" || str === "q") return finish(null);
      if (name === "return" || name === "enter") {
        if (digits) {
          const n = parseInt(digits, 10);
          if (n >= 1 && n <= items.length) idx = n - 1;
          digits = "";
        }
        return finish(items[idx]);
      }
      if (name === "up" || str === "k") {
        idx = (idx - 1 + items.length) % items.length;
        digits = "";
      } else if (name === "down" || str === "j") {
        idx = (idx + 1) % items.length;
        digits = "";
      } else if (str >= "0" && str <= "9") {
        digits += str;
        const n = parseInt(digits, 10);
        if (n >= 1 && n <= items.length) idx = n - 1;
        else digits = str; // 범위 밖이면 새로 시작
        const n2 = parseInt(digits, 10);
        if (n2 >= 1 && n2 <= items.length) idx = n2 - 1;
      } else {
        return;
      }
      render();
    };

    stdin.on("keypress", onKey);
    render();
  });
}
