# Ingress allowlist (operator-owned)

`~/.shepy/ingress-allowlist.json` is owned and maintained by the operator, not the router or scanner. Missing, unreadable or invalid configuration refuses demand admission. Do not put credentials in the file. An admitted same-user Unix socket client can claim any configured `sourceId`: that string is **not** process authentication. Keep this allowlist narrow and review changes before deploying a daemon that exposes `inbox.publishDemand`.

The `shepy.ingress-allowlist.v1` document contains `sources`, keyed by source id. Each entry lists `profiles`, `kinds`, `duty_paths`, `grant_hashes`, `evidence_roots`, and `max_expiry_minutes` (at most 60). The operator must update it when grants, duty paths, or admission windows change and revoke obsolete entries; producers may not edit it. Publication and every duty lease must re-read it. An empty `grant_hashes` array currently means no hash restriction and is appropriate only for explicitly accepted operator policy.

This branch contains only the strict admission validator, not a daemon publication or delivery path. It does **not** yet re-read the file at lease, verify STOP/duty/capacity, persist demand events, or enable demand-capable owners. Do not treat this document or validator as an operational ingress deployment.
