# Releasing & Safe Downloads (`godcode.gg`)

G0DC0D3 builds immutable, self-contained macOS and Linux packages directly in GitHub Actions via [`.github/workflows/release.yml`](../.github/workflows/release.yml) — with zero npm runtime dependencies, `SHA256SUMS.txt`, and **GitHub Sigstore SLSA Build Provenance Attestations**.

## 1. Local Packaging (Optional Testing)

```sh
# macOS self-contained .app + .dmg (bundles Node 22 + runtime)
npm run package:macos

# Linux self-contained .tar.gz (+ .deb when dpkg-deb is installed)
npm run package:linux
```

Outputs are written to `dist/release/`.

## 2. Cutting a Public Release

Push a version tag matching `package.json`:

```sh
git tag v0.2.1
git push origin v0.2.1
```

Or run **Actions → Release → Run workflow** manually in GitHub.

This automatically builds and attaches:
- `G0DM0D3-<ver>-macos-arm64.dmg` (Apple Silicon)
- `G0DM0D3-<ver>-macos-x64.dmg` (Intel)
- `g0dm0d3_<ver>_amd64.deb` & `g0dm0d3_<ver>_arm64.deb` (Ubuntu/Debian, declares `Recommends: bubblewrap, libsecret-tools, xdg-utils`)
- `g0dm0d3-<ver>-linux-x64.tar.gz` & `g0dm0d3-<ver>-linux-arm64.tar.gz` (portable archive for Fedora/Arch/etc.)
- `SHA256SUMS.txt` + Sigstore SLSA build attestations

## 3. Enabling Apple Gatekeeper Notarization (Recommended for macOS)

To eliminate macOS Gatekeeper quarantine warnings and keep macOS Keychain trust stable across updates, add these repository **GitHub Actions Secrets** (requires an Apple Developer Program `Developer ID Application` certificate):

| Secret | Value |
|---|---|
| `MACOS_SIGN_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID1234)` |
| `MACOS_CERT_P12_BASE64` | Base64-encoded `.p12` export of your Developer ID Application cert (`base64 -i cert.p12 \| pbcopy`) |
| `MACOS_CERT_PASSWORD` | Password protecting the `.p12` export |
| `APPLE_ID` | Apple ID email for `xcrun notarytool` |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |
| `APPLE_APP_PASSWORD` | App-Specific Password from https://appleid.apple.com |

Once set, `.github/workflows/release.yml` automatically signs inside-out (`Contents/Resources/node` with `native/node.entitlements`, then `G0DM0D3.app` with `native/G0DM0D3.entitlements`, then `.dmg`), submits to Apple notarization, and staples the ticket onto the `.dmg`.

## 4. Wiring Download Buttons on `godcode.gg`

Point `godcode.gg` download buttons directly to the immutable GitHub Release asset URLs (never a mutable server bucket, and never `curl | sh`):

```text
https://github.com/elder-plinius/G0DC0D3/releases/download/v<ver>/G0DM0D3-<ver>-macos-arm64.dmg
https://github.com/elder-plinius/G0DC0D3/releases/download/v<ver>/G0DM0D3-<ver>-macos-x64.dmg
https://github.com/elder-plinius/G0DC0D3/releases/download/v<ver>/g0dm0d3_<ver>_amd64.deb
https://github.com/elder-plinius/G0DC0D3/releases/download/v<ver>/g0dm0d3_<ver>_arm64.deb
https://github.com/elder-plinius/G0DC0D3/releases/download/v<ver>/g0dm0d3-<ver>-linux-x64.tar.gz
https://github.com/elder-plinius/G0DC0D3/releases/download/v<ver>/g0dm0d3-<ver>-linux-arm64.tar.gz
https://github.com/elder-plinius/G0DC0D3/releases/download/v<ver>/SHA256SUMS.txt
```

Include a collapsible **"Verify download"** snippet beneath the button:

```sh
# macOS
shasum -a 256 G0DM0D3-<ver>-macos-arm64.dmg
gh attestation verify G0DM0D3-<ver>-macos-arm64.dmg --repo elder-plinius/G0DC0D3

# Linux (.deb)
sha256sum g0dm0d3_<ver>_amd64.deb
gh attestation verify g0dm0d3_<ver>_amd64.deb --repo elder-plinius/G0DC0D3
sudo apt install ./g0dm0d3_<ver>_amd64.deb
```
