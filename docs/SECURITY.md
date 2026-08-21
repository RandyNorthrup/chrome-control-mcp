# Security

## Profiles

Unset `CHROME_CONTROL_MCP_SECURITY_PROFILE` means full access. This includes navigation, input,
tabs, cookies, permissions, downloads, storage mutation, printing, HTTP auth, and extension
preparation/removal.

MCP client owns human approval. Use read-only unless the client reliably confirms mutating tools:

```text
CHROME_CONTROL_MCP_SECURITY_PROFILE=read_only
CHROME_CONTROL_MCP_REDACT_SENSITIVE_OUTPUT=true
```

Only exact `read_only` enables the restricted profile. Any other non-empty token fails closed to
read-only. Redaction accepts exact `true` or `false`; other non-empty values fail closed to
redaction.

Redaction is best-effort text masking. Screenshots and unmodeled secret shapes remain outside its
guarantee.

## Defenses

- Native host accepts only the pinned extension origin.
- Named pipe uses current-user DACL and Medium-integrity no-write-up label.
- Pipe name contains a per-user/session nonce; rendezvous is project-scoped.
- Relay verifies server executable code identity.
- Protocol handshake and all major payloads are bounded.
- One outstanding command prevents reply mispairing.
- New relay generation invalidates old refs.
- Ref actions fail when page or session changed.
- Coordinate clicks require a fresh viewport screenshot fingerprint.
- Screenshots hide control presence by default; the overlay is included only when the caller sets
  `include_control_overlay: true` for a user-facing capture.
- Storage operations create an isolated world, verify its live origin, and call pristine Storage
  methods instead of page-overridable JavaScript properties.
- Dialog defaults reject confirm/prompt; explicit response is one-shot.
- Download URL and relative filename validation fail closed.
- Strict schemas reject unknown arguments and wrong types.

## Browser identity

- Extension ID: `iojehhmnaigcejfcpmilpclmeljhlkaa`
- Native host: `com.chromecontrolmcp.browser`
- Rendezvous: `%LOCALAPPDATA%\ChromeControlMCP\browser_bridge.json`
- Pipe prefix: `ChromeControlMCP_BrowserBridge`

The manifest's public identity field pins the unpacked extension ID. It is not secret and cannot
sign a package. This project creates, stores, and requires no private extension key.

## Chrome privileges

The extension requests `nativeMessaging`, `debugger`, `tabs`, `tabGroups`, `contentSettings`,
`cookies`, `downloads`, and `<all_urls>`. Full browser control needs these privileges. Use trusted
builds only.

Preparation writes only the current user's native-host registration and generated host manifest.
Removal deletes only this project's native-host key and generated manifest. Chrome installation
and removal of the unpacked extension remain explicit user actions in `chrome://extensions`.
