// 터미널 출력 헬퍼: ANSI 색, 박스 패널, diff 렌더. (외부 의존성 없음)

const ESC = "\x1b[";
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(open, close) {
  return (s) => (useColor ? `${ESC}${open}m${s}${ESC}${close}m` : String(s));
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
  if (!useColor) return String(s);
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

// 둥근 박스 패널. lines: 문자열 배열(ANSI 포함 가능)
export function panel(lines, { title = "", color = "cyan" } = {}) {
  const paint = c[color] || ((x) => x);
  const body = Array.isArray(lines) ? lines : String(lines).split("\n");
  const contentWidth = Math.max(
    visibleWidth(title) + 2,
    ...body.map((l) => visibleWidth(l)),
    10
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
