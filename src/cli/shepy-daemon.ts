#!/usr/bin/env node
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { runObservabilityDaemonService } from "@/daemon/service.js";

async function main(): Promise<void> {
  // The process manager appends stdout/stderr directly to shepy.log. Wrap
  // once at the entrypoint, preserving formatting and timestamping every
  // physical line, including multiline errors and stack traces.
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const write = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const timestamp = new Date().toISOString();
      for (const line of format(...args).split(/\r?\n/)) write(`${timestamp} ${line}`);
    };
  }
  // This standalone daemon owns warning output. Replace Node's default
  // warning listener, or it would also print an un-timestamped duplicate.
  process.removeAllListeners("warning");
  process.on("warning", (warning) => console.warn(warning.stack ?? warning));
  process.on("uncaughtException", (error) => {
    console.error(error.stack ?? error);
    exit(1); // A fatal exception must not leave a partially failed daemon running.
  });
  if (argv.length > 2) {
    throw new Error("shepy-daemon does not accept CLI arguments");
  }
  await runObservabilityDaemonService();
}

if (fileURLToPath(import.meta.url) === resolve(argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    exit(1);
  });
}
