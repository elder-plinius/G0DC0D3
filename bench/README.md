# G0DC0D3 Harness Benchmarks

Deterministic offline suites measuring controller durability, fault recovery, tool/sandbox isolation, and overseer self-optimization using scripted providers, real file operations, SQLite persistence, and independent fixture probes.

> Scripted repairs are known implementations used to verify controller mechanics. Their success does **not** measure live model coding quality.

## Commands

```sh
# Full test suite (includes adversarial harness cases)
npm test

# Scripted adversarial benchmark (JSON on stdout, progress on stderr)
npm run bench -- --output /tmp/g0dc0d3-bench-out

# Self-optimization & Overseer eval scoreboard (10/10)
npm run bench:self-opt

# End-to-end offline smoke suite
npm run smoke
```
