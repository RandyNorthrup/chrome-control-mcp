// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

/// @file mcp_tools.h
/// @brief Native, in-tree implementation of the desktop MCP tool surface.
///
/// Platform-specific desktop tools are backed by native operating-system APIs;
/// browser tools remain portable through Chrome's DevTools Protocol.
namespace chrome_control_mcp {

/// One tool invocation result. `text` is the (usually JSON) payload surfaced to
/// the model as MCP text content; `is_error` marks a failed call so the
/// transport sets the MCP `isError` flag rather than pretending success.
/// `image_base64` (with `image_mime`) is an optional binary image -- a browser
/// screenshot -- returned as an MCP `image` content block instead of a base64
/// blob buried in text; empty means the result is text only.
struct ToolResult {
  QString text;
  bool is_error{false};
  QString image_base64;
  QString image_mime;
};

/// The static tool catalog returned by `tools/list`: one object per tool with
/// `name`, `description`, and a JSON-Schema `inputSchema`. Shape mirrors the
/// tools the external server advertised so the model sees a stable interface.
[[nodiscard]] QJsonArray toolCatalog();

/// Dispatch a `tools/call` by name. An unknown name yields an error ToolResult
/// (never a crash) so a mistaken model call degrades cleanly.
[[nodiscard]] ToolResult invokeTool(const QString &name,
                                    const QJsonObject &arguments);

/// Server identity for `initialize.serverInfo`.
[[nodiscard]] QString serverName();
[[nodiscard]] QString serverVersion();

} // namespace chrome_control_mcp
