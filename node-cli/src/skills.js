// 스킬 시스템 — OpenCode 의 커스텀 커맨드와 같은 개념.
// `.cdsa/skills/` (작업 폴더) 와 `~/.cdsa_harness/skills/` (전역) 의 .md 파일을 불러온다.
// 파일명이 곧 스킬 이름이고(`/이름` 으로 실행), 본문은 모델에 전달할 프롬프트 템플릿이다.
// 본문 안의 `$ARGUMENTS` 는 `/이름 뒤에 붙인 텍스트` 로 치환된다.
//
//   ---
//   description: 파일을 읽고 3줄로 요약
//   ---
//   $ARGUMENTS 파일을 read_file 로 읽고 핵심을 한국어 3줄로 요약해줘.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function skillDirs(workspace) {
  return [
    path.join(os.homedir(), ".cdsa_harness", "skills"),
    path.join(workspace, ".cdsa", "skills"),
  ];
}

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

export function loadSkills(workspace) {
  const skills = {};
  for (const dir of skillDirs(workspace)) {
    let files = [];
    try {
      if (!fs.existsSync(dir)) continue;
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const name = f.replace(/\.md$/, "");
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        const { meta, body } = parseFrontmatter(raw);
        skills[name] = { name, description: meta.description || "", body, source: path.join(dir, f) };
      } catch {
        /* ignore unreadable skill */
      }
    }
  }
  return skills;
}

// 스킬 본문에 인자를 채워 최종 프롬프트를 만든다.
export function renderSkill(skill, args) {
  const argStr = (args || "").trim();
  if (skill.body.includes("$ARGUMENTS")) return skill.body.replace(/\$ARGUMENTS/g, argStr);
  return argStr ? `${skill.body}\n\n[추가 입력]\n${argStr}` : skill.body;
}
