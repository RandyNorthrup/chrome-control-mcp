// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_control.h"
#include "chrome_control_mcp/browser_extension_installer.h"
#include "chrome_control_mcp/mcp_dispatch.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QSet>
#include <QtTest/QtTest>

using namespace chrome_control_mcp;

namespace {

QJsonObject request(const QString &method, const QJsonValue &id,
                    const QJsonObject &params = {}) {
  QJsonObject value{{QStringLiteral("jsonrpc"), QStringLiteral("2.0")},
                    {QStringLiteral("method"), method}};
  if (!id.isUndefined()) {
    value.insert(QStringLiteral("id"), id);
  }
  if (!params.isEmpty()) {
    value.insert(QStringLiteral("params"), params);
  }
  return value;
}

QJsonObject toolCall(const QString &name,
                     const QJsonValue &arguments = QJsonObject{}) {
  return request(QStringLiteral("tools/call"), 3,
                 QJsonObject{{QStringLiteral("name"), name},
                             {QStringLiteral("arguments"), arguments}});
}

QSet<QString> catalogNames(const QJsonObject &response) {
  QSet<QString> names;
  const QJsonArray tools = response.value(QStringLiteral("result"))
                               .toObject()
                               .value(QStringLiteral("tools"))
                               .toArray();
  for (const QJsonValue &value : tools) {
    names.insert(value.toObject().value(QStringLiteral("name")).toString());
  }
  return names;
}

} // namespace

class BrowserMcpServerTests : public QObject {
  Q_OBJECT

private slots:
  void initializeReportsStandaloneIdentity();
  void fullCatalogContainsEveryBrowserAndInstallerTool();
  void readOnlyCatalogFiltersMutatingTools();
  void notificationGetsNoResponse();
  void malformedEnvelopeIsRejected();
  void nonObjectArgumentsAreRejected();
  void installerStatusReturnsMcpContent();
  void imageResultUsesMcpImageBlock();
};

void BrowserMcpServerTests::initializeReportsStandaloneIdentity() {
  const auto response = handleRequest(request(QStringLiteral("initialize"), 1));
  QVERIFY(response.has_value());
  const QJsonObject result =
      response->value(QStringLiteral("result")).toObject();
  QCOMPARE(result.value(QStringLiteral("protocolVersion")).toString(),
           QStringLiteral("2024-11-05"));
  QCOMPARE(result.value(QStringLiteral("serverInfo"))
               .toObject()
               .value(QStringLiteral("name"))
               .toString(),
           QStringLiteral("chrome-control-mcp"));
}

void BrowserMcpServerTests::fullCatalogContainsEveryBrowserAndInstallerTool() {
  BrowserControl browser;
  const auto response =
      handleRequest(request(QStringLiteral("tools/list"), 2), &browser);
  QVERIFY(response.has_value());
  const QSet<QString> names = catalogNames(*response);
  QCOMPARE(names.size(), 43);
  for (const QString &expected : {
           QStringLiteral("browser_navigate"),
           QStringLiteral("browser_snapshot"),
           QStringLiteral("browser_click"),
           QStringLiteral("browser_type"),
           QStringLiteral("browser_screenshot"),
           QStringLiteral("browser_tabs"),
           QStringLiteral("browser_download"),
           QStringLiteral("browser_cookies"),
           QStringLiteral("browser_print"),
           QStringLiteral("browser_extension_install"),
           QStringLiteral("browser_extension_uninstall"),
           QStringLiteral("browser_extension_status"),
       }) {
    QVERIFY2(names.contains(expected), qPrintable(expected));
  }
}

void BrowserMcpServerTests::readOnlyCatalogFiltersMutatingTools() {
  BrowserControl browser;
  Win32McpServerPolicy policy;
  policy.read_only_profile = true;
  const auto response =
      handleRequest(request(QStringLiteral("tools/list"), 2), &browser, policy);
  QVERIFY(response.has_value());
  const QSet<QString> names = catalogNames(*response);
  QCOMPARE(names.size(), 10);
  QVERIFY(names.contains(QStringLiteral("browser_snapshot")));
  QVERIFY(names.contains(QStringLiteral("browser_extension_status")));
  QVERIFY(!names.contains(QStringLiteral("browser_click")));
  QVERIFY(!names.contains(QStringLiteral("browser_extension_install")));
  const auto refused = handleRequest(toolCall(QStringLiteral("browser_click")),
                                     &browser, policy);
  QVERIFY(refused.has_value());
  QCOMPARE(refused->value(QStringLiteral("error"))
               .toObject()
               .value(QStringLiteral("code"))
               .toInt(),
           -32602);
}

void BrowserMcpServerTests::notificationGetsNoResponse() {
  const auto response = handleRequest(request(
      QStringLiteral("notifications/initialized"), QJsonValue::Undefined));
  QVERIFY(!response.has_value());
}

void BrowserMcpServerTests::malformedEnvelopeIsRejected() {
  QJsonObject malformed{
      {QStringLiteral("jsonrpc"), QStringLiteral("1.0")},
      {QStringLiteral("id"), 8},
      {QStringLiteral("method"), QStringLiteral("tools/list")}};
  const auto response = handleRequest(malformed);
  QVERIFY(response.has_value());
  QCOMPARE(response->value(QStringLiteral("error"))
               .toObject()
               .value(QStringLiteral("code"))
               .toInt(),
           -32600);
}

void BrowserMcpServerTests::nonObjectArgumentsAreRejected() {
  const auto response = handleRequest(toolCall(
      QStringLiteral("browser_extension_status"), QStringLiteral("bad")));
  QVERIFY(response.has_value());
  QCOMPARE(response->value(QStringLiteral("error"))
               .toObject()
               .value(QStringLiteral("code"))
               .toInt(),
           -32602);
}

void BrowserMcpServerTests::installerStatusReturnsMcpContent() {
  const auto response =
      handleRequest(toolCall(QStringLiteral("browser_extension_status")));
  QVERIFY(response.has_value());
  const QJsonObject result =
      response->value(QStringLiteral("result")).toObject();
  QCOMPARE(result.value(QStringLiteral("isError")).toBool(true), false);
  const QJsonArray content = result.value(QStringLiteral("content")).toArray();
  QCOMPARE(content.size(), 1);
  const QJsonObject payload =
      QJsonDocument::fromJson(content.first()
                                  .toObject()
                                  .value(QStringLiteral("text"))
                                  .toString()
                                  .toUtf8())
          .object();
  QCOMPARE(payload.value(QStringLiteral("extension_id")).toString(),
           QString::fromLatin1(kBrowserExtensionId));
  QVERIFY(payload.contains(QStringLiteral("state")));
}

void BrowserMcpServerTests::imageResultUsesMcpImageBlock() {
  const QJsonObject result =
      toolCallResult({.text = QStringLiteral("captured"),
                      .is_error = false,
                      .image_base64 = QStringLiteral("YWJj"),
                      .image_mime = QStringLiteral("image/png")});
  const QJsonArray content = result.value(QStringLiteral("content")).toArray();
  QCOMPARE(content.size(), 2);
  QCOMPARE(content.first().toObject().value(QStringLiteral("type")).toString(),
           QStringLiteral("image"));
  QCOMPARE(content.last().toObject().value(QStringLiteral("text")).toString(),
           QStringLiteral("captured"));
}

QTEST_MAIN(BrowserMcpServerTests)
#include "test_browser_mcp_server.moc"
