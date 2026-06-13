// 시작 배너(ASCII 아트) — "CDSA HARNESS" (figlet slant 폰트로 미리 렌더, 하드코딩)
import { hex } from "./ui.js";

const ART = String.raw`   __________  _____ ___       __  _____    ____  _   __________________
  / ____/ __ \/ ___//   |     / / / /   |  / __ \/ | / / ____/ ___/ ___/
 / /   / / / /\__ \/ /| |    / /_/ / /| | / /_/ /  |/ / __/  \__ \\__ \
/ /___/ /_/ /___/ / ___ |   / __  / ___ |/ _, _/ /|  / /___ ___/ /__/ /
\____/_____//____/_/  |_|  /_/ /_/_/  |_/_/ |_/_/ |_/_____//____/____/`;

const GRADIENT = ["#22d3ee", "#38bdf8", "#3b82f6", "#6366f1", "#8b5cf6"];

export function bannerText() {
  return ART;
}

export function renderBanner() {
  const lines = ART.split("\n");
  return lines.map((line, i) => hex(line, GRADIENT[i % GRADIENT.length])).join("\n") + "\n";
}
