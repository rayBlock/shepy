import { registerHooks } from "node:module";

// Only this test-owned preload redirects the hook's storage import. The normal
// src/cli/shepy.ts entry has neither this loader nor an environment-based switch.
const hookUrl = new URL("../../src/cli/claude-hook.ts", import.meta.url).href;
const injectedUrl = new URL("./owner-file-injected.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === hookUrl && specifier === "@/cli/owner-file.js") {
      return { shortCircuit: true, url: injectedUrl };
    }
    return nextResolve(specifier, context);
  },
});
