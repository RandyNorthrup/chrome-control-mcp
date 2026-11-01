# Release archives

Every version tag publishes four prebuilt archives, a VS Code extension package for each of the same
platforms, and `SHA256SUMS.txt` covering all of them:

| Archive suffix | Target              | VS Code package |
| -------------- | ------------------- | --------------- |
| `windows-x64`  | Windows 10/11, x64  | `win32-x64`     |
| `linux-x64`    | 64-bit Linux, glibc | `linux-x64`     |
| `macos-arm64`  | Apple silicon macOS | `darwin-arm64`  |
| `macos-x64`    | Intel macOS         | `darwin-x64`    |

The archives are the MCP server for any client. The VS Code packages are what the Marketplace
serves; they carry the same server build and install it on first activation.

## What a release page says

Every release page has the same shape, so a list of releases can be read at a glance and any one
of them answers the same questions in the same place:

- **The title says what the release does**: `v1.9.0: A clipboard for every agent`, or
  `v1.2.1: 1.2.0 rebuilt to pass clang-tidy; no change in behaviour` for one nobody needs to rush to.
- **The first line says when it shipped**, and links to every release and to the code changes since
  the one before.
- **The notes** say what changed and why, and, under **Updating**, any step an update needs from
  you.
- **Downloads** says which file is yours: the server archive for your platform, the VS Code
  package holding the same server, and `SHA256SUMS.txt`.

[CHANGELOG.md](../CHANGELOG.md) opens with the same titles and dates for every release, and the
README's What's new section has the latest three. To hear about new releases, use **Watch → Custom
→ Releases** on the GitHub repository, or subscribe to its
[releases feed](https://github.com/RandyNorthrup/chrome-control-mcp/releases.atom).

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
verified against the same `SHA256SUMS.txt`; running `--install` from a newer archive does the same.
After any update:

1. **Restart the server in your MCP client** so it runs the new build -- in Claude Code, `/mcp` and
   reconnect; elsewhere, restart the client or its MCP server.
2. **Reload the extension** at `chrome://extensions` (or restart Chrome): Chrome keeps running the
   copy it loaded until then. When the new server speaks a newer bridge protocol than that copy, the
   extension reloads itself once.

A release that needs anything more says so under **Updating** in its notes.
[TOOLS.md](TOOLS.md#updating-this-server) describes the layout and the install roots.

## Making a release

1. Bump the version everywhere `tests/test_release_versions.mjs` checks.
2. Add `## [x.y.z] - YYYY-MM-DD` to CHANGELOG.md, dated the day you tag it, and its row at the top
   of the release index.
3. Write `docs/releases/vx.y.z.md`. Its first line is `# <headline>`: plain text, saying what the
   release does, which becomes the release title. Say under **Updating** anything an update needs
   from the user.
4. Move the README's What's new table down by one and put the new release first.
5. Push, let the Quality workflow pass, then push the tag `vx.y.z`.

`test_release_versions` holds the index, the headlines, the dates and What's new to each other on
every push. On the tag, the release workflow refuses a changelog date that is not the tagged
commit's date, then builds the page with `scripts/release_notes.mjs`, which can also preview one:

```shell
node scripts/release_notes.mjs v1.9.0 --date 2026-10-31 --check
```

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
Only then does it publish the GitHub release, titled and written from `docs/releases/<tag>.md` and
CHANGELOG.md as described above, and -- when the Marketplace token is configured -- the VS Code
packages to the Marketplace.

`SHA256SUMS.txt` lists every published asset, VS Code packages included. Builds are not
bit-for-bit reproducible across runner image updates.
