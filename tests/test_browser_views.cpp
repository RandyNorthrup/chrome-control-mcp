// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The views over one snapshot capture (docs/plans/lean-observations.md): the
// slimming every outline gets, browser_snapshot's options and elision,
// browser_find's matching and replies, browser_read's paging, and those three
// tools through the bridge session, where a find's refs are installed exactly
// as a snapshot's.

#include "chrome_control_mcp/browser_bridge.h"
#include "chrome_control_mcp/browser_contract.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QtTest/QtTest>

using chrome_control_mcp::browser::BrowserBridgeSession;
using chrome_control_mcp::browser::FindQuery;
using chrome_control_mcp::browser::findQueryFrom;
using chrome_control_mcp::browser::Outline;
using chrome_control_mcp::browser::OutlineOptions;
using chrome_control_mcp::browser::outlineOptionsFrom;
using chrome_control_mcp::browser::pageRead;
using chrome_control_mcp::browser::ReadRequest;
using chrome_control_mcp::browser::readRequestFrom;
using chrome_control_mcp::browser::renderFind;
using chrome_control_mcp::browser::renderOutline;
using chrome_control_mcp::browser::renderSnapshot;
using chrome_control_mcp::browser::SnapshotView;

namespace {

constexpr int kTab = 7;

// One capture record, as the extension sends it.
QJsonObject rec(int backend, const QString &role, const QString &name,
                int depth, bool interactable = false, bool offscreen = false) {
  QJsonObject node{
      {QStringLiteral("backendNodeId"), backend},
      {QStringLiteral("role"), role},
      {QStringLiteral("name"), name},
      {QStringLiteral("interactable"), interactable},
      {QStringLiteral("visible"), true},
      {QStringLiteral("depth"), depth},
      {QStringLiteral("bounds"), QJsonObject{{QStringLiteral("x"), 0},
                                             {QStringLiteral("y"), 0},
                                             {QStringLiteral("width"), 80},
                                             {QStringLiteral("height"), 20}}}};
  if (offscreen) {
    node.insert(QStringLiteral("offscreen"), true);
  }
  return node;
}

// A capture of @p nodes; with @p positions it reports a viewport, as an
// extension 1.12.0 or later does.
QJsonObject capture(const QJsonArray &nodes, bool positions = true) {
  QJsonObject out{{QStringLiteral("url"), QStringLiteral("https://a.test/")},
                  {QStringLiteral("title"), QStringLiteral("A")},
                  {QStringLiteral("nodes"), nodes}};
  if (positions) {
    out.insert(QStringLiteral("viewport"),
               QJsonObject{{QStringLiteral("scrollX"), 0},
                           {QStringLiteral("scrollY"), 0},
                           {QStringLiteral("width"), 1280},
                           {QStringLiteral("height"), 720}});
  }
  return out;
}

// The /find fixture's shape: a Messages dialog with a Send message button, a
// reply field and a View replies (1) link; a feed far below the fold with many
// posts and a Load more button; a footer.
QJsonObject messagesPage(bool positions = true) {
  QJsonArray nodes{
      rec(1, QStringLiteral("main"), QString(), 0),
      rec(2, QStringLiteral("heading"), QStringLiteral("Inbox"), 1),
      rec(3, QStringLiteral("dialog"), QStringLiteral("Messages"), 1),
      rec(4, QStringLiteral("button"), QStringLiteral("Send message"), 2, true),
      rec(5, QStringLiteral("statictext"), QStringLiteral("Send message"), 3),
      rec(6, QStringLiteral("textbox"), QStringLiteral("Write your reply"), 2,
          true),
      rec(7, QStringLiteral("link"), QStringLiteral("View replies (1)"), 2,
          true),
      rec(8, QStringLiteral("link"), QStringLiteral("Send message to support"),
          2, true),
      rec(9, QStringLiteral("feed"), QStringLiteral("Posts"), 1, false, true)};
  int backend = 100;
  for (int post = 0; post < 40; ++post) {
    nodes.append(rec(backend++, QStringLiteral("article"),
                     QStringLiteral("Post %1").arg(post), 2, false, true));
    nodes.append(
        rec(backend++, QStringLiteral("statictext"),
            QStringLiteral("Body of post number %1 with some words").arg(post),
            3, false, true));
  }
  nodes.append(rec(10, QStringLiteral("button"), QStringLiteral("Load more"), 2,
                   true, true));
  nodes.append(rec(11, QStringLiteral("contentinfo"), QString(), 0));
  nodes.append(rec(12, QStringLiteral("link"), QStringLiteral("Privacy"), 1,
                   true, true));
  return capture(nodes, positions);
}

QString refOf(const QString &text, const QString &line_start) {
  const QRegularExpression pattern(QRegularExpression::escape(line_start) +
                                   QStringLiteral("[^\\n]*\\[ref=(e\\d+)\\]"));
  return pattern.match(text).captured(1);
}

QJsonObject frame(const QString &id, const QString &cmd,
                  const QJsonObject &payload) {
  return QJsonObject{{QStringLiteral("type"), QStringLiteral("result")},
                     {QStringLiteral("id"), id},
                     {QStringLiteral("cmd"), cmd},
                     {QStringLiteral("tabId"), kTab},
                     {QStringLiteral("payload"), payload}};
}

} // namespace

class BrowserViewsTests : public QObject {
  Q_OBJECT

private slots:
  static void slim_dropsTextThatRepeatsItsParent();
  static void slim_foldsWrappersAroundOneLine();
  static void slim_indentsByShownAncestors();
  static void containers_carryRefs();
  static void outline_refShowsOneSubtreeWithTheSameRefs();
  static void outline_depthAndInteractive();
  static void outline_viewportNeedsPositionsAndCountsTheRest();
  static void outline_refNoLongerShownIsRefused();
  static void outline_elidesRegionsNotTheTail();
  static void outline_elisionWithoutPositionsKeepsTheTop();
  static void options_refuseBadValues();
  static void find_exactMatchFirstWithItsContainers();
  static void find_queryRoleWordFiltersByRole();
  static void find_roleRegexAndMaxResults();
  static void find_noMatchNamesTheClosest();
  static void find_offscreenRanksBelowAndSaysSo();
  static void find_roleWordInTheNameFallsBack();
  static void findQuery_refusesBadArguments();
  static void read_refusesBadArguments();
  static void read_pagesAnOlderExtensionsWholeReply();
  static void read_holdsACurrentExtensionToTheRequest();
  static void read_refusesAScopedReadAnOlderExtensionIgnored();
  static void session_findInstallsRefsAClickCanUse();
  static void session_snapshotOptionsAndReadPaging();
  static void session_aRefusedViewStillInstallsTheCapture();
};

void BrowserViewsTests::slim_dropsTextThatRepeatsItsParent() {
  const SnapshotView view = renderSnapshot(capture(QJsonArray{
      rec(1, QStringLiteral("link"), QStringLiteral("Send message"), 0, true),
      rec(2, QStringLiteral("statictext"), QStringLiteral("Send message"), 1),
      // Chrome splits a text node into inline runs, each repeating part of it.
      rec(20, QStringLiteral("inlinetextbox"), QStringLiteral("Send message"),
          2),
      rec(3, QStringLiteral("link"), QStringLiteral("View replies (1)"), 0,
          true),
      rec(4, QStringLiteral("statictext"), QStringLiteral("View replies"), 1),
      rec(5, QStringLiteral("statictext"), QStringLiteral("(1)"), 1),
      rec(6, QStringLiteral("heading"), QStringLiteral("News"), 0),
      rec(7, QStringLiteral("statictext"), QStringLiteral("Other words here"),
          1),
      rec(21, QStringLiteral("inlinetextbox"), QStringLiteral("Other words"),
          2),
      rec(22, QStringLiteral("inlinetextbox"), QStringLiteral("here"), 2)}));
  QCOMPARE(view.outline,
           QStringLiteral("- link \"Send message\" [ref=e1]\n"
                          "- link \"View replies (1)\" [ref=e2]\n"
                          "- heading \"News\"\n"
                          "  - statictext \"Other words here\"\n"));
  QCOMPARE(view.element_count, 2);

  // A paragraph longer than the outline's name cap: its runs past the cap are
  // still its own text, and a link whose long label its text repeats in full
  // still carries the only line.
  const QString story = QString(400, QLatin1Char('a'));
  const QString label =
      QStringLiteral("Read the whole story ") + QString(150, QLatin1Char('b'));
  const SnapshotView long_text = renderSnapshot(capture(
      QJsonArray{rec(1, QStringLiteral("statictext"), story, 0),
                 rec(2, QStringLiteral("inlinetextbox"), story.left(200), 1),
                 rec(3, QStringLiteral("inlinetextbox"), story.mid(200), 1),
                 rec(4, QStringLiteral("link"), label, 0, true),
                 rec(5, QStringLiteral("statictext"), label, 1)}));
  QCOMPARE(long_text.lines.size(), 2);
  QCOMPARE(long_text.lines[0].role, QStringLiteral("statictext"));
  QCOMPARE(long_text.lines[1].role, QStringLiteral("link"));
}

void BrowserViewsTests::slim_foldsWrappersAroundOneLine() {
  const SnapshotView view = renderSnapshot(capture(QJsonArray{
      rec(1, QStringLiteral("group"), QString(), 0),
      rec(2, QStringLiteral("paragraph"), QString(), 1),
      rec(3, QStringLiteral("statictext"), QStringLiteral("Hello"), 2),
      rec(4, QStringLiteral("group"), QString(), 0),
      rec(5, QStringLiteral("button"), QStringLiteral("One"), 1, true),
      rec(6, QStringLiteral("button"), QStringLiteral("Two"), 1, true)}));
  // The chain of wrappers around one line folds away; a wrapper holding two
  // lines stays, as their structure.
  QCOMPARE(view.outline, QStringLiteral("- statictext \"Hello\"\n"
                                        "- group\n"
                                        "  - button \"One\" [ref=e1]\n"
                                        "  - button \"Two\" [ref=e2]\n"));
}

void BrowserViewsTests::slim_indentsByShownAncestors() {
  const SnapshotView view = renderSnapshot(capture(QJsonArray{
      rec(1, QStringLiteral("navigation"), QStringLiteral("Site"), 0),
      rec(2, QStringLiteral("button"), QStringLiteral("Deep"), 9, true),
      rec(3, QStringLiteral("link"), QStringLiteral("Deeper"), 14, true)}));
  QCOMPARE(view.outline, QStringLiteral("- navigation \"Site\" [ref=e1]\n"
                                        "  - button \"Deep\" [ref=e2]\n"
                                        "    - link \"Deeper\" [ref=e3]\n"));
}

void BrowserViewsTests::containers_carryRefs() {
  const SnapshotView view = renderSnapshot(messagesPage());
  for (const QString &start :
       {QStringLiteral("- main"), QStringLiteral("  - dialog \"Messages\""),
        QStringLiteral("  - feed \"Posts\""),
        QStringLiteral("- contentinfo")}) {
    QVERIFY2(!refOf(view.outline, start).isEmpty(), qPrintable(start));
  }
  QVERIFY(refOf(view.outline, QStringLiteral("  - heading")).isEmpty());
}

void BrowserViewsTests::outline_refShowsOneSubtreeWithTheSameRefs() {
  const SnapshotView view = renderSnapshot(messagesPage());
  const QString dialog = refOf(view.outline, QStringLiteral("  - dialog"));
  OutlineOptions options;
  options.ref = dialog;
  const Outline outline = renderOutline(view, options);
  QVERIFY(outline.error.isEmpty());
  QVERIFY(
      outline.text.startsWith(QStringLiteral("- dialog \"Messages\" [ref=") +
                              dialog + QStringLiteral("]\n")));
  QCOMPARE(outline.shown, 5);
  QCOMPARE(
      refOf(outline.text, QStringLiteral("  - button \"Send message\"")),
      refOf(view.outline, QStringLiteral("    - button \"Send message\"")));
  QVERIFY(!outline.text.contains(QStringLiteral("Load more")));
}

void BrowserViewsTests::outline_depthAndInteractive() {
  const SnapshotView view = renderSnapshot(messagesPage());
  OutlineOptions top;
  top.depth = 0;
  const Outline shallow = renderOutline(view, top);
  QCOMPARE(shallow.text.count(QLatin1Char('\n')), 2);
  QVERIFY(shallow.text.contains(QStringLiteral("- main")));
  QVERIFY(shallow.text.contains(QStringLiteral("- contentinfo")));

  OutlineOptions interactive;
  interactive.filter = QStringLiteral("interactive");
  const Outline acting = renderOutline(view, interactive);
  QVERIFY(acting.text.contains(QStringLiteral("heading \"Inbox\"")));
  QVERIFY(acting.text.contains(QStringLiteral("button \"Load more\"")));
  QVERIFY(!acting.text.contains(QStringLiteral("statictext")));
  QVERIFY(acting.shown < acting.total);
}

void BrowserViewsTests::outline_viewportNeedsPositionsAndCountsTheRest() {
  OutlineOptions options;
  options.filter = QStringLiteral("viewport");
  const Outline old =
      renderOutline(renderSnapshot(messagesPage(false)), options);
  QVERIFY(old.error.contains(QStringLiteral("chrome://extensions")));

  const Outline seen = renderOutline(renderSnapshot(messagesPage()), options);
  QVERIFY(seen.error.isEmpty());
  QVERIFY(seen.text.contains(QStringLiteral("Send message")));
  QVERIFY(!seen.text.contains(QStringLiteral("Load more")));
  QVERIFY(!seen.text.contains(QStringLiteral("Post 3")));
  QVERIFY(seen.text.contains(QStringLiteral("lines off-screen")));
}

void BrowserViewsTests::outline_refNoLongerShownIsRefused() {
  OutlineOptions options;
  options.ref = QStringLiteral("e999");
  const Outline outline =
      renderOutline(renderSnapshot(messagesPage()), options);
  QVERIFY(outline.error.contains(QStringLiteral("e999")));
  QVERIFY(outline.error.contains(QStringLiteral("browser_find")));
}

void BrowserViewsTests::outline_elidesRegionsNotTheTail() {
  const SnapshotView view = renderSnapshot(messagesPage());
  QVERIFY(view.outline.size() > 2000);
  OutlineOptions options;
  options.max_chars = 1000;
  const Outline outline = renderOutline(view, options);
  QVERIFY(outline.error.isEmpty());
  const QString &text = outline.text;
  // Everything on screen stays, the footer landmark stays (it is past the
  // feed, so a tail cut would have lost it), and the feed collapses to one
  // line saying how many it stands for and how to read them.
  QVERIFY(text.contains(QStringLiteral("button \"Send message\"")));
  QVERIFY(text.contains(QStringLiteral("link \"View replies (1)\"")));
  QVERIFY(text.contains(QStringLiteral("- contentinfo")));
  const QString feed = refOf(view.outline, QStringLiteral("  - feed"));
  QVERIFY2(text.contains(
               QStringLiteral("lines omitted: browser_snapshot ref=") + feed),
           qPrintable(text));
  QVERIFY(!text.contains(QStringLiteral("Post 7")));
  QVERIFY(text.contains(QStringLiteral("shortened to fit max_chars 1000")));
  const qsizetype body = text.indexOf(QStringLiteral("  ... (shortened"));
  QVERIFY(body > 0 && body <= 1000);
}

void BrowserViewsTests::outline_elisionWithoutPositionsKeepsTheTop() {
  const SnapshotView view = renderSnapshot(messagesPage(false));
  OutlineOptions options;
  options.max_chars = 1000;
  const Outline outline = renderOutline(view, options);
  QVERIFY(outline.text.contains(QStringLiteral("button \"Send message\"")));
  QVERIFY(outline.text.contains(QStringLiteral("lines omitted")));
}

void BrowserViewsTests::options_refuseBadValues() {
  OutlineOptions options;
  QVERIFY(outlineOptionsFrom(
              QJsonObject{{QStringLiteral("filter"), QStringLiteral("all")},
                          {QStringLiteral("depth"), 2},
                          {QStringLiteral("max_chars"), 5000}},
              &options)
              .isEmpty());
  QVERIFY(options.filter.isEmpty());
  QCOMPARE(options.depth, 2);
  QCOMPARE(options.max_chars, 5000);
  QVERIFY(outlineOptionsFrom(QJsonObject{{QStringLiteral("filter"),
                                          QStringLiteral("buttons")}},
                             &options)
              .contains(QStringLiteral("interactive")));
  QVERIFY(
      !outlineOptionsFrom(QJsonObject{{QStringLiteral("depth"), -1}}, &options)
           .isEmpty());
  QVERIFY(!outlineOptionsFrom(QJsonObject{{QStringLiteral("max_chars"), 10}},
                              &options)
               .isEmpty());
}

void BrowserViewsTests::find_exactMatchFirstWithItsContainers() {
  const SnapshotView view = renderSnapshot(messagesPage());
  FindQuery query;
  query.text = QStringLiteral("Send message");
  const QString found = renderFind(view, query);
  QVERIFY2(found.startsWith(QStringLiteral(
               "Found 2 matches for text \"Send message\":\n- button \"Send "
               "message\" [ref=")),
           qPrintable(found));
  const QString button = refOf(view.outline, QStringLiteral("    - button"));
  QCOMPARE(refOf(found, QStringLiteral("- button \"Send message\"")), button);
  QVERIFY(found.contains(QStringLiteral("    in: dialog \"Messages\" [ref=")));
  QVERIFY(found.contains(QStringLiteral("> main [ref=")));
  QVERIFY(found.indexOf(QStringLiteral("button \"Send message\"")) <
          found.indexOf(QStringLiteral("link \"Send message to support\"")));

  FindQuery replies;
  replies.text = QStringLiteral("View replies (1)");
  QVERIFY(renderFind(view, replies)
              .contains(QStringLiteral("- link \"View replies (1)\" [ref=")));
}

void BrowserViewsTests::find_queryRoleWordFiltersByRole() {
  const SnapshotView view = renderSnapshot(messagesPage());
  FindQuery query;
  query.text = QStringLiteral("Send message button");
  query.natural = true;
  const QString found = renderFind(view, query);
  QVERIFY2(found.startsWith(QStringLiteral("Found 1 match for query")),
           qPrintable(found));
  QVERIFY(found.contains(QStringLiteral("- button \"Send message\"")));
  QVERIFY(!found.contains(QStringLiteral("to support")));

  FindQuery buttons;
  buttons.text = QStringLiteral("buttons");
  buttons.natural = true;
  const QString all = renderFind(view, buttons);
  QVERIFY(all.contains(QStringLiteral("Send message")));
  QVERIFY(all.contains(QStringLiteral("Load more")));
  QVERIFY(!all.contains(QStringLiteral("- link")));
}

void BrowserViewsTests::find_roleRegexAndMaxResults() {
  const SnapshotView view = renderSnapshot(messagesPage());
  FindQuery links;
  links.text = QStringLiteral("replies");
  links.role = QStringLiteral("link");
  QVERIFY(renderFind(view, links)
              .contains(QStringLiteral("link \"View replies (1)\"")));

  FindQuery pattern;
  pattern.regex = QStringLiteral("^load");
  const QString loaded = renderFind(view, pattern);
  QVERIFY(loaded.startsWith(QStringLiteral("Found 1 match for regex /^load/")));

  FindQuery posts;
  posts.text = QStringLiteral("Post");
  posts.max_results = 2;
  const QString two = renderFind(view, posts);
  QVERIFY2(two.contains(QStringLiteral("(showing the best 2)")),
           qPrintable(two));
  QCOMPARE(two.count(QStringLiteral("\n- ")), 2);
}

void BrowserViewsTests::find_noMatchNamesTheClosest() {
  FindQuery query;
  query.text = QStringLiteral("Sned mesage");
  const QString found = renderFind(renderSnapshot(messagesPage()), query);
  QVERIFY2(found.startsWith(QStringLiteral(
               "No element matches text \"Sned mesage\". Closest names: "
               "\"Send message\"")),
           qPrintable(found));
  QVERIFY(found.contains(QStringLiteral("browser_snapshot")));
}

void BrowserViewsTests::find_offscreenRanksBelowAndSaysSo() {
  const SnapshotView view = renderSnapshot(capture(QJsonArray{
      rec(1, QStringLiteral("button"), QStringLiteral("Save"), 0, true, true),
      rec(2, QStringLiteral("button"), QStringLiteral("Save"), 0, true)}));
  FindQuery query;
  query.text = QStringLiteral("save");
  const QString found = renderFind(view, query);
  QVERIFY(found.indexOf(QStringLiteral("[ref=e2]")) <
          found.indexOf(QStringLiteral("[ref=e1]")));
  QVERIFY(found.contains(QStringLiteral("[ref=e1]\n    off-screen\n")));
}

void BrowserViewsTests::find_roleWordInTheNameFallsBack() {
  const SnapshotView view = renderSnapshot(
      capture(QJsonArray{rec(1, QStringLiteral("button"),
                             QStringLiteral("Image settings"), 0, true)}));
  FindQuery query;
  query.text = QStringLiteral("image settings");
  query.natural = true;
  QVERIFY(renderFind(view, query)
              .contains(QStringLiteral("- button \"Image settings\"")));
}

void BrowserViewsTests::findQuery_refusesBadArguments() {
  FindQuery query;
  QVERIFY(
      findQueryFrom(QJsonObject{}, &query).contains(QStringLiteral("text")));
  QVERIFY(
      findQueryFrom(QJsonObject{{QStringLiteral("text"), QStringLiteral("a")},
                                {QStringLiteral("regex"), QStringLiteral("b")}},
                    &query)
          .contains(QStringLiteral("not several")));
  QVERIFY(findQueryFrom(QJsonObject{{QStringLiteral("text"),
                                     QString(201, QLatin1Char('x'))}},
                        &query)
              .contains(QStringLiteral("200")));
  QVERIFY(
      findQueryFrom(
          QJsonObject{{QStringLiteral("regex"), QStringLiteral("([a")}}, &query)
          .contains(QStringLiteral("does not compile")));
  for (const int bad : {0, 21}) {
    QVERIFY(
        findQueryFrom(QJsonObject{{QStringLiteral("text"), QStringLiteral("a")},
                                  {QStringLiteral("max_results"), bad}},
                      &query)
            .contains(QStringLiteral("max_results")));
  }
  QVERIFY(findQueryFrom(
              QJsonObject{
                  {QStringLiteral("query"), QStringLiteral(" Send button ")},
                  {QStringLiteral("role"), QStringLiteral("Button")}},
              &query)
              .isEmpty());
  QVERIFY(query.natural);
  QCOMPARE(query.text, QStringLiteral("Send button"));
  QCOMPARE(query.role, QStringLiteral("button"));
  QCOMPARE(query.max_results, 10);
}

void BrowserViewsTests::read_refusesBadArguments() {
  ReadRequest request;
  QVERIFY(readRequestFrom(QJsonObject{}, &request).isEmpty());
  QCOMPARE(request.max_chars, 30000);
  QCOMPARE(request.offset, 0);
  QVERIFY(!request.scoped);
  QVERIFY(
      !readRequestFrom(QJsonObject{{QStringLiteral("offset"), -1}}, &request)
           .isEmpty());
  QVERIFY(
      !readRequestFrom(QJsonObject{{QStringLiteral("max_chars"), 0}}, &request)
           .isEmpty());
  QVERIFY(!readRequestFrom(QJsonObject{{QStringLiteral("max_chars"), 200001}},
                           &request)
               .isEmpty());
  QVERIFY(readRequestFrom(
              QJsonObject{{QStringLiteral("selector"), QStringLiteral("main")},
                          {QStringLiteral("mode"), QStringLiteral("main")}},
              &request)
              .contains(QStringLiteral("one of")));
  QVERIFY(!readRequestFrom(
               QJsonObject{{QStringLiteral("mode"), QStringLiteral("all")}},
               &request)
               .isEmpty());
  QVERIFY(!readRequestFrom(
               QJsonObject{{QStringLiteral("selector"), QStringLiteral("  ")}},
               &request)
               .isEmpty());
  QVERIFY(readRequestFrom(
              QJsonObject{{QStringLiteral("mode"), QStringLiteral("main")}},
              &request)
              .isEmpty());
  QVERIFY(request.scoped);
}

void BrowserViewsTests::read_pagesAnOlderExtensionsWholeReply() {
  ReadRequest request;
  request.offset = 10;
  request.max_chars = 20;
  // Every character different, so the page returned is the one asked for and
  // not merely one of the right length.
  QString text;
  for (int i = 0; i < 100; ++i) {
    text += QChar(u'A' + (i % 26));
  }
  QJsonObject payload{{QStringLiteral("format"), QStringLiteral("text")},
                      {QStringLiteral("content"), text},
                      {QStringLiteral("truncated"), false}};
  QVERIFY(pageRead(payload, request).isEmpty());
  QCOMPARE(payload.value(QStringLiteral("content")).toString(),
           text.mid(10, 20));
  QCOMPARE(payload.value(QStringLiteral("total")).toInteger(), 100);
  QCOMPARE(payload.value(QStringLiteral("offset")).toInteger(), 10);
  QCOMPARE(payload.value(QStringLiteral("next_offset")).toInteger(), 30);
  QVERIFY(payload.value(QStringLiteral("truncated")).toBool());

  request.offset = 100;
  QJsonObject past{{QStringLiteral("content"), QString(100, QLatin1Char('a'))}};
  QVERIFY(pageRead(past, request).contains(QStringLiteral("100 characters")));
}

void BrowserViewsTests::read_holdsACurrentExtensionToTheRequest() {
  ReadRequest request;
  request.offset = 30000;
  QJsonObject payload{{QStringLiteral("content"), QString(5, QLatin1Char('b'))},
                      {QStringLiteral("offset"), 30000},
                      {QStringLiteral("total"), 30005},
                      {QStringLiteral("scope"), QStringLiteral("page")}};
  QVERIFY(pageRead(payload, request).isEmpty());
  QVERIFY(!payload.contains(QStringLiteral("next_offset")));
  QVERIFY(!payload.value(QStringLiteral("truncated")).toBool());

  QJsonObject wrong{{QStringLiteral("content"), QString()},
                    {QStringLiteral("offset"), 0},
                    {QStringLiteral("total"), 10}};
  QVERIFY(pageRead(wrong, request).contains(QStringLiteral("different part")));
}

void BrowserViewsTests::read_refusesAScopedReadAnOlderExtensionIgnored() {
  ReadRequest request;
  request.scoped = true;
  QJsonObject payload{
      {QStringLiteral("content"), QStringLiteral("whole page")}};
  QVERIFY(pageRead(payload, request)
              .contains(QStringLiteral("chrome://extensions")));
}

void BrowserViewsTests::session_findInstallsRefsAClickCanUse() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto find = session.beginCommand(
      QStringLiteral("browser_find"),
      QJsonObject{{QStringLiteral("text"), QStringLiteral("Send message")}});
  QVERIFY2(find.ok, qPrintable(find.error));
  QCOMPARE(find.frame.value(QStringLiteral("cmd")).toString(),
           QStringLiteral("snapshot"));
  const auto in =
      session.onReply(frame(find.frame.value(QStringLiteral("id")).toString(),
                            QStringLiteral("snapshot"), messagesPage()));
  QVERIFY(!in.is_error);
  QVERIFY(in.text.startsWith(QStringLiteral(
      "url: https://a.test/\ntitle: A\ntab_id: 7\nFound 2 matches")));
  const QString ref =
      refOf(in.text, QStringLiteral("- button \"Send message\""));
  const auto click =
      session.beginCommand(QStringLiteral("browser_click"),
                           QJsonObject{{QStringLiteral("ref"), ref}});
  QVERIFY2(click.ok, qPrintable(click.error));
  QCOMPARE(click.frame.value(QStringLiteral("backendNodeId")).toInt(), 4);
  QCOMPARE(click.frame.value(QStringLiteral("tab_id")).toInt(), kTab);

  BrowserBridgeSession refused;
  refused.onHostConnected();
  QVERIFY(
      !refused.beginCommand(QStringLiteral("browser_find"), QJsonObject{}).ok);
}

void BrowserViewsTests::session_snapshotOptionsAndReadPaging() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto snap = session.beginCommand(
      QStringLiteral("browser_snapshot"),
      QJsonObject{{QStringLiteral("filter"), QStringLiteral("interactive")}});
  QVERIFY(snap.ok);
  const auto in =
      session.onReply(frame(snap.frame.value(QStringLiteral("id")).toString(),
                            QStringLiteral("snapshot"), messagesPage()));
  QVERIFY(!in.is_error);
  QVERIFY(in.text.contains(
      QRegularExpression(QStringLiteral("\nshown: \\d+ of \\d+ lines\n"))));

  const auto read =
      session.beginCommand(QStringLiteral("browser_read"),
                           QJsonObject{{QStringLiteral("max_chars"), 4},
                                       {QStringLiteral("offset"), 2}});
  QVERIFY(read.ok);
  QCOMPARE(read.frame.value(QStringLiteral("max_chars")).toInt(), 4);
  QCOMPARE(read.frame.value(QStringLiteral("offset")).toInt(), 2);
  const auto page = session.onReply(frame(
      read.frame.value(QStringLiteral("id")).toString(), QStringLiteral("read"),
      QJsonObject{{QStringLiteral("format"), QStringLiteral("text")},
                  {QStringLiteral("content"), QStringLiteral("abcdefghij")},
                  {QStringLiteral("truncated"), false}}));
  QVERIFY(!page.is_error);
  const QJsonObject json = QJsonDocument::fromJson(page.text.toUtf8()).object();
  QCOMPARE(json.value(QStringLiteral("content")).toString(),
           QStringLiteral("cdef"));
  QCOMPARE(json.value(QStringLiteral("next_offset")).toInteger(), 6);
  QCOMPARE(json.value(QStringLiteral("total")).toInteger(), 10);
}

void BrowserViewsTests::session_aRefusedViewStillInstallsTheCapture() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto snap = session.beginCommand(
      QStringLiteral("browser_snapshot"),
      QJsonObject{{QStringLiteral("filter"), QStringLiteral("viewport")}});
  QVERIFY(snap.ok);
  const auto in =
      session.onReply(frame(snap.frame.value(QStringLiteral("id")).toString(),
                            QStringLiteral("snapshot"), messagesPage(false)));
  QVERIFY(in.is_error);
  QVERIFY(in.error.contains(QStringLiteral("chrome://extensions")));
  // The capture is still the tab's: its refs act.
  const auto click = session.beginCommand(
      QStringLiteral("browser_click"),
      QJsonObject{{QStringLiteral("ref"), QStringLiteral("e3")}});
  QVERIFY2(click.ok, qPrintable(click.error));
}

QTEST_MAIN(BrowserViewsTests)
#include "test_browser_views.moc"
