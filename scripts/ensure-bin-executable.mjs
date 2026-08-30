import { chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ensure every package bin entry is executable after a build.
 *
 * tsc emits non-executable files — the shebang survives compilation but the
 * mode bit does not. npm sets +x on bin files during a registry/git install,
 * so published consumers are safe; the breakage is the checkout-linked dev
 * install (`~/.npm-global/bin/shepy -> dist/src/cli/shepy.js`) and direct
 * `./dist/...js` invocation, both of which we hit live on 2026-08-30.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  (await import("node:fs")).readFileSync(join(root, "package.json"), "utf8"),
);

const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin);
for (const bin of bins) {
  const path = join(root, bin);
  const mode = statSync(path).mode;
  const executable = mode | 0o111; // +x for user, group, other
  if (mode !== executable) {
    chmodSync(path, executable);
    console.log(`chmod +x ${bin}`);
  }
}
