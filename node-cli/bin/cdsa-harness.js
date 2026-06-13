#!/usr/bin/env node
// CDSA Harness — npm/npx 진입점.
//   npx cdsa-harness   또는   cdsa-harness (전역 설치 시)
import { main } from "../src/cli.js";

main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
