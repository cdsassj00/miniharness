// 터미널 출력 헬퍼: ANSI 색, 박스 패널, diff 렌더. (외부 의존성 없음)

const ESC = "\x1b[";
// 런타임에 켜고 끌 수 있다(/color, --no-color). 기본은 TTY + NO_COLOR 미설정.
let colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
export function setColor(on) {
  colorEnabled = Boolean(on);
}
export function isColorOn() {
  return colorEnabled;
}

function wrap(open, close) {
  return (s) => (colorEnabled ? `${ESC}${open}m${s}${ESC}${close}m` : String(s));
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  grey: wrap(90, 39),
};

// 24bit truecolor (그라데이션 배너용). hex "#rrggbb"
export function hex(s, hexColor) {
  if (!colorEnabled) return String(s);
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hexColor);
  if (!m) return String(s);
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
  return `${ESC}38;2;${r};${g};${b}m${s}${ESC}39m`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, "");
}
// 화면상 표시 폭(한글=2칸) 계산
export function visibleWidth(s) {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0);
    w += code > 0x1100 && isWide(code) ? 2 : 1;
  }
  return w;
}
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) || // 한글 자모
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK
    (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x1f300 && code <= 0x1faff) // 이모지(대략)
  );
}

// 문자열을 표시폭 기준으로 줄바꿈(한글=2칸). ANSI 없는 평문 전용.
export function wrapToWidth(s, width) {
  if (width < 4) width = 4;
  const out = [];
  for (const rawLine of String(s).split("\n")) {
    let cur = "";
    let w = 0;
    for (const ch of rawLine) {
      const cw = ch.codePointAt(0) > 0x1100 && isWide(ch.codePointAt(0)) ? 2 : 1;
      if (w + cw > width) {
        out.push(cur);
        cur = "";
        w = 0;
      }
      cur += ch;
      w += cw;
    }
    out.push(cur);
  }
  return out;
}

// 둥근 박스 패널. lines: 문자열 배열(ANSI 포함 가능).
// 터미널 폭을 넘는 '평문' 줄은 자동 줄바꿈해 박스 밖으로 삐져나가지 않게 한다.
export function panel(lines, { title = "", color = "cyan" } = {}) {
  const paint = c[color] || ((x) => x);
  const raw = Array.isArray(lines) ? lines : String(lines).split("\n");
  const maxInner = Math.max(20, (process.stdout.columns || 80) - 4);
  // ANSI 가 없는 긴 줄만 줄바꿈(색칠된 줄은 그대로 둠)
  const body = [];
  for (const l of raw) {
    if (!ANSI_RE.test(l) && visibleWidth(l) > maxInner) body.push(...wrapToWidth(l, maxInner));
    else body.push(l);
    ANSI_RE.lastIndex = 0;
  }
  const contentWidth = Math.min(
    maxInner,
    Math.max(visibleWidth(title) + 2, ...body.map((l) => visibleWidth(l)), 10)
  );
  const top = paint("╭─ ") + paint(c.bold(title)) + paint(" " + "─".repeat(Math.max(0, contentWidth - visibleWidth(title) - 2)) + "╮");
  const bottom = paint("╰" + "─".repeat(contentWidth + 2) + "╯");
  const mid = body.map((l) => {
    const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(l)));
    return paint("│ ") + l + pad + paint(" │");
  });
  const head = title ? top : paint("╭" + "─".repeat(contentWidth + 2) + "╮");
  return [head, ...mid, bottom].join("\n");
}

// diff 문자열을 색으로 렌더 (+초록 / -빨강 / 그외 흐림)
export function renderDiff(diff) {
  return diff.split("\n").map((line) => {
    if (line.startsWith("+")) return c.green(line);
    if (line.startsWith("-")) return c.red(line);
    if (line.startsWith("@")) return c.cyan(line);
    return c.dim(line);
  });
}
