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
import { fileURLToPath } from "node:url";

// 패키지에 동봉된 기본(내장) 스킬 폴더 — 설치하면 누구에게나 딸려온다.
function builtinSkillsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url)); // .../<pkg>/src
  return path.resolve(here, "..", "skills"); // .../<pkg>/skills
}

// 스킬 폴더 목록. 순서 = 우선순위(먼저 발견된 것이 이김).
//  - native: 우리/사용자 전용 폴더(항상)
//  - foreign: 다른 코딩 에이전트의 커맨드 폴더 — importForeign 일 때만, 그리고
//    '현재 작업 폴더(프로젝트)' 한정으로만 읽는다. (전역 ~/.claude/commands 는 읽지 않음:
//     Claude Code/Antigravity/SPARC 등이 흩뿌린 수십 개가 통째로 쏟아지는 걸 방지)
export function skillDirs(workspace, importForeign = true) {
  const home = os.homedir();
  const foreign = [
    path.join(workspace, ".claude", "commands"),
    path.join(workspace, ".claude", "skills"),
    path.join(workspace, ".opencode", "command"),
    path.join(workspace, ".github", "prompts"),
  ];
  return [
    path.join(workspace, ".cdsa", "skills"), // 프로젝트(가장 우선)
    ...(importForeign ? foreign : []), // 프로젝트 한정 외부 포맷
    path.join(home, ".cdsa_harness", "skills"), // 우리 전역
    builtinSkillsDir(), // 패키지 내장 기본(가장 마지막 = 사용자 것이 덮어씀)
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

export function loadSkills(workspace, { importForeign = true } = {}) {
  const skills = {};
  for (const dir of skillDirs(workspace, importForeign)) {
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
