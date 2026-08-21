# Release archives

GitHub publishes four prebuilt archives for every version tag:

| Archive suffix | Target              |
| -------------- | ------------------- |
| `windows-x64`  | Windows 10/11, x64  |
| `linux-x64`    | 64-bit Linux, glibc |
| `macos-arm64`  | Apple silicon macOS |
| `macos-x64`    | Intel macOS         |

Each archive contains the MCP executable, unpacked Chrome extension, MIT license, release guide,
Qt Core runtime, QtBase SPDX SBOM, and the applicable Qt license texts. The application and Qt are
dynamically linked so users can replace Qt with a compatible build.

## Verify and run

Download the archive plus `SHA256SUMS.txt` from the
[GitHub Releases page](https://github.com/RandyNorthrup/chrome-control-mcp/releases). Verify the
checksum before extracting it.

```powershell
# Windows PowerShell
(Get-FileHash .\chrome-control-mcp-v1.0.0-windows-x64.zip -Algorithm SHA256).Hash
```

```shell
# Linux or macOS
sha256sum chrome-control-mcp-v1.0.0-linux-x64.tar.gz
```

After extracting, register the executable with the assistant using an absolute path:

```shell
# Windows
codex mcp add chrome-control -- "C:\absolute\path\chrome_control_mcp.exe"

# Linux or macOS
codex mcp add chrome-control -- /absolute/path/chrome_control_mcp
```

Then call the MCP tool `browser_extension_install` and load the printed `extension` directory
through `chrome://extensions`. Release archives do not include the repository's development helper
scripts; the MCP tool provides the complete current-user setup path without a source checkout.

## Unsigned by design

No archive, executable, DLL, shared library, or macOS framework is code-signed or notarized. No
signing key is required by this project. Windows SmartScreen and macOS Gatekeeper may therefore
show an unknown-publisher warning. Inspect the public source and checksum, build locally, or use
your operating system's explicit approval flow when you trust the downloaded artifact.

The unpacked Chrome extension is also unsigned. Its public manifest `key` gives it a stable
extension ID; that field is not a private signing key.

## Reproducibility boundary

The tag workflow builds each archive on a clean GitHub-hosted runner, runs the complete native and
extension test suite, then runs the MCP smoke test against the staged executable before publishing.
The release page includes SHA-256 hashes. Builds are not currently bit-for-bit reproducible across
runner image updates.
