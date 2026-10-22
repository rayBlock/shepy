// Explicit test-only preload. The shipping CLI has no environment switch for this.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const realExecFile = childProcess.execFile;
const mode = process.env.SHEPY_TEST_PS_MODE;
const trace = process.env.SHEPY_TEST_PS_TRACE;
function injected(file, args, options, callback) {
  if (file !== "/bin/ps") return realExecFile(file, args, options, callback);
  const started = performance.now();
  return realExecFile(
    process.execPath,
    ["-e", mode === "timeout" ? "setInterval(() => {}, 1000)" : "process.exit(2)"],
    options,
    (error, stdout, stderr) => {
      if (trace) {
        appendFileSync(
          trace,
          `${JSON.stringify({
            timeoutMs: options.timeout,
            elapsedMs: performance.now() - started,
            killed: error?.killed === true,
            signal: error?.signal,
          })}\n`,
          { mode: 0o600 },
        );
      }
      callback(error, stdout, stderr);
    },
  );
}
Object.defineProperty(injected, promisify.custom, {
  value: (file, args, options) =>
    new Promise((resolve, reject) => {
      injected(file, args, options, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
});
childProcess.execFile = injected;
syncBuiltinESMExports();
