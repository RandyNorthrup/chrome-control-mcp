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
  void initializeCarriesClientAgnosticInstructions();
  void initializeHandsTheSanitizedClientNameToBrowserControl();
  void releaseIsAdvertisedAndNotReadOnly();
  void fullCatalogContainsEveryBrowserAndInstallerTool();
  void readOnlyCatalogFiltersMutatingTools();
  void catalogStaysWithinItsBudgetAndStable();
  void updateToolsAreServedNativelyNotThroughTheBridge();
  void notificationGetsNoResponse();
  void malformedEnvelopeIsRejected();
  void nonObjectArgumentsAreRejected();
  void installerStatusReturnsMcpContent();
  void imageResultUsesMcpImageBlock();
  void noticeIsABlockOfItsOwnAfterTheReply();
  void extensionStatusSaysWhatChromeIsRunning();
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

// MCP `instructions` reach whatever client connects, so they say how the tools
// fit together when agents share the server or the browser -- and name no
// client, because any of them may be the one reading.
void BrowserMcpServerTests::initializeCarriesClientAgnosticInstructions() {
  const auto response = handleRequest(request(QStringLiteral("initialize"), 1));
  QVERIFY(response.has_value());
  const QString instructions = response->value(QStringLiteral("result"))
                                   .toObject()
                                   .value(QStringLiteral("instructions"))
                                   .toString();
  QVERIFY(!instructions.isEmpty());
  for (const QString &needed : {
           QStringLiteral("browser_new_tab"),
           QStringLiteral("tab_id"),
           QStringLiteral("bound to the tab"),
           QStringLiteral("agent"),
           QStringLiteral("refused"),
           QStringLiteral("browser_upload"),
           QStringLiteral("browser_clipboard"),
           QStringLiteral("never the system clipboard"),
           // A version notice is for the user, who alone can act on it.
           QStringLiteral("tell the user what it says"),
           // Which Chrome profile a tab opens in is the agent's to choose.
           QStringLiteral("browser_new_tab's profile"),
           QStringLiteral("browser_release"),
           QStringLiteral("handed back"),
           // Find before a whole snapshot: the cheap way to an element.
           QStringLiteral("browser_find"),
           QStringLiteral("keep_open:true"),
       }) {
    QVERIFY2(instructions.contains(needed), qPrintable(needed));
  }
  for (const QString &client : {
           QStringLiteral("Claude"),
           QStringLiteral("Codex"),
           QStringLiteral("Copilot"),
           QStringLiteral("Cursor"),
           QStringLiteral("Anthropic"),
           QStringLiteral("OpenAI"),
       }) {
    QVERIFY2(!instructions.contains(client, Qt::CaseInsensitive),
             qPrintable(client));
  }
  // Claude Code cuts server instructions at 4,096 characters.
  QVERIFY(instructions.size() <= 4096);
}

// clientInfo.name titles the tab group the extension marks this session's tabs
// with, so it is captured at initialize -- through the same sanitizer the
// frames use -- and a re-initialize without one clears it.
void BrowserMcpServerTests::
    initializeHandsTheSanitizedClientNameToBrowserControl() {
  BrowserControl browser;
  QVERIFY(browser.clientName().isEmpty());
  const auto named = handleRequest(
      request(QStringLiteral("initialize"), 1,
              QJsonObject{{QStringLiteral("clientInfo"),
                           QJsonObject{{QStringLiteral("name"),
                                        QStringLiteral("\u0007 my-client\n "
                                                       "with a name far too "
                                                       "long to keep")},
                                       {QStringLiteral("version"),
                                        QStringLiteral("1")}}}}),
      &browser);
  QVERIFY(named.has_value());
  QCOMPARE(browser.clientName(),
           QStringLiteral("my-client with a name far too lo"));

  const auto unnamed = handleRequest(
      request(QStringLiteral("initialize"), 2,
              QJsonObject{{QStringLiteral("clientInfo"),
                           QJsonObject{{QStringLiteral("name"), 42}}}}),
      &browser);
  QVERIFY(unnamed.has_value());
  QVERIFY(browser.clientName().isEmpty());
}

void BrowserMcpServerTests::releaseIsAdvertisedAndNotReadOnly() {
  QVERIFY(!mcpToolIsReadOnly(QStringLiteral("browser_release")));
  BrowserControl browser;
  const auto full =
      handleRequest(request(QStringLiteral("tools/list"), 2), &browser);
  QVERIFY(full.has_value());
  QVERIFY(catalogNames(*full).contains(QStringLiteral("browser_release")));

  McpServerPolicy policy;
  policy.read_only_profile = true;
  const auto readOnly =
      handleRequest(request(QStringLiteral("tools/list"), 3), &browser, policy);
  QVERIFY(readOnly.has_value());
  QVERIFY(!catalogNames(*readOnly).contains(QStringLiteral("browser_release")));
  const auto refused = handleRequest(
      toolCall(QStringLiteral("browser_release")), &browser, policy);
  QVERIFY(refused.has_value());
  QCOMPARE(refused->value(QStringLiteral("error"))
               .toObject()
               .value(QStringLiteral("code"))
               .toInt(),
           -32602);
}

// A client keeps the catalog as part of every prompt and caches it as a
// prefix, so it is held to a byte budget -- 1.11.1's was 44,965 bytes for 53
// tools -- and must be the same bytes every time it is listed.
void BrowserMcpServerTests::catalogStaysWithinItsBudgetAndStable() {
  BrowserControl browser;
  const auto first =
      handleRequest(request(QStringLiteral("tools/list"), 2), &browser);
  const auto second =
      handleRequest(request(QStringLiteral("tools/list"), 3), &browser);
  QVERIFY(first.has_value() && second.has_value());
  const QByteArray listed = QJsonDocument(first->value(QStringLiteral("result"))
                                              .toObject()
                                              .value(QStringLiteral("tools"))
                                              .toArray())
                                .toJson(QJsonDocument::Compact);
  const QByteArray again = QJsonDocument(second->value(QStringLiteral("result"))
                                             .toObject()
                                             .value(QStringLiteral("tools"))
                                             .toArray())
                               .toJson(QJsonDocument::Compact);
  QCOMPARE(listed, again);
  QVERIFY2(listed.size() <= 43500, qPrintable(QString::number(listed.size())));
}

void BrowserMcpServerTests::fullCatalogContainsEveryBrowserAndInstallerTool() {
  BrowserControl browser;
  const auto response =
      handleRequest(request(QStringLiteral("tools/list"), 2), &browser);
  QVERIFY(response.has_value());
  const QSet<QString> names = catalogNames(*response);
  QCOMPARE(names.size(), 54);
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
           QStringLiteral("browser_update_status"),
           QStringLiteral("browser_update_check"),
           QStringLiteral("browser_update_apply"),
       }) {
    QVERIFY2(names.contains(expected), qPrintable(expected));
  }
}

void BrowserMcpServerTests::updateToolsAreServedNativelyNotThroughTheBridge() {
  // browser_update_* shares the browser_ prefix but needs no browser. Routed to
  // the bridge it would answer "browser not connected" for a question about
  // this program's own install -- which is exactly when someone reaches for it.
  BrowserControl browser;
  const auto response = handleRequest(
      toolCall(QStringLiteral("browser_update_status")), &browser);
  QVERIFY(response.has_value());
  const QJsonObject result =
      response->value(QStringLiteral("result")).toObject();
  QVERIFY(!result.value(QStringLiteral("isError")).toBool());
  const QString text = result.value(QStringLiteral("content"))
                           .toArray()
                           .at(0)
                           .toObject()
                           .value(QStringLiteral("text"))
                           .toString();
  const QJsonObject facts = QJsonDocument::fromJson(text.toUtf8()).object();
  QVERIFY(facts.contains(QStringLiteral("install_root")));
  QVERIFY(facts.contains(QStringLiteral("installed_versions")));
  QCOMPARE(facts.value(QStringLiteral("version")).toString(), serverVersion());
}

void BrowserMcpServerTests::readOnlyCatalogFiltersMutatingTools() {
  BrowserControl browser;
  McpServerPolicy policy;
  policy.read_only_profile = true;
  const auto response =
      handleRequest(request(QStringLiteral("tools/list"), 2), &browser, policy);
  QVERIFY(response.has_value());
  const QSet<QString> names = catalogNames(*response);
  QCOMPARE(names.size(), 15);
  QVERIFY(names.contains(QStringLiteral("browser_snapshot")));
  QVERIFY(names.contains(QStringLiteral("browser_find")));
  QVERIFY(names.contains(QStringLiteral("browser_extension_status")));
  QVERIFY(names.contains(QStringLiteral("browser_update_check")));
  QVERIFY(names.contains(QStringLiteral("browser_update_status")));
  // Reporting what the page already said and already fetched changes nothing
  // about the page, so both belong in a profile whose whole promise is that it
  // cannot.
  QVERIFY(names.contains(QStringLiteral("browser_console")));
  QVERIFY(names.contains(QStringLiteral("browser_network")));
  QVERIFY(!names.contains(QStringLiteral("browser_click")));
  QVERIFY(!names.contains(QStringLiteral("browser_extension_install")));
  // Installing a release is a mutating, process-replacing action, so the
  // read-only profile must hide it even though its two companions are safe.
  QVERIFY(!names.contains(QStringLiteral("browser_update_apply")));
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

void BrowserMcpServerTests::noticeIsABlockOfItsOwnAfterTheReply() {
  const ToolResult reply{.text = QStringLiteral("{\"ok\":true}"),
                         .is_error = false,
                         .image_base64 = {},
                         .image_mime = {}};
  // No notice: exactly the one block it always was.
  const QJsonArray plain =
      toolCallResult(reply).value(QStringLiteral("content")).toArray();
  QCOMPARE(plain.size(), 1);

  // A notice comes last and on its own, so the reply's JSON still parses.
  const QJsonObject told =
      toolCallResult(reply, QStringLiteral("Note: reload the extension."));
  const QJsonArray content = told.value(QStringLiteral("content")).toArray();
  QCOMPARE(content.size(), 2);
  QVERIFY(QJsonDocument::fromJson(content.first()
                                      .toObject()
                                      .value(QStringLiteral("text"))
                                      .toString()
                                      .toUtf8())
              .isObject());
  QCOMPARE(content.last().toObject().value(QStringLiteral("type")).toString(),
           QStringLiteral("text"));
  QCOMPARE(content.last().toObject().value(QStringLiteral("text")).toString(),
           QStringLiteral("Note: reload the extension."));
  QCOMPARE(told.value(QStringLiteral("isError")).toBool(true), false);
}

void BrowserMcpServerTests::extensionStatusSaysWhatChromeIsRunning() {
  // With a browser facade, the status asks the connection -- here, none yet.
  BrowserControl browser;
  const auto response = handleRequest(
      toolCall(QStringLiteral("browser_extension_status")), &browser);
  QVERIFY(response.has_value());
  const QJsonObject payload =
      QJsonDocument::fromJson(response->value(QStringLiteral("result"))
                                  .toObject()
                                  .value(QStringLiteral("content"))
                                  .toArray()
                                  .first()
                                  .toObject()
                                  .value(QStringLiteral("text"))
                                  .toString()
                                  .toUtf8())
          .object();
  QVERIFY(payload.contains(QStringLiteral("state")));
  const QJsonObject running =
      payload.value(QStringLiteral("running")).toObject();
  QCOMPARE(running.value(QStringLiteral("connected")).toBool(true), false);
  QCOMPARE(running.value(QStringLiteral("connections")).toInt(-1), 0);
  QCOMPARE(running.value(QStringLiteral("server_version")).toString(),
           QString::fromLatin1(kBrowserExtensionVersion));
  QVERIFY(running.value(QStringLiteral("extension_version")).isNull());
  QVERIFY(running.value(QStringLiteral("installed_version")).isNull());

  // Under the read-only profile too: it is one of the tools that only looks.
  McpServerPolicy policy;
  policy.read_only_profile = true;
  const auto read_only = handleRequest(
      toolCall(QStringLiteral("browser_extension_status")), &browser, policy);
  QVERIFY(read_only.has_value());
  QVERIFY(read_only->contains(QStringLiteral("result")));
}

QTEST_MAIN(BrowserMcpServerTests)
#include "test_browser_mcp_server.moc"
