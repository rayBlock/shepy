# SHEPYTRIM — row 15.363

Builder: shepytrim. Branch: `night/shepytrim`. Base: `7a7a3afa47c205bb5c0ac7ba0478eafaeaa44c2c`.
Status: BUILT; focused checks pass, full-suite comparison is still waiting for the shared lock. Independent acceptance preparation exists in [acceptance check](../../../../agent-factory/evidence/20261022-night/acceptance-check-SHEPYTRIM.md).

## Acceptance block recorded before coding

```acceptance
{
  "kind": "build",
  "real_use": "The existing claude-hook --profile engine-coordinator --profile-demand command remains accepted, ignores the flag, emits one deprecation line to stderr only and preserves worker outcome stdout. Without the flag there is no note. Prompt, Stop, inbox list/get/retire/retry and Pi worker outcome delivery remain operational; daemon.info and RPCs no longer expose demand. Older daemons remain usable without a capability probe.",
  "unhappy_paths": "Repeated flag, either flag order and SHEPY_PROFILE work; unknown adjacent flags and removed inbox verbs refuse. Existing demand tables, columns, constraints and migrations stay byte-identical; legacy non-agent obligation reads do not crash. Leftover ingress allowlist is ignored. Empty, malformed and unknown hook input retains baseline behavior.",
  "attack_tests": [
    {"probe": "Parser and runtime flag variations, stderr-only one-line note, unknown flags refuse.", "good_input_control": "Same command without flag has identical parsed command and stdout, no note."},
    {"probe": "Existing schema fixture and legacy row open and read without crashing; schema diff empty.", "good_input_control": "Empty migrated database on main and candidate."},
    {"probe": "Removal grep limited to schema, migration runner, drizzle and migration test, plus required compatibility flag and its test.", "good_input_control": "Main grep enumerates removed code."},
    {"probe": "All three package typechecks, lint and required validation.", "good_input_control": "Baseline checks on unchanged source."},
    {"probe": "Full suite on main and branch under lockf shared lock, fresh HOME/TMPDIR and env -i; compare named failures.", "good_input_control": "Main baseline failure set retained."},
    {"probe": "daemon.info omits capability, removed RPCs report unknown method while server remains usable.", "good_input_control": "inbox.list and agent.list still respond."}
  ],
  "running_cost": {
    "time": "Record package typecheck and full-suite wall times and builder elapsed time.",
    "cpu": "Measure main and candidate hook call wall times; no capability probe remains.",
    "memory": "Not measured: no new retained data.",
    "disk": "Source and test lines removed, whole deleted file counts, unchanged database schema.",
    "tokens": "Five channels if available, otherwise null with limitation.",
    "expected": "Lower suite count by removed cases, no new failures; explain removal beyond estimates."
  },
  "ray_check": "Machine verification only, independent reviewer next. No install/restart/factory edits. After install the seat removes the flag from settings.json and engine-coordinator-bootstrap.md, then Ray verifies wakes and worker outcomes."
}
```

The supplied grep requirement necessarily has an exception for the explicitly required compatibility flag and its test. Historical evidence is not rewritten.

Current proof: all package typechecks, 339 focused cases, build, package checks, lint, formatting and DB checks pass. Public built CLI, daemon-process and Pi API fixtures pass; no live Claude or Pi model turn is claimed. Full baseline: 1,285 tests with 43 failures; candidate suite and canonical check are queued under the shared lock. Raw evidence and retained failed attempts: `/private/tmp/st363`. Final comparison and handoff will replace this progress note before closeout.
