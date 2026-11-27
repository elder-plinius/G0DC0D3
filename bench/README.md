# G0DC0D3 Harness Benchmarks

Deterministic offline suites and a live head-to-head harness bakeoff measuring coding accuracy, controller durability, fault recovery, false-positive refusal handling, tool/sandbox isolation, and overseer / HyperTuner lift using isolated Git workspaces and untouched external verifiers.

> Scripted repairs in `npm run bench` are known implementations used to verify controller mechanics. Their success does **not** measure live model coding quality — use `npm run bench:bakeoff` for live head-to-head harness evaluation against Codex CLI, Antigravity (`agy`), and Claude Code.

## Commands

```sh
# Full test suite (includes adversarial harness & bakeoff unit tests)
npm test

# Scripted adversarial benchmark (JSON on stdout, progress on stderr)
npm run bench -- --output /tmp/g0dc0d3-bench-out

# Self-optimization & Overseer eval scoreboard (10/10)
npm run bench:self-opt

# Head-to-head harness bakeoff — dry-run validation (0 API calls)
npm run bench:bakeoff -- --suite quick --dry-run

# Live shootout: G0DC0D3 vs Codex CLI vs Antigravity (agy) vs Claude Code
npm run bench:bakeoff -- --suite core --harnesses g0dc0d3,codex,agy,claude

# Adversarial false-positive security suite (measures refusal rate vs verified pass@1)
npm run bench:bakeoff -- --suite adversarial-security --harnesses g0dc0d3,codex,agy,claude

# Iso-model lift test (isolate pure harness delta) or HyperTuner A/B test
npm run bench:bakeoff -- --suite core --harnesses g0dc0d3,codex --model gpt-5.4 --g0d-hypertuner active

# Custom SWE-bench / Terminal-Bench / private Git repo JSON or JSONL manifest
npm run bench:bakeoff -- --tasks ./my-swebench-tasks.jsonl --harnesses g0dc0d3,codex,agy,claude

# End-to-end offline smoke suite
npm run smoke
```

## Head-to-Head Bakeoff Artifacts

Each `npm run bench:bakeoff` run writes three self-contained artifacts to `--output` (default `.g0dc0d3/bakeoff/<timestamp>/`):

- `bakeoff-report.json` — full per-cell telemetry (pass/fail/refusal/timeout/no-edits, p50/p95 latency, tokens, cost/resolved, diff line count)
- `SCOREBOARD.md` — GitHub-flavored Markdown leaderboard & per-task matrix
- `scoreboard.html` — self-contained offline dark-mode visual comparison chart

Custom `--tasks` JSON/JSONL records accept `{ id, prompt, repo, baseCommit, verifyCommand }` (or SWE-bench fields `instance_id`, `problem_statement`, `base_commit`, `test_cmd`, or inline `files`).
