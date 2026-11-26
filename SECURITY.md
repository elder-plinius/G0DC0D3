# Security Policy

## Scope & Architecture

**G0DC0D3 (`GODMODƎ` / `GODCODƎ`)** is a local-first, zero-telemetry experimental research studio and coding harness:

- **Zero Telemetry & Egress Control**: No analytics, no crash beacons, and forced suppression of third-party CLI telemetry variables (`DO_NOT_TRACK=1`, `OTEL_SDK_DISABLED=true`, `DISABLE_TELEMETRY=1`). Outbound calls respect **ZDR Request Routing**, **Strict ZDR Gate**, **Local-Only Airgap**, **Outbound Secret Redaction**, and the in-memory **Outbound Network Audit** log.
- **OS-Enforced Workspace Sandbox**:
  - **macOS**: Deny-by-default Seatbelt (`sandbox-exec`) profile scoped to the task's copied workspace with explicit opt-in network grants.
  - **Linux**: Bubblewrap (`bwrap`) namespace isolation (`--unshare-pid --unshare-ipc --unshare-uts --die-with-parent --cap-drop ALL`, plus `--unshare-net` unless explicitly granted) with read-only `0000` masking of `.git` and `.g0dc0d3`.
  - **Lifecycle Hooks**: Deterministic `PreToolUse` / `PostToolUse` hooks run inside the OS sandbox (`network: false`) on both macOS and Linux; owner home hooks (`~/.g0dc0d3/hooks.json`, owner-only perms) load automatically while repository-local `.g0dc0d3/hooks.json` requires explicit opt-in (`G0D_ALLOW_PROJECT_HOOKS=1`).
- **Path, Repository & Prompt-Injection Safety**: Case-insensitive exclusion of `.git`, `.g0dc0d3`, and `node_modules` across broker tools, symlink/traversal checks, glob complexity caps (ReDoS mitigation), safe Git flags (`core.hooksPath=/dev/null`, `core.fsmonitor=false`, `--no-ext-diff`, `GIT_CONFIG_NOSYSTEM=1`), `Safe` default permission gate (auto-allowing workspace edits while confirming shell commands/deletes and denying destructive patterns like `rm -rf /`, `git push --force`, and `curl|sh`), and `untrustedExternalContent` boundary tagging on external web/browser tool outputs.
- **Loopback HTTP & Session Hardening**: Strict `Host` / `Origin` / `X-G0D-Request` checks, timing-safe 256-bit session tokens (`HttpOnly; SameSite=Strict`), `/api/session` rate limiting, strict zero-inline-`style=` CSP, sandboxed preview iframe CSP, `X-Frame-Options: DENY`, and `0o700`/`0o600` local state permissions.
- **Contained Agent Browser & Web Fetch**: Ephemeral headless Chromium profile wiped on close, DNS-pinned HTTP(S) `web.fetch` with per-hop redirect SSRF revalidation, canonical IPv4/IPv6/NAT64/6to4 private-range blocking, cross-origin loopback/iframe isolation, and pre-request CDP `Fetch.requestPaused` interception enforcing Local-Only and URL rules before redirects execute.
- **Credential Storage**: Device-only macOS Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, non-synchronizable) on macOS and GNOME Keyring (`secret-tool`) on Linux.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately via **GitHub Security Advisories** on `elder-plinius/G0DC0D3` (`Security → Advisories → Report a vulnerability`), including affected file(s), platform, commit hash/version, and minimal reproduction steps.

## Non-Goals

- **Third-Party Model Behavior**: Outputs, refusals, or policy enforcement by third-party AI APIs or local models are outside the harness's security boundary; users remain responsible for compliance with applicable laws and provider Terms of Service.
- **Ad-Hoc Developer Builds**: Local macOS builds created via `npm run desktop:build` without `G0D_CODESIGN_IDENTITY` are ad-hoc signed, so rebuilding rotates the Mach-O CDHash and may cause macOS Keychain to re-prompt.
- **Owner-Granted Commands**: When a user explicitly enables command execution and/or network access for a workspace, commands execute inside the OS sandbox within those granted permissions.
