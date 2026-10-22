# Review: SHEPYCRASH round 3 (row 15.367), narrow recheck

Reviewer: rev-shcrash2 (Claude Sonnet 5.5), directed recheck of my own round-2 findings, not blinded. Candidate: tip `e53abfa` on `night/shepycrash-2` (code commit `0fff224`; the other two commits are docs), base `b4ca875`. Reviewed in my worktree, detached at `e53abfa`. Diff `b4ca875..e53abfa` read before the builder's report.

**ACCEPT.** The renamed nested Claude now refuses, the other two attack variants still refuse, and a real crash plus same-pane restart still recovers. Findings 2, 3 and 4 are closed. The full suite is red, but every red is either a known load timing failure that also fails on main `e5b5bcc`, or a Codex failure that `e5b5bcc` already fixed (SHEPYGREEN) and this branch simply does not contain yet.

## Finding 1 (renamed nested Claude): closed
`claude-hook.ts:319-349`: the hook now stops at its first Claude parent and may only pass through `sh`, `bash` or `zsh`. Any other command, a failed or late `ps`, a cycle or pid 1 is "unknown" and refuses. So a renamed nested Claude (parent is a Node process, not a shell) refuses before claiming.
My own probe (a copy of the new test file plus one probe test, real hook CLI, live outer fixture seat that has claimed, Herdr fixture naming the nested session and listing the outer pid as sole foreground Claude):

| Variant | Result |
| --- | --- |
| `renamed` (round-2 bypass) | refused locally, stderr `cannot verify Claude ancestry`, token unchanged, pending attempt 0 |
| `nested` (named `claude`) | refused by the daemon (its pid is not the sole foreground Claude), refusal context line, token unchanged, pending 0 |
| `orphan` (reparented to pid 1) | same as `nested` |
| control: first Claude SIGKILLed, replacement under a `sh` layer | takeover, new token, pending outcome delivered once |

The real seat's hook command is `if …; then /Users/ray/.npm-global/bin/shepy claude-hook …; fi`, and `shepy` is `#!/bin/sh` then `exec node`. So the real chain is Node, then `sh`, then Claude, which the new rule admits (the builder also recorded this with a real `claude /usage` run; I did not repeat that). Cost: the walk is at most 2 to 3 `ps` calls now.

## Findings 2 to 4: closed
- Finding 2 (cannot-verify refusal untested): two real-CLI tests (`ps` failure and `ps` timeout) cover prompt and Stop. They assert exit 0, empty stdout, exactly one stderr line, no claim call, owner file byte-identical, outcome still pending at attempt 0, `ps` timeout positive and at most 1,000 ms, the child killed with at least 900 ms elapsed, and delivery once the next prompt can verify. The fault comes from a test-only preload (`test/support/claude-ancestry-injected.mjs`); the test also shows the environment names alone do nothing, and `grep` finds no switch in `src/`.
- Finding 3 (herdr server under a Claude): the walk no longer goes above its own Claude, so a higher Claude cannot make every pane "nested". Closed by design; not run against a real herdr server.
- Finding 4 (test shape): the three daemon-log tests are one table in one test (2.6 s). Hook test file: 157 cases, up from 155.
- One caveat to know: in-process hook fixtures now get a Claude parent from a `vi.mock` of `execFile` in the test file. That is honest (vitest has no Claude parent) and the proofs that matter use real processes.

## Checks (Node 24.18.0 first on PATH, `env -i`, fresh mode-0700 HOME and TMPDIR, CLAUDECODE and both messaging variables unset)
| Check | Result | Wall time |
| --- | --- | --- |
| `claude-hook.test.ts` | 157 passed | 95 s at load 20 to 30 |
| `tsc --noEmit`, `biome check .` | exit 0, clean | about 4 s |
| Full suite on candidate, under `lockf -k`, start load 18.4 | 1,166 of 1,170 passed, 4 red | 90 s |
| Full suite on main `e5b5bcc` (extracted copy), same lock, start load 15.7 | 1,139 of 1,143 passed, 4 red | 84 s |
| Merged tree (candidate onto `e5b5bcc`, `git merge-tree`, no conflicts) | `tsc` exit 0; hook, notice, rpc and history tests 209 of 209 passed | about 60 s |

Reds on the candidate:
- `agent-history-readers` and `observability-rpc` (Codex): fail because this branch is based on `7aa8adb`, before SHEPYGREEN fixed them. They pass on `e5b5bcc` and on the merged tree.
- `agent-lifecycle` P4 "automatic pruning keeps a modern never-matched subscription": fails identically (`expected [] to have a length of 1`) on main `e5b5bcc` in my run, so it is a load timing failure that does not come from this candidate.
- `claude-hook` "Stop claim with lookup-failure identity cannot self-wake…": 5 s timeout at load about 18. Main failed the sibling case (UserPromptSubmit) the same way. This test passes 3 of 3 alone on the candidate. Not changed code: neither case reaches the ancestry check any differently than on main, but I did not run a full suite on a quiet machine, so I cannot prove it away.
Main's own four reds (P4, a watcher test, the UserPromptSubmit sibling, a notice rollback test) are all 5 s timeouts or the same P4 assertion, matching SHEPYGREEN's "known load timeouts".

Scratch (probe test, logs, extracted main and merged trees): `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-shcrash2/36a36a5d-ba78-40c6-ab6e-75d37e674503/scratchpad` (`zz-probe3.test.ts`, `full2.log`, `fullm.log`). The probe file was removed from my worktree; no candidate file was edited. No install, daemon restart or live profile touched.

## Limits and next owner
- Source acceptance only. Not installed, not verified by Ray, not tested in a live pane; a real restart in a live Herdr pane is still unobserved.
- Landing needs a carry onto `e5b5bcc` (merges cleanly, see above) with a fresh review of that carry's code commit if the seat wants one. Next owner: the seat.
- Standing residual, accepted since round 1: a local RPC client can send any `claudePid`; the pid is metadata, not authentication.
- Not run: a second full suite; the full suite on a machine below load 15.

## Noticed beyond my task
- The Shepy full suite fails 4 tests on main `e5b5bcc` itself at load 15 to 18 (5 s timeouts and P4). SHEPYGREEN's report says the same. Suggested owner: the Shepy seat, a lower load ceiling for the lock or per-test budgets.
