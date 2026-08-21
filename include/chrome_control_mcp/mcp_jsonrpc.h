// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QByteArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QString>

/// @file mcp_jsonrpc.h
/// @brief Model Context Protocol JSON-RPC 2.0 framing and validation.
namespace chrome_control_mcp::mcp {

/// MCP protocol revision this server speaks.
inline constexpr char kProtocolVersion[] = "2024-11-05";

/// Hard ceiling on a single newline-delimited JSON-RPC message. The stdio
/// transports already bound their own reads, but this fails closed for every
/// caller: a line larger than this is rejected before QJsonDocument::fromJson
/// allocates a DOM for it, so a hostile/oversized message cannot exhaust memory
/// here.
inline constexpr int kMaxJsonRpcMessageBytes = 16 * 1024 * 1024;

/// Serialize one JSON-RPC object as a single newline-delimited line (the stdio
/// transport frames one message per line).
[[nodiscard]] inline QByteArray jsonLine(const QJsonObject &object) {
  QByteArray bytes = QJsonDocument(object).toJson(QJsonDocument::Compact);
  bytes.append('\n');
  return bytes;
}

/// Parse one newline-delimited JSON-RPC line into an object. Returns an empty
/// object and sets @p error_message on malformed input; clears it on success.
[[nodiscard]] inline QJsonObject parseJsonLine(const QByteArray &line,
                                               QString *error_message) {
  if (line.size() > kMaxJsonRpcMessageBytes) {
    if (error_message) {
      *error_message = QStringLiteral("MCP message exceeds the %1-byte ceiling")
                           .arg(kMaxJsonRpcMessageBytes);
    }
    return {};
  }
  QJsonParseError parse_error;
  const QJsonDocument doc =
      QJsonDocument::fromJson(line.trimmed(), &parse_error);
  if (parse_error.error != QJsonParseError::NoError || !doc.isObject()) {
    if (error_message) {
      *error_message = QStringLiteral("Invalid MCP stdio JSON response: %1")
                           .arg(parse_error.errorString());
    }
    return {};
  }
  const QJsonObject object = doc.object();
  // JSON-RPC 2.0 mandates the version tag on every request, response, and
  // notification. Reject a message that omits or misstates it rather than
  // passing an unvalidated object onward as success -- an arbitrary
  // syntactically-valid object is not a JSON-RPC message.
  if (object.value(QStringLiteral("jsonrpc")).toString() !=
      QLatin1String("2.0")) {
    if (error_message) {
      *error_message =
          QStringLiteral("MCP message is missing the JSON-RPC 2.0 version tag");
    }
    return {};
  }
  if (error_message) {
    error_message->clear();
  }
  return object;
}

} // namespace chrome_control_mcp::mcp
