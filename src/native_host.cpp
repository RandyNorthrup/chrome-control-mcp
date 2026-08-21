// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// NOT COMPILED INTO THE SHIPPING BINARY. This translation unit supplies a pure
// native-messaging handshake dispatcher for protocol tests. Production framing
// and relay behavior live in the platform bridge relay.

#include "chrome_control_mcp/native_host.h"

#include "chrome_control_mcp/native_messaging.h"

#include <QCoreApplication>

namespace chrome_control_mcp {

namespace {

QJsonObject pongReply(const QJsonObject &request, const QString &server_name,
                      const QString &server_version) {
  QJsonObject reply{{QStringLiteral("type"), QStringLiteral("pong")},
                    {QStringLiteral("server"), server_name},
                    {QStringLiteral("version"), server_version},
                    {QStringLiteral("protocol"), kBrowserBridgeProtocol},
                    {QStringLiteral("pid"),
                     static_cast<double>(QCoreApplication::applicationPid())}};
  if (request.contains(QStringLiteral("id"))) {
    reply.insert(QStringLiteral("id"), request.value(QStringLiteral("id")));
  }
  return reply;
}

QJsonObject typedError(const QJsonObject &request, const QString &message) {
  QJsonObject reply{{QStringLiteral("type"), QStringLiteral("error")},
                    {QStringLiteral("error"), message}};
  if (request.contains(QStringLiteral("id"))) {
    reply.insert(QStringLiteral("id"), request.value(QStringLiteral("id")));
  }
  return reply;
}

} // namespace

QJsonObject handleNativeMessage(const QJsonObject &request,
                                const QString &server_name,
                                const QString &server_version) {
  const QString type = request.value(QStringLiteral("type")).toString();
  if (type == QLatin1String("ping")) {
    return pongReply(request, server_name, server_version);
  }
  // Later units add snapshot/click/type/... forwarding here. Until then an
  // unknown type is a clean, correlated error rather than a dropped message.
  return typedError(request,
                    QStringLiteral("Unsupported message type: '%1'").arg(type));
}

} // namespace chrome_control_mcp
