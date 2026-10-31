# Release archives

Every version tag publishes four prebuilt archives, a VS Code extension package for each of the same
platforms, and `SHA256SUMS.txt` covering all of them:

| Archive suffix | Target              | VS Code package |
| -------------- | ------------------- | --------------- |
| `windows-x64`  | Windows 10/11, x64  | `win32-x64`     |
| `linux-x64`    | 64-bit Linux, glibc | `linux-x64`     |
| `macos-arm64`  | Apple silicon macOS | `darwin-arm64`  |
| `macos-x64`    | Intel macOS         | `darwin-x64`    |

The VS Code packages are what the Marketplace serves; they carry the same server build and install
it on first activation.

Each archive contains:

- the MCP executable;
- the unpacked Chrome extension, under `extension/`;
- Qt Core and Qt Network -- DLLs on Windows, shared libraries on Linux, frameworks under
  `Frameworks/` on macOS -- and the platform's Qt TLS backend under `tls/`, which the updater needs
  to reach the release host over HTTPS;
- on Linux, the ICU libraries Qt Core links against there;
- `README.md`, `THIRD_PARTY_NOTICES.md`, this guide as `RELEASES.md`, and the MIT `LICENSE`;
- `LICENSES/`, with the LGPL-3.0 and GPL-3.0 texts, the QtBase SPDX SBOM (`qtbase.spdx`) and, on
  Linux, ICU's license.

The application and Qt are dynamically linked so users can replace Qt with a compatible build.
Release archives do not include the repository's development helper scripts.

## Verify and install

Download the archive and `SHA256SUMS.txt` from the
[GitHub Releases page](https://github.com/RandyNorthrup/chrome-control-mcp/releases) and check the
archive against it before extracting:

```powershell
# Windows PowerShell: compare with the line for this file in SHA256SUMS.txt
(Get-FileHash .\chrome-control-mcp-v1.8.0-windows-x64.zip -Algorithm SHA256).Hash
```

```shell
# Linux
sha256sum --check --ignore-missing SHA256SUMS.txt

# macOS: compare with the line for this file in SHA256SUMS.txt
shasum -a 256 chrome-control-mcp-v1.8.0-macos-arm64.tar.gz
```

Then, from the extracted folder:

```shell
# Windows
.\chrome_control_mcp.exe --install

# Linux or macOS
./chrome_control_mcp --install
```

`--install` copies the server into the managed install layout, registers the native-messaging host,
and prints one line of JSON. Two of its fields are what everything else needs, and both stay the
same through every later update:

- `command` -- the path to give your MCP client, for example:

  ```shell
  claude mcp add --scope local chrome-control -- "<command>"
  codex mcp add chrome-control -- "<command>"
  ```

- `extension_path` -- the folder to load once in Chrome: open `chrome://extensions`, turn on
  **Developer mode**, choose **Load unpacked**, and pick that folder. This step is manual by
  Chrome's design; [TOOLS.md](TOOLS.md#extension-preparation) explains why.

A copy older than one already installed leaves the newer version current and says so. From inside
an MCP client, `browser_extension_install` registers the host and reports the folder the same way.

## Updating

Once installed, `browser_update_check` and `browser_update_apply` find and install newer releases,
verified against the same `SHA256SUMS.txt`. Restart the MCP client's server afterwards so it runs
the new build, and reload the extension at `chrome://extensions` (or restart Chrome): Chrome keeps
running the copy it loaded until then. When the new server speaks a newer bridge protocol than that
copy, the extension reloads itself once.
[TOOLS.md](TOOLS.md#updating-this-server) describes the layout and the install roots.

## Unsigned by design

No archive, executable, DLL, shared library, or macOS framework is code-signed or notarized. No
signing key is required by this project. Windows SmartScreen and macOS Gatekeeper may therefore
show an unknown-publisher warning. Inspect the public source and checksum, build locally, or use
your operating system's explicit approval flow when you trust the downloaded artifact.

The unpacked Chrome extension is also unsigned. Its public manifest `key` gives it a stable
extension ID; that field is not a private signing key.

## Reproducibility boundary

The tag workflow builds each archive on a clean GitHub-hosted runner (Windows x64, Linux x64,
macOS 15 on Apple silicon, macOS 15 on Intel). It refuses a tag that does not match the project
version, runs ctest, stages the archive, and runs the MCP smoke test against the staged executable.
On Linux it fails the build if the staged executable needs a library the archive does not carry,
checked with `ldd` and without the runner's Qt on the library path; on macOS it records the
linkage with `otool -L`. It refuses a VS Code package whose version differs from the archive's.
Only then does it publish the GitHub release, with the notes from `docs/releases/<tag>.md`, and --
when the Marketplace token is configured -- the VS Code packages to the Marketplace.

`SHA256SUMS.txt` lists every published asset, VS Code packages included. Builds are not
bit-for-bit reproducible across runner image updates.
