// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include "chrome_control_mcp/mcp_tools.h"

#include <QJsonObject>

#include <optional>

/// @file mcp_dispatch.h
/// @brief JSON-RPC 2.0 request routing for the native MCP server, kept
/// separate from the stdio loop so it can be unit-tested by feeding request
/// objects and inspecting response objects with no process I/O.
namespace chrome_control_mcp {

class BrowserControl;

/// Server-side enforcement of security controls supplied through the process
/// environment. A value read once at startup holds for the process lifetime.
/// An unset token keeps the permissive/no-redaction default while any
/// unrecognized token fails closed (see fromEnvironment).
struct McpServerPolicy {
  // CHROME_CONTROL_MCP_SECURITY_PROFILE == "read_only": tools/list advertises
  // only read-only tools and tools/call refuses any non-read-only tool, so a
  // read-only session cannot invoke a mutating or input tool even if the
  // client's own policy gate were bypassed.
  bool read_only_profile{false};
  // CHROME_CONTROL_MCP_REDACT_SENSITIVE_OUTPUT == "true": mask the secret
  // assignments redactMcpSensitiveText models in the TEXT blocks of a tool
  // result before it leaves the process. Scope is that keyword scrubber and
  // text blocks only -- image blocks (screenshots) and secrets in a shape it
  // does not model pass through, so this reduces exposure rather than
  // guaranteeing no credential reaches the model.
  bool redact_sensitive_output{false};

  /// Read both tokens from the process environment. An unrecognized non-empty
  /// token is an operator typo and resolves to the RESTRICTIVE state (read-only
  /// / redacting), never to the full surface.
  [[nodiscard]] static McpServerPolicy fromEnvironment();
};

/// Whether a tool is read-only (no mutation, no input injection, no process
/// control). The server enforces this independently so it never trusts the
/// client.
[[nodiscard]] bool mcpToolIsReadOnly(const QString &tool_name);

/// Mask the secret assignments this scrubber models
/// (password/pwd/secret/token/api key/access key/client secret/bearer, in
/// `key=value`, `key: value` and quoted-JSON shapes) in @p text. Best-effort by
/// design: a credential in a shape it does not model passes through unchanged,
/// so callers must treat it as exposure reduction, not a guarantee. Exposed for
/// unit testing.
[[nodiscard]] QString redactMcpSensitiveText(const QString &text);

/// Validate tool-call @p args against a native tool's advertised @p
/// input_schema: returns an empty string when the args conform, else a
/// fail-closed rejection reason (missing required argument, unknown key under
/// additionalProperties:false, or a wrong-typed value). The server enforces
/// this independently of the client. Exposed for unit testing.
[[nodiscard]] QString
mcpValidateArgsAgainstSchema(const QJsonObject &input_schema,
                             const QJsonObject &args);

/// Shape a ToolResult into the MCP `tools/call` result object. A screenshot
/// (image present) becomes an `image` content block plus an optional text
/// summary; a text result stays a single `text` block. Exposed so the content
/// shaping -- including the image branch -- is unit-testable without a live
/// browser.
[[nodiscard]] QJsonObject toolCallResult(const ToolResult &result);

/// Handle one parsed JSON-RPC request. Returns the response object to write
/// back, or std::nullopt for notifications (no `id`, e.g.
/// notifications/initialized) which the protocol says must not be answered.
///
/// When @p browser is non-null, its `browser_*` tools are merged into
/// `tools/list` and a matching `tools/call` is routed to it (live browser
/// control). When null (the default, and every pure unit test), only the
/// built-in native tools are advertised and a browser_* call falls through to
/// the unknown-tool error.
[[nodiscard]] std::optional<QJsonObject>
handleRequest(const QJsonObject &request, BrowserControl *browser = nullptr,
              const McpServerPolicy &policy = {});

} // namespace chrome_control_mcp
