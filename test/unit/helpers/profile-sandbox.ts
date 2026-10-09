/**
 * Sandbox for the ambient SHEPY_PROFILE environment variable.
 *
 * Dispatched panes (factory workers) carry a real SHEPY_PROFILE in
 * process.env, and the extension's session_start claims whatever profile the
 * environment names — correct production behaviour, decisive in tests. This
 * is the same leak class as the ambient build stamp
 * (build-info-sandbox.ts): the suite sandboxes it in the test environment,
 * never in production.
 *
 * The file-level install saves the ambient value and unsets it for the
 * file's tests; profile-aware paths are exercised only by deliberate
 * injection controls that set SHEPY_PROFILE themselves and return to the
 * sandboxed (unset) state afterwards. Paired with the uninstall in an
 * afterAll, the sandbox is transparent: what a test file removes, it
 * restores.
 */

let savedAmbient: string | undefined;
let installed = false;

/**
 * Save the ambient SHEPY_PROFILE and unset it for the remainder of the test
 * file. Idempotent. Profile-aware paths stay covered: they are reached only
 * through deliberate injection (injectProfileForControl).
 */
export function installAmbientProfileSandbox(): void {
  if (installed) return;
  installed = true;
  savedAmbient = process.env.SHEPY_PROFILE;
  delete process.env.SHEPY_PROFILE;
}

/**
 * Deliberate profile-injection control: point the environment claim at an
 * explicit profile id for one test. The caller must pair this with a finally
 * that calls restoreAmbientProfileSandbox() so the sandboxed state holds for
 * the file's remaining tests.
 */
export function injectProfileForControl(profileId: string): void {
  process.env.SHEPY_PROFILE = profileId;
}

/**
 * Return the environment to the sandboxed (unset) state — deliberately NOT
 * the ambient one, so a control's cleanup can never leak its injection into
 * the file's other tests. File-level callers under vitest isolation need no
 * cleanup; this exists so a control's finally can name its intent.
 */
export function restoreAmbientProfileSandbox(): void {
  if (!installed) return;
  delete process.env.SHEPY_PROFILE;
}

/**
 * Undo the file-level sandbox: put the saved ambient value back. Pair with
 * installAmbientProfileSandbox() in an afterAll so a test file leaves the
 * process environment exactly as it found it.
 */
export function uninstallAmbientProfileSandbox(): void {
  if (!installed) return;
  installed = false;
  if (savedAmbient === undefined) delete process.env.SHEPY_PROFILE;
  else process.env.SHEPY_PROFILE = savedAmbient;
  savedAmbient = undefined;
}
