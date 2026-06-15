// 내장 플러그인: 한컴 HWPX 문서에서 본문 텍스트를 추출한다.
// HWPX 는 ZIP 컨테이너(안에 Contents/section*.xml). 의존성 없이 zlib 로 직접 푼다.
// (구버전 .hwp 는 바이너리 OLE 포맷이라 여기서는 안내만 한다 — .hwpx 로 저장 권장)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// --- 아주 작은 ZIP 리더 (method 0=저장, 8=deflate 지원) ---
function readZipEntries(buf) {
  // End of Central Directory 찾기(뒤에서부터 시그니처 0x06054b50)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP(EOCD)을 찾을 수 없습니다 — HWPX 가 아닐 수 있어요");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // central directory 시작
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf, entry) {
  // local file header 에서 실제 데이터 시작 계산
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error("로컬 헤더 손상");
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data; // 저장(무압축)
  if (entry.method === 8) return zlib.inflateRawSync(data); // deflate
  throw new Error(`지원하지 않는 압축 방식(${entry.method})`);
}

// HWPX section XML 의 <hp:t>...</hp:t> 텍스트 런을 모아 평문으로.
function xmlToText(xml) {
  const runs = [];
  const re = /<hp:t[^>]*>([\s\S]*?)<\/hp:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) runs.push(m[1]);
  let text = runs.join("");
  if (!text) text = xml.replace(/<[^>]+>/g, ""); // 폴백: 모든 태그 제거
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#13;/g, "").replace(/&#10;/g, "\n")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export default {
  name: "hwpx_read",
  description: "한컴 HWPX(.hwpx) 문서에서 본문 텍스트를 추출한다. 구버전 .hwp 는 .hwpx 로 저장 후 사용.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "작업 폴더 기준 .hwpx 상대 경로" } },
    required: ["path"],
  },
  mutating: false,
  async handler(args, ctx) {
    const rel = (args.path || "").trim();
    const target = path.resolve(ctx.workspace, rel);
    if (target !== ctx.workspace && !target.startsWith(ctx.workspace + path.sep)) {
      return "작업 폴더 밖 경로에는 접근할 수 없습니다.";
    }
    if (/\.hwp$/i.test(rel)) {
      return "구버전 .hwp(바이너리)는 직접 지원하지 않습니다. 한컴오피스에서 '다른 이름으로 저장 → .hwpx' 후 다시 시도하세요.";
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return `파일이 없습니다: ${rel}`;
    try {
      const buf = fs.readFileSync(target);
      const entries = readZipEntries(buf);
      const sections = entries
        .filter((e) => /Contents\/section\d+\.xml$/i.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!sections.length) return "HWPX 본문(Contents/section*.xml)을 찾지 못했습니다.";
      const parts = sections.map((e) => xmlToText(extractEntry(buf, e).toString("utf8")));
      const text = parts.join("\n\n").trim();
      const clipped = text.length > 12000 ? text.slice(0, 12000) + "\n... (이후 생략)" : text;
      return `[HWPX 본문 추출: ${rel}]\n\n${clipped || "(본문 텍스트 없음)"}`;
    } catch (e) {
      return `HWPX 파싱 실패: ${e.message}`;
    }
  },
};
