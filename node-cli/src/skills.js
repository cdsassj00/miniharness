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

// 우리 폴더 + 다른 코딩 에이전트들의 커맨드/스킬 폴더도 함께 읽어 상호운용한다.
// (Claude Code, OpenCode 등은 스킬이 결국 frontmatter 달린 마크다운이라 그대로 호환)
export function skillDirs(workspace) {
  const home = os.homedir();
  return [
    // 전역
    path.join(home, ".cdsa_harness", "skills"),
    path.join(home, ".claude", "commands"),
    path.join(home, ".config", "opencode", "command"),
    // 작업 폴더
    path.join(workspace, ".cdsa", "skills"),
    path.join(workspace, ".claude", "commands"),
    path.join(workspace, ".claude", "skills"),
    path.join(workspace, ".opencode", "command"),
    path.join(workspace, ".github", "prompts"),
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

function addSkill(skills, name, file) {
  if (!name || skills[name]) return; // 먼저 발견된 것 우선
  try {
    const raw = fs.readFileSync(file, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    skills[name] = { name, description: meta.description || "", body, source: file };
  } catch {
    /* ignore unreadable skill */
  }
}

export function loadSkills(workspace) {
  const skills = {};
  for (const dir of skillDirs(workspace)) {
    let entries = [];
    try {
      if (!fs.existsSync(dir)) continue;
      entries = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isFile() && e.endsWith(".md")) {
        addSkill(skills, e.replace(/\.md$/, ""), full);
      } else if (stat.isDirectory()) {
        // Claude Code 스킬 형식: <이름>/SKILL.md
        const skillMd = path.join(full, "SKILL.md");
        if (fs.existsSync(skillMd)) addSkill(skills, e, skillMd);
      }
    }
  }
  return skills;
}

// 스킬 본문에 인자를 채워 최종 프롬프트를 만든다. $ARGUMENTS / {{args}} 둘 다 지원.
export function renderSkill(skill, args) {
  const argStr = (args || "").trim();
  let body = skill.body;
  const hasPlaceholder = /\$ARGUMENTS|\{\{\s*args\s*\}\}/.test(body);
  if (hasPlaceholder) {
    return body.replace(/\$ARGUMENTS/g, argStr).replace(/\{\{\s*args\s*\}\}/g, argStr);
  }
  return argStr ? `${body}\n\n[추가 입력]\n${argStr}` : body;
}
