#!/usr/bin/env node
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (err) => {
    console.error(`pi-gemini-auth: ${err?.message ?? err}`);
    process.exitCode = 1;
  },
);
