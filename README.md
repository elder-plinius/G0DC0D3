<p align="center">
  <strong>G O D M O D Ǝ &nbsp; / &nbsp; G O D C O D Ǝ</strong>
</p>

<p align="center">
  <em>Own the harness. Inspect every wire byte.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS_12%2B_%7C_Linux_(bwrap)-111111?style=flat-square" alt="macOS 12+ and Linux">
  <img src="https://img.shields.io/badge/runtime-Node_22.13%2B-339933?style=flat-square" alt="Node.js 22.13+">
  <img src="https://img.shields.io/badge/npm_deps-0-d97706?style=flat-square" alt="Zero npm dependencies">
  <img src="https://img.shields.io/badge/telemetry-ZERO-dc2626?style=flat-square" alt="Zero Telemetry">
  <img src="https://img.shields.io/badge/tests-269%2F269-16a34a?style=flat-square" alt="269 tests passing">
</p>

<p align="center">
  <img src="docs/screenshots/godmode-dark.png" alt="GODMODƎ Workspace" width="88%">
</p>

Local-first AI chat, prompt-transparency & prefill lab, contained Chromium agent browser, and autonomous Git worktree coding studio — built on **Node.js 22.13+ SQLite** and a native **macOS AppKit/`WKWebView`** shell, with **zero npm dependencies** and **zero telemetry**.

---

## Quick Start

Requires **Node.js 22.13+** and **Git** (no `npm install` needed).

**macOS 12+** *(native Hardened Runtime app + Seatbelt sandbox; requires Xcode CLT)*:
```sh
git clone https://github.com/elder-plinius/G0DC0D3.git
cd G0DC0D3
npm run desktop:build
open "dist/G0DM0D3.app"
```

**Linux** *(local web UI + CLI + `bubblewrap` sandbox)*:
```sh
sudo apt install bubblewrap libsecret-tools   # or dnf/pacman equivalent
git clone https://github.com/elder-plinius/G0DC0D3.git
cd G0DC0D3
npm start
```

CLI: `node src/cli.mjs --help` · Tests: `npm test` · Eval: `npm run bench:self-opt`

---

## What's Inside

- **Two Surfaces (`⌘⇧G`)**: **`GODMODƎ`** (sovereign local chat, contained Chromium agent browser, offline HTML5/SVG/Mermaid live canvas) and **`GODCODƎ`** (Git worktrees, multi-model patch races, Plan/Build mode, `Safe` default permission gate, Git checkpoints).
- **Full Wire Transparency (`Settings → System`)**: Inspect, edit, and reset all **13 system prompt blocks**, **27 tool schemas**, **Prefills & Message Shaping** (off by default), and **Live Wire Preview** before a single byte leaves localhost.
- **Multi-Provider Hub & Ultra-Plinian**: Venice Catalog, Anthropic, OpenAI, Gemini, OpenRouter, Nous Portal, local Ollama/vLLM (`G0D_ALLOW_PRIVATE_HTTP=1` for LAN/Docker hosts), and optional local CLI bridges (off by default; invokes official local binaries with zero token extraction).
- **Long-Horizon `High` / `Max` Engine**: Effort-scaled timeouts (up to 10 min) & output ceilings (up to 64k), 250-call default budget with `+100` continue, hybrid compaction, and adaptive recovery.
- **Defense-in-Depth**: macOS Seatbelt / Linux `bwrap` command sandboxing, device-only Keychain / `secret-tool`, Strict ZDR & Local-Only Airgap, outbound secret redaction, strict zero-inline-`style=` CSP, and pre-request CDP SSRF gating. See [SECURITY.md](SECURITY.md).

<details>
<summary>More screenshots</summary>
<p align="center">
  <img src="docs/screenshots/godmode-system-lab.png" alt="Settings → System: Prompt Transparency & Prefill Lab" width="49%">
  <img src="docs/screenshots/godcode-light.png" alt="GODCODƎ Light Workspace" width="49%">
</p>
</details>

> **Note on `fixtures/`**: The 30 test fixtures under `fixtures/` are 100% synthetic, offline JavaScript math/graph/protocol unit-test puzzles (zero live exploits, network payloads, or hazardous procedures), used solely to benchmark false-positive refusal recovery in coding agents.

---

## License & Disclaimer

Dual-licensed under **[AGPL-3.0](LICENSE)** (open source) and commercial licensing via [GitHub Issues](https://github.com/elder-plinius/G0DC0D3/issues). Third-party asset notices in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

**Experimental research demo — provided "AS IS" without warranty of any kind.** You are solely responsible for your prompts, tool grants, commands, and compliance with applicable laws and third-party provider Terms of Service.
