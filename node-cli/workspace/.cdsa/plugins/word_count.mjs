// 예시 플러그인: 작업 폴더 안 텍스트 파일의 글자/줄/단어 수를 센다.
// 이 파일을 .cdsa/plugins/ 에 두면 자동으로 'word_count' 도구가 등록되어
// 모델이 호출할 수 있게 된다. (읽기 전용이라 mutating: false → 승인 불필요)
import fs from "node:fs";
import path from "node:path";

export default {
  name: "word_count",
  description: "작업 폴더 안 텍스트 파일의 글자수/줄수/단어수를 센다.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "작업 폴더 기준 상대 경로" } },
    required: ["path"],
  },
  mutating: false,
  async handler(args, ctx) {
    const rel = (args.path || "").trim();
    const target = path.resolve(ctx.workspace, rel);
    if (target !== ctx.workspace && !target.startsWith(ctx.workspace + path.sep)) {
      return "작업 폴더 밖 경로에는 접근할 수 없습니다.";
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return `파일이 없습니다: ${rel}`;
    }
    const text = fs.readFileSync(target, "utf8");
    const chars = text.length;
    const lines = text.split("\n").length;
    const words = (text.trim().match(/\S+/g) || []).length;
    return `${rel} → 글자 ${chars}, 줄 ${lines}, 단어 ${words}`;
  },
};
