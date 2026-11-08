// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_contract.h"

#include <QHash>
#include <QMap>
#include <QRegularExpression>
#include <QSet>
#include <QStringList>
#include <QVector>

#include <algorithm>
#include <limits>
#include <numeric>
#include <optional>
#include <utility>

namespace chrome_control_mcp::browser {

namespace {

// -- Snapshot rendering ------------------------------------------------------

// Cap element names so one absurdly long label cannot blow up the outline the
// model has to read; keep it ASCII (no ellipsis glyph) per the repo text rule.
constexpr int kMaxNameChars = 120;
// Guard against a hostile/broken capture reporting a huge depth and producing a
// megabyte of leading spaces.
constexpr int kMaxIndentDepth = 20;
// Cap how many nodes we render. The whole capture is an untrusted,
// web-page-derived payload; without this a hostile page reporting millions of
// nodes would blow up the outline string + ref_index held in the long-lived
// process and overflow next_ref.
constexpr int kMaxNodes = 4000;
// Bound the total nodes SCANNED, not just emitted: a hostile capture can pad
// the array with millions of invisible/zero-area nodes that never emit (so the
// emitted cap never trips) yet still force O(N) work. Stop scanning past this
// and mark the outline truncated. Comfortably larger than any real DOM (a huge
// page is tens of thousands of nodes).
constexpr int kMaxScanNodes = 100'000;
// Cap the page-controlled url/title that head the snapshot text.
constexpr int kMaxUrlChars = 2048;
constexpr int kMaxTitleChars = 300;
// Largest backendNodeId still exactly representable as a double; a larger value
// cannot be an exact integer id and is rejected.
constexpr double kMaxExactIntegerDouble = 9.0e15;
// Cap the page-derived input/slider value string rendered into the outline.
constexpr int kMaxValueChars = 60;
// Spaces of indentation rendered per outline depth level.
constexpr int kSpacesPerIndentLevel = 2;
// The most lines a find returns, and the longest text, pattern or role it
// takes.
constexpr int kMaxFindResults = 20;
constexpr int kMaxFindTextChars = 200;
constexpr int kMaxFindRoleChars = 40;
// How many containers a find result names as its context, and how many near
// names a find with no match suggests.
constexpr int kFindContextAncestors = 3;
constexpr qsizetype kClosestNames = 3;
// Find scores, by what kind of match a name made; higher ranks first.
constexpr int kScoreExact = 100;
constexpr int kScorePrefix = 80;
constexpr int kScoreWord = 60;
constexpr int kScoreRegex = 50;
constexpr int kScoreSubstring = 40;
constexpr int kScoreOverlapBase = 20;
constexpr int kScoreOverlapSpan = 20;
constexpr int kScoreValue = 15;
constexpr int kScoreRoleOnly = 10;
constexpr int kBoostActionable = 5;
constexpr int kBoostOnScreen = 3;
// The shortest word a phrase compares on its own.
constexpr qsizetype kMinOverlapWordChars = 2;
// browser_snapshot's option bounds.
constexpr int kMaxOutlineDepth = 50;
constexpr int kMinOutlineChars = 1000;
constexpr int kMaxOutlineChars = 2'000'000;
// browser_read's page: the most one page holds, and the longest selector.
constexpr qint64 kMaxReadChars = 200'000;
constexpr qsizetype kMaxSelectorChars = 1000;

// Collapse to a single line and length-cap an untrusted string. simplified()
// strips newlines/tabs, which is what stops a hostile role/title/url from
// forging extra outline lines or fake [ref=...] entries in the model-facing
// text.
QString oneLine(const QString &raw, int cap) {
  QString value = raw.simplified();
  if (value.size() > cap) {
    value = value.left(cap) + QLatin1String("...");
  }
  return value;
}

QString escapeName(const QString &raw) {
  QString name = raw.simplified(); // collapse internal whitespace + trim
  name.replace(QLatin1Char('\\'), QLatin1String("\\\\"));
  name.replace(QLatin1Char('"'), QLatin1String("\\\""));
  if (name.size() > kMaxNameChars) {
    name = name.left(kMaxNameChars) + QLatin1String("...");
  }
  return name;
}

// A backendNodeId is only usable if it is a positive JSON integer. A hostile
// capture could report it as a string/object/array/float to smuggle a
// non-integer into the CDP command envelope; such a node gets no ref (it cannot
// be acted on).
bool asBackendId(const QJsonValue &value, qint64 *out) {
  if (!value.isDouble()) {
    return false;
  }
  const double raw = value.toDouble();
  if (raw < 1.0 ||
      raw > kMaxExactIntegerDouble) { // stay within exact-integer double range
    return false;
  }
  const auto id = static_cast<qint64>(raw);
  if (static_cast<double>(id) != raw) { // reject non-integral values
    return false;
  }
  *out = id;
  return true;
}

// The number in a ref name ("e29" -> 29), or 0 for anything not shaped
// e<digits>. Only ever applied to names this module issued, but parsed rather
// than assumed so a malformed carried index lowers nothing.
qint64 refNumber(const QString &ref) {
  if (!ref.startsWith(QLatin1Char('e'))) {
    return 0;
  }
  bool ok = false;
  const qint64 number = ref.mid(1).toLongLong(&ok);
  return ok && number > 0 ? number : 0;
}

// An interactable role we still show even with no accessible name, because the
// model may need to act on it (e.g. an icon-only button).
bool roleIsStructuralNoise(const QString &role) {
  return role.isEmpty() || role == QLatin1String("generic") ||
         role == QLatin1String("none") ||
         role == QLatin1String("presentation") ||
         role == QLatin1String("inlinetextbox");
}

// The landmark roles: the regions a page declares for its parts. They head a
// find result's context, survive every snapshot filter and elision, and carry
// refs so one region can be snapshotted on its own.
bool roleIsLandmark(const QString &role) {
  static const QSet<QString> kLandmarks{
      QStringLiteral("banner"),      QStringLiteral("complementary"),
      QStringLiteral("contentinfo"), QStringLiteral("form"),
      QStringLiteral("main"),        QStringLiteral("navigation"),
      QStringLiteral("region"),      QStringLiteral("search")};
  return kLandmarks.contains(role);
}

// A container worth naming: a landmark, or a dialog, table, list, feed or
// article -- something an agent may read on its own with browser_snapshot's
// ref, or want to know a match sits inside. These carry refs.
bool roleIsContainer(const QString &role) {
  static const QSet<QString> kContainers{
      QStringLiteral("alertdialog"), QStringLiteral("article"),
      QStringLiteral("dialog"),      QStringLiteral("feed"),
      QStringLiteral("grid"),        QStringLiteral("list"),
      QStringLiteral("table"),       QStringLiteral("tree"),
      QStringLiteral("treegrid")};
  return roleIsLandmark(role) || kContainers.contains(role);
}

// The containers a find result names as where a match sits: lists are left
// out, being too common to say anything.
bool roleIsContext(const QString &role) {
  return roleIsContainer(role) && role != QLatin1String("list") &&
         role != QLatin1String("tree");
}

bool roleIsHeading(const QString &role) {
  return role == QLatin1String("heading");
}

// A file input the page hides on purpose. The extension collects these straight
// from the DOM and marks them, because the pattern is universal -- the real
// `<input type="file">` is set to display:none and a styled button is put in
// front of it -- and an element with no box would otherwise be dropped here,
// leaving browser_upload nothing to name on any ordinary page. Kept for NAMING
// only: it carries no bounds, and every coordinate path needs bounds, so
// nothing can compute a click point from one.
bool nodeIsHiddenFileInput(const QJsonObject &node) {
  return node.value(QStringLiteral("hidden_input")).toBool(false) &&
         node.value(QStringLiteral("role")).toString() ==
             QLatin1String("filechooser");
}

// Drop invisible nodes, zero-area nodes, and unnamed structural filler. A node
// with no bounds object is kept (the extension may omit bounds for virtualized
// content); only an explicit zero/negative size is treated as not rendered.
bool nodeIsRenderable(const QJsonObject &node, bool interactable,
                      const QString &name) {
  if (nodeIsHiddenFileInput(node)) {
    return true;
  }
  if (!node.value(QStringLiteral("visible")).toBool(true)) {
    return false;
  }
  if (node.contains(QStringLiteral("bounds"))) {
    const QJsonObject bounds = node.value(QStringLiteral("bounds")).toObject();
    if (bounds.value(QStringLiteral("width")).toInt() <= 0 ||
        bounds.value(QStringLiteral("height")).toInt() <= 0) {
      return false;
    }
  }
  if (!interactable && name.isEmpty() &&
      roleIsStructuralNoise(node.value(QStringLiteral("role")).toString())) {
    return false;
  }
  return true;
}

// A node gets an actionable [ref] if it is interactable, if it is a container
// worth reading on its own (roleIsContainer), OR if it exposes an
// inspectable value
// -- a progress bar, meter, output, or any value/range-bearing node. Without
// this, a read-only display (e.g. a <progress> or role=progressbar) has no ref,
// so browser_get_value / get_attribute / box cannot target it even though the
// model may need to read it.
bool nodeIsRefWorthy(const QJsonObject &node, bool interactable) {
  if (interactable || node.contains(QStringLiteral("value")) ||
      roleIsContainer(node.value(QStringLiteral("role")).toString())) {
    return true;
  }
  return node.contains(QStringLiteral("valuemin")) &&
         node.contains(QStringLiteral("valuemax"));
}

// Append the current value + range for inputs/sliders. The value is
// page-derived, so it is collapsed to one line and stripped of the paren/comma
// delimiters that could otherwise forge extra state flags in the outline.
void appendValueFlags(const QJsonObject &node, QStringList &flags) {
  if (node.contains(QStringLiteral("value"))) {
    QString value =
        oneLine(node.value(QStringLiteral("value")).toString(), kMaxValueChars);
    value.remove(QLatin1Char('('))
        .remove(QLatin1Char(')'))
        .remove(QLatin1Char(','));
    if (!value.isEmpty()) {
      flags << QStringLiteral("value=") + value;
    }
  }
  if (node.contains(QStringLiteral("valuemin")) &&
      node.contains(QStringLiteral("valuemax"))) {
    flags << QStringLiteral("range %1..%2")
                 .arg(node.value(QStringLiteral("valuemin")).toDouble())
                 .arg(node.value(QStringLiteral("valuemax")).toDouble());
  }
}

QString stateSuffix(const QJsonObject &node) {
  QStringList flags;
  // Tri-state flags rendered as one of two labels when present.
  struct TriFlag {
    const char *m_key;
    const char *m_on;
    const char *m_off;
  };
  static const TriFlag kTri[] = {{"checked", "checked", "unchecked"},
                                 {"expanded", "expanded", "collapsed"}};
  for (const auto &t : kTri) {
    if (node.contains(QLatin1String(t.m_key))) {
      flags << QLatin1String(
          node.value(QLatin1String(t.m_key)).toBool() ? t.m_on : t.m_off);
    }
  }
  // Simple boolean flags whose label is the key.
  static const char *const kBools[] = {"editable", "disabled", "selected",
                                       "pressed",  "readonly", "required",
                                       "invalid",  "busy"};
  for (const char *key : kBools) {
    if (node.value(QLatin1String(key)).toBool()) {
      flags << QLatin1String(key);
    }
  }
  // Say when a control is on the page but not shown, so a model reading the
  // outline knows why it never saw this one on a screenshot -- and does not try
  // to click something that has no place on screen. Only file inputs reach the
  // outline this way; see nodeIsHiddenFileInput.
  if (node.value(QStringLiteral("hidden_input")).toBool(false)) {
    flags << QStringLiteral("hidden");
  }
  if (node.value(QStringLiteral("multiple")).toBool(false)) {
    flags << QStringLiteral("multiple");
  }
  // Why a node whose role says "generic" carries a ref at all: the page wired
  // it to the pointer itself. The value is matched against a fixed set rather
  // than rendered -- it reaches here from a page-controlled capture, and
  // everything else in this line is escaped for exactly that reason.
  const QString wired = node.value(QStringLiteral("wired")).toString();
  if (wired == QLatin1String("click")) {
    flags << QStringLiteral("clickable");
  } else if (wired == QLatin1String("hover")) {
    flags << QStringLiteral("hoverable");
  } else if (wired == QLatin1String("pointer")) {
    flags << QStringLiteral("pointer");
  }
  appendValueFlags(node, flags);
  return flags.isEmpty() ? QString()
                         : QStringLiteral("(") + flags.join(QLatin1Char(',')) +
                               QStringLiteral(")");
}

// -- Command translation -----------------------------------------------------

struct ArgSpec {
  QString m_key;
  QString m_type; // "string" | "int" | "number" | "bool"
  bool m_required{false};
};

struct CmdSpec {
  QString m_cmd;
  QString m_ref_mode; // "none" | "optional" | "required"
  QVector<ArgSpec> m_args;
};

// Navigation, read, and element-interaction command specs.
QHash<QString, CmdSpec> interactionCommandSpecs() {
  return {
      {QStringLiteral("browser_navigate"),
       {QStringLiteral("navigate"),
        QStringLiteral("none"),
        {{QStringLiteral("url"), QStringLiteral("string"), true}}}},
      {QStringLiteral("browser_snapshot"),
       {QStringLiteral("snapshot"),
        QStringLiteral("optional"),
        {{QStringLiteral("depth"), QStringLiteral("int"), false},
         {QStringLiteral("filter"), QStringLiteral("string"), false},
         {QStringLiteral("max_chars"), QStringLiteral("int"), false}}}},
      // A find takes the same capture as a snapshot; its arguments travel
      // with the command and are read back here when the reply arrives.
      {QStringLiteral("browser_find"),
       {QStringLiteral("snapshot"),
        QStringLiteral("none"),
        {{QStringLiteral("text"), QStringLiteral("string"), false},
         {QStringLiteral("query"), QStringLiteral("string"), false},
         {QStringLiteral("regex"), QStringLiteral("string"), false},
         {QStringLiteral("role"), QStringLiteral("string"), false},
         {QStringLiteral("max_results"), QStringLiteral("int"), false}}}},
      {QStringLiteral("browser_click"),
       {QStringLiteral("click"),
        QStringLiteral("required"),
        {{QStringLiteral("button"), QStringLiteral("string"), false},
         {QStringLiteral("click_count"), QStringLiteral("int"), false},
         {QStringLiteral("modifiers"), QStringLiteral("string"), false}}}},
      {QStringLiteral("browser_hover"),
       {QStringLiteral("hover"),
        QStringLiteral("optional"),
        {{QStringLiteral("x"), QStringLiteral("number"), false},
         {QStringLiteral("y"), QStringLiteral("number"), false},
         {QStringLiteral("duration_ms"), QStringLiteral("int"), false},
         {QStringLiteral("modifiers"), QStringLiteral("string"), false}}}},
      {QStringLiteral("browser_drag"),
       {QStringLiteral("drag"),
        QStringLiteral("optional"),
        {{QStringLiteral("from_x"), QStringLiteral("number"), false},
         {QStringLiteral("from_y"), QStringLiteral("number"), false},
         {QStringLiteral("to_x"), QStringLiteral("number"), false},
         {QStringLiteral("to_y"), QStringLiteral("number"), false},
         {QStringLiteral("steps"), QStringLiteral("int"), false},
         {QStringLiteral("hold_ms"), QStringLiteral("int"), false}}}},
      {QStringLiteral("browser_type"),
       {QStringLiteral("type"),
        QStringLiteral("required"),
        {{QStringLiteral("text"), QStringLiteral("string"), true},
         {QStringLiteral("submit"), QStringLiteral("bool"), false}}}},
      {QStringLiteral("browser_press_key"),
       {QStringLiteral("pressKey"),
        QStringLiteral("none"),
        {{QStringLiteral("keys"), QStringLiteral("string"), true}}}},
      {QStringLiteral("browser_scroll"),
       {QStringLiteral("scroll"),
        QStringLiteral("optional"),
        {{QStringLiteral("direction"), QStringLiteral("string"), false},
         {QStringLiteral("amount"), QStringLiteral("int"), false}}}},
      {QStringLiteral("browser_click_at"),
       {QStringLiteral("clickAt"),
        QStringLiteral("none"),
        {{QStringLiteral("x"), QStringLiteral("number"), true},
         {QStringLiteral("y"), QStringLiteral("number"), true},
         {QStringLiteral("button"), QStringLiteral("string"), false},
         {QStringLiteral("click_count"), QStringLiteral("int"), false},
         {QStringLiteral("modifiers"), QStringLiteral("string"), false}}}},
      {QStringLiteral("browser_dialog"),
       {QStringLiteral("dialog"),
        QStringLiteral("none"),
        {{QStringLiteral("action"), QStringLiteral("string"), false},
         {QStringLiteral("text"), QStringLiteral("string"), false}}}},
  };
}

// Form-control command specs (dropdown, value-set, media).
QHash<QString, CmdSpec> formCommandSpecs() {
  return {
      {QStringLiteral("browser_select"),
       {QStringLiteral("select"),
        QStringLiteral("required"),
        {{QStringLiteral("value"), QStringLiteral("string"), false},
         {QStringLiteral("label"), QStringLiteral("string"), false},
         {QStringLiteral("index"), QStringLiteral("int"), false}}}},
      {QStringLiteral("browser_set_value"),
       {QStringLiteral("setValue"),
        QStringLiteral("required"),
        {{QStringLiteral("value"), QStringLiteral("string"), false},
         {QStringLiteral("checked"), QStringLiteral("bool"), false}}}},
      {QStringLiteral("browser_media"),
       {QStringLiteral("media"),
        QStringLiteral("required"),
        {{QStringLiteral("action"), QStringLiteral("string"), true},
         {QStringLiteral("value"), QStringLiteral("string"), false}}}},
      // The paths stay on this side: the app reads the files and sends their
      // bytes, so the command that reaches the extension names an element (or
      // none) and the files delivered for it, never a location on the user's
      // disk. The ref is optional because a page that opens its own file
      // chooser -- the usual case, behind a styled button -- has already said
      // which input it wants: the extension intercepts that chooser rather
      // than showing a dialog, and an upload with no ref fills it.
      {QStringLiteral("browser_upload"),
       {QStringLiteral("upload"), QStringLiteral("optional"), {}}},
      // The calling agent's own clipboard. Files, like browser_upload's, are
      // read here and sent as bytes, so `paths` is validated but never copied
      // into the command. The ref is what copy and cut take and what paste
      // pastes into; the other actions refuse one (applyClipboardArgs).
      {QStringLiteral("browser_clipboard"),
       {QStringLiteral("clipboard"),
        QStringLiteral("optional"),
        {{QStringLiteral("action"), QStringLiteral("string"), true},
         {QStringLiteral("text"), QStringLiteral("string"), false},
         {QStringLiteral("html"), QStringLiteral("string"), false},
         {QStringLiteral("plain"), QStringLiteral("bool"), false}}}},
  };
}

// History, read/screenshot, and tab/tab-group command specs.
QHash<QString, CmdSpec> pageAndTabCommandSpecs() {
  return {
      {QStringLiteral("browser_back"),
       {QStringLiteral("back"), QStringLiteral("none"), {}}},
      {QStringLiteral("browser_forward"),
       {QStringLiteral("forward"), QStringLiteral("none"), {}}},
      {QStringLiteral("browser_reload"),
       {QStringLiteral("reload"), QStringLiteral("none"), {}}},
      {QStringLiteral("browser_read"),
       {QStringLiteral("read"),
        QStringLiteral("optional"),
        {{QStringLiteral("format"), QStringLiteral("string"), false},
         {QStringLiteral("offset"), QStringLiteral("int"), false},
         {QStringLiteral("max_chars"), QStringLiteral("int"), false},
         {QStringLiteral("selector"), QStringLiteral("string"), false},
         {QStringLiteral("mode"), QStringLiteral("string"), false}}}},
      {QStringLiteral("browser_screenshot"),
       {QStringLiteral("screenshot"),
        QStringLiteral("optional"),
        {{QStringLiteral("full_page"), QStringLiteral("bool"), false},
         {QStringLiteral("include_control_overlay"), QStringLiteral("bool"),
          false},
         {QStringLiteral("purpose"), QStringLiteral("string"), false},
         {QStringLiteral("x"), QStringLiteral("int"), false},
         {QStringLiteral("y"), QStringLiteral("int"), false},
         {QStringLiteral("width"), QStringLiteral("int"), false},
         {QStringLiteral("height"), QStringLiteral("int"), false}}}},
      {QStringLiteral("browser_tabs"),
       {QStringLiteral("listTabs"), QStringLiteral("none"), {}}},
      {QStringLiteral("browser_console"),
       {QStringLiteral("console"),
        QStringLiteral("none"),
        {{QStringLiteral("level"), QStringLiteral("string"), false},
         {QStringLiteral("limit"), QStringLiteral("int"), false},
         {QStringLiteral("clear"), QStringLiteral("bool"), false}}}},
      {QStringLiteral("browser_network"),
       {QStringLiteral("network"),
        QStringLiteral("none"),
        {{QStringLiteral("failed_only"), QStringLiteral("bool"), false},
         {QStringLiteral("limit"), QStringLiteral("int"), false},
         {QStringLiteral("clear"), QStringLiteral("bool"), false}}}},
      // index is optional only because tab_id is the other way to name the
      // tab; exactly one of the two is enforced in applyToolExtras.
      {QStringLiteral("browser_select_tab"),
       {QStringLiteral("selectTab"),
        QStringLiteral("none"),
        {{QStringLiteral("index"), QStringLiteral("int"), false}}}},
      {QStringLiteral("browser_new_tab"),
       {QStringLiteral("newTab"),
        QStringLiteral("none"),
        {{QStringLiteral("url"), QStringLiteral("string"), false}}}},
      {QStringLiteral("browser_close_tab"),
       {QStringLiteral("closeTab"),
        QStringLiteral("none"),
        {{QStringLiteral("index"), QStringLiteral("int"), false}}}},
      {QStringLiteral("browser_group_tabs"),
       {QStringLiteral("groupTabs"),
        QStringLiteral("none"),
        {{QStringLiteral("tab_indices"), QStringLiteral("string"), false},
         {QStringLiteral("title"), QStringLiteral("string"), false},
         {QStringLiteral("color"), QStringLiteral("string"), false}}}},
      {QStringLiteral("browser_ungroup_tabs"),
       {QStringLiteral("ungroupTabs"),
        QStringLiteral("none"),
        {{QStringLiteral("tab_indices"), QStringLiteral("string"), false}}}},
      // Ending a task. Its tab_id is not in this list: it is added the way
      // every tab-scoped tool's is (acceptsTabId), so it is validated by the
      // same rule, but release is not tab-scoped -- without one it lets go of
      // every tab the session holds.
      {QStringLiteral("browser_release"),
       {QStringLiteral("release"),
        QStringLiteral("none"),
        {{QStringLiteral("keep_open"), QStringLiteral("bool"), false}}}},
  };
}

// Read-only inspection + robustness command specs (no page mutation).
QHash<QString, CmdSpec> inspectionCommandSpecs() {
  return {
      {QStringLiteral("browser_wait_for"),
       {QStringLiteral("waitFor"),
        QStringLiteral("none"),
        {{QStringLiteral("text"), QStringLiteral("string"), false},
         {QStringLiteral("url_contains"), QStringLiteral("string"), false},
         {QStringLiteral("selector"), QStringLiteral("string"), false},
         {QStringLiteral("network_idle"), QStringLiteral("bool"), false},
         {QStringLiteral("idle_ms"), QStringLiteral("int"), false},
         {QStringLiteral("absent"), QStringLiteral("bool"), false},
         {QStringLiteral("timeout_ms"), QStringLiteral("int"), false}}}},
      {QStringLiteral("browser_get_value"),
       {QStringLiteral("getValue"), QStringLiteral("required"), {}}},
      {QStringLiteral("browser_get_attribute"),
       {QStringLiteral("getAttribute"),
        QStringLiteral("required"),
        {{QStringLiteral("name"), QStringLiteral("string"), false}}}},
      {QStringLiteral("browser_box"),
       {QStringLiteral("box"), QStringLiteral("required"), {}}},
      {QStringLiteral("browser_focus"),
       {QStringLiteral("focus"), QStringLiteral("required"), {}}},
      {QStringLiteral("browser_reveal"),
       {QStringLiteral("reveal"), QStringLiteral("required"), {}}},
  };
}

// Advanced (gated) input command specs.
QHash<QString, CmdSpec> advancedInputCommandSpecs() {
  return {
      {QStringLiteral("browser_js_click"),
       {QStringLiteral("jsClick"), QStringLiteral("required"), {}}},
  };
}

// Gated infrastructure command specs (Batch 4): the ones that reshape or render
// the PAGE.
QHash<QString, CmdSpec> renderingCommandSpecs() {
  return {
      {QStringLiteral("browser_emulate"),
       {QStringLiteral("emulate"),
        QStringLiteral("none"),
        {{QStringLiteral("width"), QStringLiteral("int"), false},
         {QStringLiteral("height"), QStringLiteral("int"), false},
         {QStringLiteral("device_scale_factor"), QStringLiteral("number"),
          false},
         {QStringLiteral("mobile"), QStringLiteral("bool"), false},
         {QStringLiteral("user_agent"), QStringLiteral("string"), false},
         {QStringLiteral("touch"), QStringLiteral("bool"), false},
         {QStringLiteral("reset"), QStringLiteral("bool"), false}}}},
      {QStringLiteral("browser_print"),
       {QStringLiteral("print"),
        QStringLiteral("none"),
        {{QStringLiteral("landscape"), QStringLiteral("bool"), false},
         {QStringLiteral("scale"), QStringLiteral("number"), false},
         {QStringLiteral("paper_width"), QStringLiteral("number"), false},
         {QStringLiteral("paper_height"), QStringLiteral("number"), false},
         {QStringLiteral("print_background"), QStringLiteral("bool"), false},
         {QStringLiteral("page_ranges"), QStringLiteral("string"), false}}}},
  };
}

// Gated infrastructure command specs (Batch 4): the ones that touch
// ORIGIN-SCOPED state -- permissions, storage, cookies, downloads and
// credentials. Each of these acts on whatever tab is active when it lands,
// which is why several carry an explicit origin expectation.
QHash<QString, CmdSpec> infraCommandSpecs() {
  return {
      {QStringLiteral("browser_permission"),
       {QStringLiteral("permission"),
        QStringLiteral("none"),
        {{QStringLiteral("name"), QStringLiteral("string"), true},
         {QStringLiteral("setting"), QStringLiteral("string"), true},
         {QStringLiteral("origin"), QStringLiteral("string"), false}}}},
      {QStringLiteral("browser_storage"),
       {QStringLiteral("storage"),
        QStringLiteral("none"),
        {{QStringLiteral("action"), QStringLiteral("string"), true},
         {QStringLiteral("area"), QStringLiteral("string"), false},
         {QStringLiteral("key"), QStringLiteral("string"), false},
         {QStringLiteral("value"), QStringLiteral("string"), false},
         // The origin the caller BELIEVES it is acting on. Storage is
         // per-origin, and the op targets whatever tab is active when it lands
         // -- a focus change between plan and execution silently retargets it
         // at another site. Declaring the expectation lets the extension refuse
         // instead of reading the wrong origin's storage.
         {QStringLiteral("expect_origin"), QStringLiteral("string"), false}}}},
      {QStringLiteral("browser_cookies"),
       {QStringLiteral("cookies"),
        QStringLiteral("none"),
        {{QStringLiteral("action"), QStringLiteral("string"), true},
         {QStringLiteral("url"), QStringLiteral("string"), false},
         {QStringLiteral("name"), QStringLiteral("string"), false},
         {QStringLiteral("value"), QStringLiteral("string"), false},
         {QStringLiteral("path"), QStringLiteral("string"), false},
         {QStringLiteral("secure"), QStringLiteral("bool"), false},
         {QStringLiteral("http_only"), QStringLiteral("bool"), false},
         {QStringLiteral("same_site"), QStringLiteral("string"), false},
         {QStringLiteral("expires_days"), QStringLiteral("number"), false}}}},
      {QStringLiteral("browser_download"),
       {QStringLiteral("download"),
        QStringLiteral("none"),
        {{QStringLiteral("url"), QStringLiteral("string"), true},
         {QStringLiteral("filename"), QStringLiteral("string"), false},
         {QStringLiteral("timeout_ms"), QStringLiteral("int"), false}}}},
      {QStringLiteral("browser_record_start"),
       {QStringLiteral("recordStart"),
        QStringLiteral("none"),
        {{QStringLiteral("filename"), QStringLiteral("string"), false},
         {QStringLiteral("resolution"), QStringLiteral("string"), false}}}},
      {QStringLiteral("browser_record_stop"),
       {QStringLiteral("recordStop"), QStringLiteral("none"), {}}},
      {QStringLiteral("browser_http_auth"),
       {QStringLiteral("httpAuth"),
        QStringLiteral("none"),
        {{QStringLiteral("username"), QStringLiteral("string"), false},
         {QStringLiteral("password"), QStringLiteral("string"), false},
         {QStringLiteral("clear"), QStringLiteral("bool"), false},
         // Credentials are armed against whichever tab is active at execution
         // time. A popup or focus change between the operator's decision and
         // this call would arm them for an attacker's origin, and the later
         // same-origin check would then validate against that wrong origin.
         // Naming the intended origin is what makes the arming refusable.
         {QStringLiteral("origin"), QStringLiteral("string"), false}}}},
  };
}

// Browser-window (chrome.windows) command specs.
QHash<QString, CmdSpec> windowCommandSpecs() {
  return {
      {QStringLiteral("browser_windows"),
       {QStringLiteral("listWindows"), QStringLiteral("none"), {}}},
      {QStringLiteral("browser_window"),
       {QStringLiteral("window"),
        QStringLiteral("none"),
        {{QStringLiteral("action"), QStringLiteral("string"), true},
         {QStringLiteral("window_id"), QStringLiteral("int"), false},
         {QStringLiteral("url"), QStringLiteral("string"), false}}}},
  };
}

const QHash<QString, CmdSpec> &commandSpecs() {
  static const QHash<QString, CmdSpec> kSpecs = [] {
    QHash<QString, CmdSpec> merged = interactionCommandSpecs();
    merged.insert(formCommandSpecs());
    merged.insert(pageAndTabCommandSpecs());
    merged.insert(inspectionCommandSpecs());
    merged.insert(advancedInputCommandSpecs());
    merged.insert(windowCommandSpecs());
    merged.insert(renderingCommandSpecs());
    merged.insert(infraCommandSpecs());
    return merged;
  }();
  return kSpecs;
}

// The commands that act on exactly one tab. Each takes an optional tab_id so a
// caller can name its own tab instead of riding the session's current one --
// which is shared by every agent on this server, so without it one agent
// opening a tab silently retargets the next call of every other. Kept as one
// list of extension commands, not of tools, so the schema property, the
// allowed-argument set and the frame field all follow from it together.
const QSet<QString> &tabScopedCommands() {
  static const QSet<QString> kCommands{
      QStringLiteral("snapshot"),     QStringLiteral("read"),
      QStringLiteral("navigate"),     QStringLiteral("back"),
      QStringLiteral("forward"),      QStringLiteral("reload"),
      QStringLiteral("click"),        QStringLiteral("clickAt"),
      QStringLiteral("hover"),        QStringLiteral("drag"),
      QStringLiteral("dialog"),       QStringLiteral("type"),
      QStringLiteral("select"),       QStringLiteral("setValue"),
      QStringLiteral("media"),        QStringLiteral("pressKey"),
      QStringLiteral("scroll"),       QStringLiteral("screenshot"),
      QStringLiteral("waitFor"),      QStringLiteral("console"),
      QStringLiteral("network"),      QStringLiteral("getValue"),
      QStringLiteral("getAttribute"), QStringLiteral("box"),
      QStringLiteral("focus"),        QStringLiteral("reveal"),
      QStringLiteral("jsClick"),      QStringLiteral("emulate"),
      QStringLiteral("print"),        QStringLiteral("storage"),
      QStringLiteral("download"),     QStringLiteral("recordStart"),
      QStringLiteral("httpAuth"),     QStringLiteral("upload"),
      QStringLiteral("closeTab"),     QStringLiteral("selectTab"),
      QStringLiteral("clipboard"),
  };
  return kCommands;
}

// Every tab-scoped command takes tab_id, and so does release, which uses it to
// let go of one tab rather than all of them.
bool acceptsTabId(const QString &cmd) {
  return commandIsTabScoped(cmd) || cmd == QLatin1String("release");
}

// The tab_id argument, validated exactly like any other int argument (type,
// int32 range) plus the positive check in argSemanticError.
const ArgSpec &tabIdArgSpec() {
  static const ArgSpec kSpec{QStringLiteral("tab_id"), QStringLiteral("int"),
                             false};
  return kSpec;
}

// Send the command to the tab @p ref's snapshot came from. A ref names a node
// in ONE document; the same backendNodeId on another tab is another node, so a
// ref acted on anywhere but its own tab is a silent wrong target. The binding
// therefore decides the tab, and a tab_id the caller also passed must agree:
// when they disagree neither is the safe one to pick, so the call is refused
// naming both. An entry with no tabId at all is unbound (an index built
// without bindings) and adds nothing. Empty on success.
QString bindRefTab(const QString &ref, const QJsonObject &entry,
                   QJsonObject &command) {
  if (!entry.contains(QStringLiteral("tabId"))) {
    return QString();
  }
  qint64 ref_tab = 0;
  if (!tabIdFromJson(entry.value(QStringLiteral("tabId")), &ref_tab)) {
    return QStringLiteral("Element ref '%1' is not bound to a valid tab; call "
                          "browser_snapshot to refresh")
        .arg(ref);
  }
  const QJsonValue asked = command.value(QStringLiteral("tab_id"));
  if (asked.isUndefined()) {
    command.insert(QStringLiteral("tab_id"), ref_tab);
    return QString();
  }
  if (asked.toInteger() != ref_tab) {
    return QStringLiteral(
               "Element ref '%1' belongs to tab %2, but tab_id %3 was passed. "
               "A ref acts only on the tab its snapshot came from: drop "
               "tab_id, or call browser_snapshot with tab_id %3 for that "
               "tab's refs.")
        .arg(ref)
        .arg(ref_tab)
        .arg(asked.toInteger());
  }
  return QString();
}

// Resolve an optional/required `ref` argument to a backendNodeId via the
// current snapshot index. Returns an error string (empty on success) and, on
// success with a present ref, writes backendNodeId -- and the tab_id the ref
// is bound to -- into `command`.
QString resolveRef(const QJsonObject &args, const QJsonObject &ref_index,
                   bool required, QJsonObject &command) {
  const QJsonValue ref_value = args.value(QStringLiteral("ref"));
  // A wrong-typed ref (e.g. a JSON number) must be REJECTED, not silently
  // coerced: toString() on a non-string yields "" which would otherwise look
  // like an absent ref and slip past a required check, or drop an optional ref
  // the caller actually supplied.
  if (args.contains(QStringLiteral("ref")) && !ref_value.isString()) {
    return QStringLiteral("ref must be a string");
  }
  const QString ref = ref_value.toString();
  if (ref.isEmpty()) {
    return required ? QStringLiteral("ref is required") : QString();
  }
  if (!ref_index.contains(ref)) {
    return QStringLiteral(
               "Unknown element ref '%1'; call browser_snapshot to refresh")
        .arg(ref);
  }
  const QJsonObject entry = ref_index.value(ref).toObject();
  QString unbound = bindRefTab(ref, entry, command);
  if (!unbound.isEmpty()) {
    return unbound;
  }
  command.insert(QStringLiteral("backendNodeId"),
                 entry.value(QStringLiteral("backendNodeId")));
  return QString();
}

// A JSON number is a valid "int" argument only if it is integral and within
// int32 range. A fractional (12.5) or out-of-range (1e18) value is rejected
// rather than passed to toInt(), which truncates the fraction and collapses an
// out-of-range magnitude to a real coordinate (often 0) -- exactly the
// (0,0)-click hazard the win32 side already guards against.
bool isRepresentableInt(double raw) {
  return raw >= static_cast<double>(std::numeric_limits<int>::min()) &&
         raw <= static_cast<double>(std::numeric_limits<int>::max()) &&
         static_cast<double>(static_cast<int>(raw)) == raw;
}

// Empty on a type match, else an error naming the expected JSON type. A
// wrong-typed value (e.g. a string where an int is required) is rejected rather
// than coerced: silent coercion would turn a malformed "x":"abc" into a real
// (0,0) command instead of surfacing the error.
QString argTypeMismatch(const QString &key, const QString &type,
                        const QJsonValue &value) {
  if (type == QLatin1String("int")) {
    if (!value.isDouble()) {
      return QStringLiteral("%1 must be a number").arg(key);
    }
    return isRepresentableInt(value.toDouble())
               ? QString()
               : QStringLiteral("%1 must be an integer within range").arg(key);
  }
  if (type == QLatin1String("number")) {
    return value.isDouble() ? QString()
                            : QStringLiteral("%1 must be a number").arg(key);
  }
  if (type == QLatin1String("bool")) {
    return value.isBool() ? QString()
                          : QStringLiteral("%1 must be a boolean").arg(key);
  }
  return value.isString() ? QString()
                          : QStringLiteral("%1 must be a string").arg(key);
}

// button: matched case-insensitively against the extension's mouseButton set;
// an empty button defers to the extension's "left" default. Empty on success.
QString buttonSemanticError(const QJsonValue &value) {
  const QString button = value.toString().toLower();
  if (!button.isEmpty() && button != QLatin1String("left") &&
      button != QLatin1String("right") && button != QLatin1String("middle")) {
    return QStringLiteral("button must be left, right, or middle");
  }
  return QString();
}

// click_count: the extension's clickCountOf accepts only 1, 2, or 3. Empty on
// success.
constexpr int kMinClickCount = 1;
constexpr int kMaxClickCount = 3;
QString clickCountSemanticError(const QJsonValue &value) {
  const int count = value.toInt();
  if (count < kMinClickCount || count > kMaxClickCount) {
    return QStringLiteral("click_count must be 1, 2, or 3");
  }
  return QString();
}

// direction: trimmed and lower-cased the same way the extension's
// scrollDirection is. Empty on success.
QString directionSemanticError(const QJsonValue &value) {
  const QString direction = value.toString().trimmed().toLower();
  if (direction != QLatin1String("up") && direction != QLatin1String("down")) {
    return QStringLiteral("direction must be \"up\" or \"down\"");
  }
  return QString();
}

// Enum/range constraints for the small set of fields whose legal values the
// extension enforces downstream (background.js mouseButton / clickCountOf /
// scrollDirection). Type + int32-range are already checked; this refuses a
// well-typed but out-of-domain value -- a misspelled "rihgt" button, a
// click_count of 5, a "sideways" scroll -- at the contract boundary instead of
// letting it round-trip to the extension only to fail there. Kept in EXACT
// lockstep with the extension so nothing it accepts is rejected here: button is
// matched case-insensitively and an empty button defers to the extension's
// "left" default; direction is trimmed and lower-cased the same way. Empty on
// success or for a key that carries no modeled constraint.
// Pixels of a screenshot: never negative, and never past any image the browser
// can make (16,384 a side). A fraction is fine -- a view screenshot can be
// smaller than the device's pixels, and a zoom shows detail between them --
// but a magnitude no image has is a malformed call, refused here.
constexpr double kMaxScreenshotCoordinate = 16384;

bool isScreenshotCoordinate(const QString &key) {
  return key == QLatin1String("x") || key == QLatin1String("y") ||
         key == QLatin1String("from_x") || key == QLatin1String("from_y") ||
         key == QLatin1String("to_x") || key == QLatin1String("to_y");
}

QString argSemanticError(const QString &key, const QJsonValue &value) {
  // Chrome never issues tab id 0 or a negative one; refusing them here keeps a
  // placeholder or an off-by-one from reaching the extension as a real tab.
  if (key == QLatin1String("tab_id")) {
    return value.toInt() > 0
               ? QString()
               : QStringLiteral("tab_id must be a positive integer");
  }
  if (key == QLatin1String("button")) {
    return buttonSemanticError(value);
  }
  if (isScreenshotCoordinate(key)) {
    const double pixel = value.toDouble();
    return pixel >= 0 && pixel <= kMaxScreenshotCoordinate
               ? QString()
               : QStringLiteral("%1 must be a screenshot pixel, from 0 to %2")
                     .arg(key)
                     .arg(kMaxScreenshotCoordinate);
  }
  if (key == QLatin1String("click_count")) {
    return clickCountSemanticError(value);
  }
  if (key == QLatin1String("direction")) {
    return directionSemanticError(value);
  }
  if (key == QLatin1String("resolution")) {
    const QString resolution = value.toString();
    return resolution == QLatin1String("standard") ||
                   resolution == QLatin1String("full")
               ? QString()
               : QStringLiteral("resolution must be \"standard\" or \"full\"");
  }
  if (key == QLatin1String("purpose")) {
    const QString purpose = value.toString();
    return purpose == QLatin1String("view") ||
                   purpose == QLatin1String("presentation")
               ? QString()
               : QStringLiteral("purpose must be \"view\" or \"presentation\"");
  }
  return QString();
}

QString copyArg(const QJsonObject &args, const ArgSpec &spec,
                QJsonObject &command) {
  if (!args.contains(spec.m_key)) {
    return spec.m_required ? QStringLiteral("%1 is required").arg(spec.m_key)
                           : QString();
  }
  const QJsonValue value = args.value(spec.m_key);
  QString mismatch = argTypeMismatch(spec.m_key, spec.m_type, value);
  if (!mismatch.isEmpty()) {
    return mismatch;
  }
  QString semantic = argSemanticError(spec.m_key, value);
  if (!semantic.isEmpty()) {
    return semantic;
  }
  if (spec.m_type == QLatin1String("int")) {
    command.insert(spec.m_key, value.toInt());
  } else if (spec.m_type == QLatin1String("number")) {
    command.insert(spec.m_key, value.toDouble());
  } else if (spec.m_type == QLatin1String("bool")) {
    command.insert(spec.m_key, value.toBool());
  } else {
    command.insert(spec.m_key, value.toString());
  }
  return QString();
}

ExtensionCommand fail(const QString &reason) {
  return {QJsonObject{}, false, reason};
}

// browser_drag's second ref endpoint (to_ref). A wrong-typed to_ref is rejected
// rather than coerced to "" (which would silently drop a supplied endpoint); an
// absent one is fine.
QString applyDragExtra(const QJsonObject &arguments,
                       const QJsonObject &ref_index, QJsonObject &command) {
  const QJsonValue to_ref_value = arguments.value(QStringLiteral("to_ref"));
  if (arguments.contains(QStringLiteral("to_ref")) &&
      !to_ref_value.isString()) {
    return QStringLiteral("to_ref must be a string");
  }
  const QString to_ref = to_ref_value.toString();
  if (to_ref.isEmpty()) {
    return QString();
  }
  if (!ref_index.contains(to_ref)) {
    return QStringLiteral(
               "Unknown element ref '%1'; call browser_snapshot to refresh")
        .arg(to_ref);
  }
  const QJsonObject to_entry = ref_index.value(to_ref).toObject();
  // A drag is one pointer gesture on one page. Its two ends on two tabs is not
  // a drag anyone can perform, and sending it would press on one tab and
  // release wherever the other end's coordinates happen to fall on it. Named
  // as a cross-tab drag rather than left to bindRefTab, whose message would
  // blame a tab_id the caller never passed.
  const QString from_ref = arguments.value(QStringLiteral("ref")).toString();
  qint64 from_tab = 0;
  qint64 to_tab = 0;
  if (!from_ref.isEmpty() &&
      tabIdFromJson(
          ref_index.value(from_ref).toObject().value(QStringLiteral("tabId")),
          &from_tab) &&
      tabIdFromJson(to_entry.value(QStringLiteral("tabId")), &to_tab) &&
      from_tab != to_tab) {
    return QStringLiteral("to_ref '%1' is on tab %2 but ref '%3' is on tab "
                          "%4; a drag cannot cross tabs")
        .arg(to_ref)
        .arg(to_tab)
        .arg(from_ref)
        .arg(from_tab);
  }
  QString unbound = bindRefTab(to_ref, to_entry, command);
  if (!unbound.isEmpty()) {
    return unbound;
  }
  command.insert(QStringLiteral("to_backendNodeId"),
                 to_entry.value(QStringLiteral("backendNodeId")));
  return QString();
}

// The tools that take an `agent` name: the two that make a tab this session's,
// which is the moment the extension decides which tab group -- and so which
// colour -- the tab joins. browser_window new is left out: a window's tabs
// are grouped by the tab calls made in it.
bool takesAgentName(const QString &tool) {
  return tool == QLatin1String("browser_new_tab") ||
         tool == QLatin1String("browser_select_tab");
}

// The tools that take a `profile`: the ones that open something new, and the
// two whose state lives per profile and that name no tab -- cookies and site
// permissions. Every other call goes to the profile its tab is in.
bool takesProfile(const QString &tool) {
  return tool == QLatin1String("browser_new_tab") ||
         tool == QLatin1String("browser_window") ||
         tool == QLatin1String("browser_cookies") ||
         tool == QLatin1String("browser_permission");
}

// Longest profile a call may name: an email address at its longest.
constexpr qsizetype kMaxProfileArgChars = 254;

// Longest agent name, in characters (code points). Short because it becomes a
// tab-group title in a tab strip that has room for a word, not a sentence.
constexpr qsizetype kMaxAgentNameChars = 24;

// A character an agent name may hold. QChar::isPrint already refuses every
// Other_* category -- control and format characters (bidi overrides that
// would reorder the title), unassigned code points, and lone surrogates; line
// and paragraph separators pass that rule and still break a one-line title.
bool agentNameCharIsPrintable(char32_t point) {
  const QChar::Category category = QChar::category(point);
  return QChar::isPrint(point) && category != QChar::Separator_Line &&
         category != QChar::Separator_Paragraph;
}

// browser_new_tab / browser_select_tab's `agent`: tabs given the same name
// share one tab group with its own colour, so the user can tell agents apart.
// The only normalization is trimming the ends; anything else wrong with it -- a
// control character, a lone surrogate, nothing left, more than 24 characters
// -- is refused rather than stripped or cut, because a name changed behind
// the caller's back lands its tabs in a group it did not ask for. Copied into
// the command trimmed. Empty on success.
QString applyAgentName(const QJsonObject &arguments, QJsonObject &command) {
  if (!arguments.contains(QStringLiteral("agent"))) {
    return QString();
  }
  const QJsonValue value = arguments.value(QStringLiteral("agent"));
  if (!value.isString()) {
    return QStringLiteral("agent must be a string");
  }
  const QString name = value.toString().trimmed();
  qsizetype characters = 0;
  for (qsizetype i = 0; i < name.size(); ++i) {
    char32_t point = name.at(i).unicode();
    // A well-formed pair is one character; a half on its own falls through as
    // a surrogate code point, which is not printable and is refused.
    if (QChar::isHighSurrogate(point) && i + 1 < name.size() &&
        name.at(i + 1).isLowSurrogate()) {
      point = QChar::surrogateToUcs4(name.at(i), name.at(i + 1));
      ++i;
    }
    if (!agentNameCharIsPrintable(point)) {
      return QStringLiteral(
          "agent must contain only printable characters (no control "
          "characters)");
    }
    ++characters;
  }
  if (characters < 1 || characters > kMaxAgentNameChars) {
    return QStringLiteral("agent must be 1 to %1 characters after trimming")
        .arg(kMaxAgentNameChars);
  }
  command.insert(QStringLiteral("agent"), name);
  return QString();
}

// A profile named by a call: a string of printable characters, 1 to 254 of
// them after trimming. It is the server's to route by and never reaches the
// extension, so it is checked here and not copied into the command. Empty on
// success.
QString checkProfileArg(const QJsonObject &arguments) {
  if (!arguments.contains(QStringLiteral("profile"))) {
    return QString();
  }
  const QJsonValue value = arguments.value(QStringLiteral("profile"));
  if (!value.isString()) {
    return QStringLiteral("profile must be a string");
  }
  const QString profile = value.toString().trimmed();
  if (profile.isEmpty() || profile.size() > kMaxProfileArgChars) {
    return QStringLiteral("profile must be 1 to %1 characters after trimming")
        .arg(kMaxProfileArgChars);
  }
  if (std::any_of(profile.cbegin(), profile.cend(), [](QChar ch) {
        return !ch.isPrint() && !ch.isSurrogate();
      })) {
    return QStringLiteral("profile must contain only printable characters (no "
                          "control characters)");
  }
  return QString();
}

// Which tab browser_select_tab and browser_close_tab mean. index is positional
// (from a listing) and tab_id is stable; given both they can disagree, and
// neither may silently win on a call that retargets the session or closes a
// tab. select_tab needs exactly one -- it has no "current tab" default to fall
// back on -- and close_tab at most one, keeping "neither" as the session's own
// tab. Empty on success.
QString tabChoiceError(const QString &tool, const QJsonObject &arguments) {
  const bool by_index = arguments.contains(QStringLiteral("index"));
  const bool by_id = arguments.contains(QStringLiteral("tab_id"));
  if (tool == QLatin1String("browser_select_tab") && by_index == by_id) {
    return QStringLiteral(
        "browser_select_tab needs exactly one of index or tab_id");
  }
  if (tool == QLatin1String("browser_close_tab") && by_index && by_id) {
    return QStringLiteral("browser_close_tab takes index or tab_id, not both");
  }
  return QString();
}

// browser_select's array-valued multi-select values. A present-but-non-array
// (or an array with a non-string entry) is rejected rather than silently
// ignored, so a malformed multi-select is surfaced instead of degrading to a
// single-value select.
QString applySelectValues(const QJsonObject &arguments, QJsonObject &command) {
  if (!arguments.contains(QStringLiteral("values"))) {
    return QString();
  }
  const QJsonValue values = arguments.value(QStringLiteral("values"));
  if (!values.isArray()) {
    return QStringLiteral("values must be an array of strings");
  }
  const QJsonArray items = values.toArray();
  if (!std::ranges::all_of(
          items, [](const QJsonValue &item) { return item.isString(); })) {
    return QStringLiteral("values must be an array of strings");
  }
  command.insert(QStringLiteral("values"), values);
  return QString();
}

// browser_download's own doc-string PROMISES an http(s) url and a filename that
// is a relative name with no absolute path and no "..". The extension
// (chrome.downloads path) enforces both, but they are mirrored here so the
// contract is self-enforcing rather than trusting a downstream layer to honor
// its documented guarantee. Kept byte-for-byte in step with background.js
// handleDownload so nothing the extension would accept is refused: the url is
// tested un-trimmed against the http(s) scheme, and a filename is only
// constrained when non-empty after trimming, rejecting a leading drive letter
// (a-zA-Z followed by ':'), '/' or '\\', or a ".." anywhere. True when the
// (non-empty) name begins with a Windows drive-letter prefix: an ASCII letter
// (a-zA-Z) immediately followed by ':'.
constexpr qsizetype kDriveLetterPrefixMinLength = 2; // "X:" -- letter + colon
bool hasDriveLetterPrefix(const QString &filename) {
  const QChar first = filename.at(0);
  const bool ascii_letter =
      (first >= QLatin1Char('a') && first <= QLatin1Char('z')) ||
      (first >= QLatin1Char('A') && first <= QLatin1Char('Z'));
  return ascii_letter && filename.size() >= kDriveLetterPrefixMinLength &&
         filename.at(1) == QLatin1Char(':');
}

// A download filename is constrained only when non-empty after trimming: it
// must be a relative name, rejecting a leading drive letter, a leading '/' or
// '\\', or a ".." anywhere. Empty on success.
QString downloadFilenameError(const QString &filename) {
  if (filename.isEmpty()) {
    return QString();
  }
  const QChar first = filename.at(0);
  if (hasDriveLetterPrefix(filename) || first == QLatin1Char('/') ||
      first == QLatin1Char('\\') || filename.contains(QStringLiteral(".."))) {
    return QStringLiteral(
        "browser_download filename must be a relative name without '..'");
  }
  return QString();
}

QString applyDownloadExtra(const QJsonObject &arguments) {
  const QString url = arguments.value(QStringLiteral("url")).toString();
  if (!url.startsWith(QLatin1String("http:"), Qt::CaseInsensitive) &&
      !url.startsWith(QLatin1String("https:"), Qt::CaseInsensitive)) {
    return QStringLiteral("browser_download needs an http(s) url");
  }
  const QString filename =
      arguments.value(QStringLiteral("filename")).toString().trimmed();
  return downloadFilenameError(filename);
}

// browser_upload's `paths`. Validated here and deliberately NOT copied into the
// command: the app reads those files itself and sends their bytes, so a local
// path never reaches the extension, let alone the page. A present-but-malformed
// list is refused rather than narrowed, because an upload that silently drops
// one of several files is an upload the caller cannot check.
QString applyUploadPaths(const QJsonObject &arguments) {
  const QJsonValue paths = arguments.value(QStringLiteral("paths"));
  if (!paths.isArray()) {
    return QStringLiteral("paths must be an array of file paths");
  }
  const QJsonArray items = paths.toArray();
  if (items.isEmpty()) {
    return QStringLiteral("paths must name at least one file");
  }
  if (!std::ranges::all_of(items, [](const QJsonValue &item) {
        return item.isString() && !item.toString().trimmed().isEmpty();
      })) {
    return QStringLiteral("paths must be an array of non-empty file paths");
  }
  return QString();
}

// The most text and HTML one browser_clipboard write may carry, together, in
// UTF-8. Chrome accepts at most 1 MiB in one message from this server, and the
// command's own framing shares that frame; a larger write is refused here, by
// name, rather than failing as a frame that never arrives. Files have no such
// limit: they travel in chunks.
constexpr qsizetype kMaxClipboardWriteBytes = qsizetype{512} * 1024;

// browser_clipboard's arguments, by action. Each action takes only what it
// uses -- write its content, copy/cut/paste a ref, paste `plain` -- so a call
// that hands paste some text, or read a path, is refused rather than having
// half of it silently ignored.
QString applyClipboardArgs(const QJsonObject &arguments) {
  static const QStringList kActions{
      QStringLiteral("write"), QStringLiteral("read"), QStringLiteral("clear"),
      QStringLiteral("copy"),  QStringLiteral("cut"),  QStringLiteral("paste")};
  const QString action = arguments.value(QStringLiteral("action")).toString();
  if (!kActions.contains(action)) {
    return QStringLiteral(
        "action must be write, read, clear, copy, cut, or paste");
  }
  const bool writes = action == QLatin1String("write");
  for (const QString &key : {QStringLiteral("text"), QStringLiteral("html"),
                             QStringLiteral("paths")}) {
    if (arguments.contains(key) && !writes) {
      return QStringLiteral("%1 is only for action write").arg(key);
    }
  }
  if (arguments.contains(QStringLiteral("ref")) &&
      action != QLatin1String("copy") && action != QLatin1String("cut") &&
      action != QLatin1String("paste")) {
    return QStringLiteral("ref is only for actions copy, cut and paste");
  }
  if (arguments.contains(QStringLiteral("plain")) &&
      action != QLatin1String("paste")) {
    return QStringLiteral("plain is only for action paste");
  }
  if (!writes) {
    return QString();
  }
  if (!arguments.contains(QStringLiteral("text")) &&
      !arguments.contains(QStringLiteral("html")) &&
      !arguments.contains(QStringLiteral("paths"))) {
    return QStringLiteral("write needs text, html, or paths");
  }
  if (arguments.contains(QStringLiteral("paths"))) {
    const QString paths = applyUploadPaths(arguments);
    if (!paths.isEmpty()) {
      return paths;
    }
  }
  const qsizetype bytes =
      arguments.value(QStringLiteral("text")).toString().toUtf8().size() +
      arguments.value(QStringLiteral("html")).toString().toUtf8().size();
  if (bytes > kMaxClipboardWriteBytes) {
    return QStringLiteral(
        "text and html may be at most 512 KiB together; write a larger text "
        "from a file with paths");
  }
  return QString();
}

// Tool-specific extras the generic ref/scalar-arg copiers do not cover. Returns
// an error string (empty on success).
QString applyToolExtras(const QString &tool, const QJsonObject &arguments,
                        const QJsonObject &ref_index, QJsonObject &command) {
  if (takesProfile(tool)) {
    const QString profile = checkProfileArg(arguments);
    if (!profile.isEmpty()) {
      return profile;
    }
  }
  if (tool == QLatin1String("browser_find")) {
    FindQuery query;
    return findQueryFrom(arguments, &query);
  }
  if (tool == QLatin1String("browser_snapshot")) {
    OutlineOptions options;
    return outlineOptionsFrom(arguments, &options);
  }
  if (tool == QLatin1String("browser_read")) {
    ReadRequest request;
    QString error = readRequestFrom(arguments, &request);
    if (error.isEmpty()) {
      // The page size always travels, so the extension pages the text in the
      // page rather than sending the whole of it.
      command.insert(QStringLiteral("offset"), request.offset);
      command.insert(QStringLiteral("max_chars"), request.max_chars);
    }
    return error;
  }
  if (tool == QLatin1String("browser_drag")) {
    return applyDragExtra(arguments, ref_index, command);
  }
  if (tool == QLatin1String("browser_select")) {
    return applySelectValues(arguments, command);
  }
  if (tool == QLatin1String("browser_download")) {
    return applyDownloadExtra(arguments);
  }
  if (tool == QLatin1String("browser_upload")) {
    return applyUploadPaths(arguments);
  }
  if (tool == QLatin1String("browser_clipboard")) {
    return applyClipboardArgs(arguments);
  }
  if (takesAgentName(tool)) {
    const QString agent = applyAgentName(arguments, command);
    if (!agent.isEmpty()) {
      return agent;
    }
  }
  if (tool == QLatin1String("browser_select_tab") ||
      tool == QLatin1String("browser_close_tab")) {
    return tabChoiceError(tool, arguments);
  }
  return QString();
}

// The set of argument keys a tool legitimately accepts: its scalar arg specs,
// the ref/to_ref endpoints, tab_id for a command that takes one, and
// browser_select's `values`. Mirrors the additionalProperties:false the schema
// advertises so a caller cannot smuggle an unmodeled key past this layer.
QSet<QString> allowedArgKeys(const QString &tool, const CmdSpec &spec) {
  QSet<QString> allowed;
  if (spec.m_ref_mode != QLatin1String("none")) {
    allowed.insert(QStringLiteral("ref"));
  }
  if (acceptsTabId(spec.m_cmd)) {
    allowed.insert(tabIdArgSpec().m_key);
  }
  for (const ArgSpec &arg : spec.m_args) {
    allowed.insert(arg.m_key);
  }
  if (tool == QLatin1String("browser_drag")) {
    allowed.insert(QStringLiteral("to_ref"));
  }
  if (tool == QLatin1String("browser_select")) {
    allowed.insert(QStringLiteral("values"));
  }
  if (tool == QLatin1String("browser_upload") ||
      tool == QLatin1String("browser_clipboard")) {
    allowed.insert(QStringLiteral("paths"));
  }
  if (takesAgentName(tool)) {
    allowed.insert(QStringLiteral("agent"));
  }
  if (takesProfile(tool)) {
    allowed.insert(QStringLiteral("profile"));
  }
  return allowed;
}

// Reject an argument object carrying any key the tool does not model. Fails
// closed rather than ignoring the extra: an unknown key is a malformed call
// (typo, wrong tool, injection attempt), not something to silently drop.
QString rejectUnknownArgs(const QString &tool, const CmdSpec &spec,
                          const QJsonObject &args) {
  const QSet<QString> allowed = allowedArgKeys(tool, spec);
  for (auto it = args.constBegin(); it != args.constEnd(); ++it) {
    if (!allowed.contains(it.key())) {
      return QStringLiteral("Unknown argument '%1' for %2").arg(it.key(), tool);
    }
  }
  return QString();
}

// -- Catalog -----------------------------------------------------------------

QJsonObject stringProperty(const QString &description) {
  return QJsonObject{{QStringLiteral("type"), QStringLiteral("string")},
                     {QStringLiteral("description"), description}};
}

QJsonObject typedProperty(const QString &type, const QString &description) {
  return QJsonObject{{QStringLiteral("type"), type},
                     {QStringLiteral("description"), description}};
}

// An integer property with its bounds advertised, so a client that validates
// schemas refuses an out-of-range value before it is sent; the same bounds are
// enforced here whatever the client does.
QJsonObject boundedInteger(const QString &description, int minimum,
                           int maximum) {
  QJsonObject property = typedProperty(QStringLiteral("integer"), description);
  property.insert(QStringLiteral("minimum"), minimum);
  property.insert(QStringLiteral("maximum"), maximum);
  return property;
}

// A string property that takes one of a fixed set of values.
QJsonObject choiceProperty(const QString &description,
                           const QStringList &choices) {
  QJsonObject property = stringProperty(description);
  property.insert(QStringLiteral("enum"), QJsonArray::fromStringList(choices));
  return property;
}

// A tab_id property. The minimum is advertised as well as enforced
// (argSemanticError), so a client that validates schemas refuses a 0 before it
// is sent.
QJsonObject tabIdProperty(const QString &description) {
  QJsonObject property = typedProperty(QStringLiteral("integer"), description);
  property.insert(QStringLiteral("minimum"), 1);
  return property;
}

// The `agent` property on the tools that make a tab this session's. Length is
// advertised as well as enforced (applyAgentName); maxLength counts UTF-16
// units in some validators, which only ever makes them stricter than ours.
// The Chrome profile a call opens its tab or window in, or reads cookies and
// sets permissions in.
QJsonObject profileProperty(const QString &what) {
  QJsonObject property = stringProperty(
      QStringLiteral("The Chrome profile to %1, by the name browser_tabs and "
                     "browser_extension_status show (a name such as work, or "
                     "the profile's account email; case does not matter). "
                     "Omit for the profile of the Chrome window the user last "
                     "used.")
          .arg(what));
  property.insert(QStringLiteral("minLength"), 1);
  property.insert(QStringLiteral("maxLength"),
                  static_cast<int>(kMaxProfileArgChars));
  return property;
}

QJsonObject agentProperty() {
  QJsonObject property = stringProperty(QStringLiteral(
      "A short name for the agent doing this work (e.g. \"research\"). Tabs "
      "with the same name share one tab group with its own colour, so the "
      "user can tell agents apart; tabs a page opens from them join the same "
      "group. Omit to use the session's shared group."));
  property.insert(QStringLiteral("minLength"), 1);
  property.insert(QStringLiteral("maxLength"),
                  static_cast<int>(kMaxAgentNameChars));
  return property;
}

// What tab_id means on a tool that acts on one tab. The last sentence is the
// reason it exists: the session's current tab is shared by every agent on this
// server, so an agent that leans on it is one other agent's browser_new_tab
// away from acting on the wrong page.
QString tabIdDescription() {
  return QStringLiteral(
      "Your tab's id, from browser_new_tab or browser_tabs. Omit for this "
      "session's current tab.");
}

// Add tab_id to every tab-scoped tool's schema, from the command specs rather
// than by hand in thirty-odd schemas: a tool whose command acts on one tab
// gets it and no other tool does, by construction, and a new tab-scoped tool
// cannot ship without it. A tool that declares its own tab_id (select_tab and
// close_tab, where omitting it means something different) keeps that one.
QJsonArray withTabIdArguments(const QJsonArray &tools,
                              const QHash<QString, CmdSpec> &specs) {
  QJsonArray out;
  for (const QJsonValue value : tools) {
    QJsonObject tool = value.toObject();
    const auto spec =
        specs.constFind(tool.value(QStringLiteral("name")).toString());
    if (spec != specs.constEnd() && commandIsTabScoped(spec->m_cmd)) {
      QJsonObject schema = tool.value(QStringLiteral("inputSchema")).toObject();
      QJsonObject properties =
          schema.value(QStringLiteral("properties")).toObject();
      if (!properties.contains(QStringLiteral("tab_id"))) {
        properties.insert(QStringLiteral("tab_id"),
                          tabIdProperty(tabIdDescription()));
        schema.insert(QStringLiteral("properties"), properties);
        tool.insert(QStringLiteral("inputSchema"), schema);
      }
    }
    out.append(tool);
  }
  return out;
}

QJsonObject toolSchema(const QJsonObject &properties,
                       const QJsonArray &required) {
  return QJsonObject{{QStringLiteral("type"), QStringLiteral("object")},
                     {QStringLiteral("properties"), properties},
                     {QStringLiteral("required"), required},
                     {QStringLiteral("additionalProperties"), false}};
}

QJsonObject toolEntry(const QString &name, const QString &description,
                      const QJsonObject &schema) {
  return QJsonObject{{QStringLiteral("name"), name},
                     {QStringLiteral("description"), description},
                     {QStringLiteral("inputSchema"), schema}};
}

void appendNavTools(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_navigate"),
      QStringLiteral("Navigate the active tab to an http(s) URL (a bare host "
                     "is read as https; javascript:, data: and file: URLs are "
                     "refused)."),
      toolSchema(
          QJsonObject{{QStringLiteral("url"), stringProperty(QStringLiteral(
                                                  "Absolute URL to open."))}},
          QJsonArray{QStringLiteral("url")})));
  tools.append(toolEntry(
      QStringLiteral("browser_snapshot"),
      QStringLiteral(
          "Capture the page as an outline of its elements, each with a [ref] "
          "that browser_click, browser_type and the other element tools take. "
          "To locate one element, browser_find is far smaller. Options narrow "
          "it: ref (one element's subtree), depth, filter (\"interactive\": "
          "elements with refs and headings; \"viewport\": what is on screen) "
          "and max_chars (a cap that collapses off-screen regions to one line "
          "each instead of cutting the end)."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("ref"),
               stringProperty(QStringLiteral(
                   "Show only this element's subtree: a ref from an earlier "
                   "snapshot or find, such as a dialog, form or region."))},
              {QStringLiteral("depth"),
               boundedInteger(QStringLiteral("Levels below the root to show."),
                              0, kMaxOutlineDepth)},
              {QStringLiteral("filter"),
               choiceProperty(
                   QStringLiteral(
                       "\"all\" (the default), \"interactive\" (elements with "
                       "refs, plus headings) or \"viewport\" (only what is on "
                       "screen)."),
                   {QStringLiteral("all"), QStringLiteral("interactive"),
                    QStringLiteral("viewport")})},
              {QStringLiteral("max_chars"),
               boundedInteger(
                   QStringLiteral(
                       "Cap the outline at this many characters: the largest "
                       "off-screen regions collapse to one line each, with "
                       "the ref to read them by."),
                   kMinOutlineChars, kMaxOutlineChars)}},
          {})));
  tools.append(toolEntry(
      QStringLiteral("browser_find"),
      QStringLiteral(
          "Find elements on the page by visible text or name and get their "
          "refs: the snapshot's lines for just the matches, best first, each "
          "with the dialog or landmark it sits in -- far smaller than a whole "
          "browser_snapshot. Give text (the words to look for), query (the "
          "same as a phrase, where a role word such as button, link, field, "
          "checkbox, tab, menu or heading filters by role) or regex. The refs "
          "work with every element tool right away."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("text"),
               stringProperty(QStringLiteral(
                   "Words in the element's name or value, any case."))},
              {QStringLiteral("query"),
               stringProperty(QStringLiteral(
                   "The same as a phrase, e.g. \"Send message button\": role "
                   "words become a role filter."))},
              {QStringLiteral("regex"),
               stringProperty(
                   QStringLiteral("A pattern the name must match, any case."))},
              {QStringLiteral("role"),
               stringProperty(QStringLiteral(
                   "Only elements of this role, e.g. button, link, field."))},
              {QStringLiteral("max_results"),
               boundedInteger(
                   QStringLiteral("Most matches to show (default 10)."), 1,
                   kMaxFindResults)}},
          {})));
  tools.append(toolEntry(
      QStringLiteral("browser_back"),
      QStringLiteral(
          "Go back one entry in the active tab's history. Chrome does not "
          "create a history entry for a navigation the user never interacted "
          "with, so a browser_navigate that nobody clicked on may leave "
          "nothing to go back to -- that refusal is Chrome's, not this "
          "tool's."),
      toolSchema({}, {})));
  tools.append(toolEntry(
      QStringLiteral("browser_forward"),
      QStringLiteral(
          "Go forward one entry in the active tab's history. There is nothing "
          "forward of the newest entry, and following a fresh navigation "
          "there usually is none."),
      toolSchema({}, {})));
  tools.append(toolEntry(QStringLiteral("browser_reload"),
                         QStringLiteral("Reload the active tab."),
                         toolSchema({}, {})));
  tools.append(toolEntry(
      QStringLiteral("browser_read"),
      QStringLiteral(
          "Read the page's text (default) or html, 30,000 characters at a "
          "time: a longer page's reply gives next_offset, which offset takes "
          "to continue. ref or selector reads one element; mode \"main\" "
          "reads the page's main content."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("format"),
               choiceProperty(
                   QStringLiteral("\"text\" or \"html\"."),
                   {QStringLiteral("text"), QStringLiteral("html")})},
              {QStringLiteral("max_chars"),
               boundedInteger(
                   QStringLiteral("Characters to return (default 30000)."), 1,
                   static_cast<int>(kMaxReadChars))},
              {QStringLiteral("offset"),
               boundedInteger(
                   QStringLiteral("Where to start: a reply's next_offset."), 0,
                   std::numeric_limits<int>::max())},
              {QStringLiteral("ref"),
               stringProperty(QStringLiteral("Read only this element."))},
              {QStringLiteral("selector"),
               stringProperty(QStringLiteral(
                   "Read only the first element this CSS selector matches."))},
              {QStringLiteral("mode"),
               choiceProperty(
                   QStringLiteral("\"main\": the page's main content."),
                   {QStringLiteral("main")})}},
          {})));
  tools.append(toolEntry(
      QStringLiteral("browser_screenshot"),
      QStringLiteral(
          "PNG of the tab's viewport at one pixel per CSS pixel, long edge "
          "at most 1568 (one to two thousand image tokens). Zoom for detail: "
          "ref, or x/y/width/height in screenshot pixels. purpose "
          "\"presentation\" saves full resolution to a file and returns its "
          "path. Control overlay hidden unless included."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("full_page"),
               typedProperty(
                   QStringLiteral("boolean"),
                   QStringLiteral("Capture the full scroll height."))},
              {QStringLiteral("include_control_overlay"),
               typedProperty(
                   QStringLiteral("boolean"),
                   QStringLiteral("Include the visible control frame, badge, "
                                  "and agent cursor for documentation."))},
              {QStringLiteral("ref"),
               stringProperty(QStringLiteral("Element to zoom to."))},
              {QStringLiteral("purpose"),
               choiceProperty(
                   QStringLiteral("\"view\" (default) or "
                                  "\"presentation\"."),
                   {QStringLiteral("view"), QStringLiteral("presentation")})},
              {QStringLiteral("x"), typedProperty(QStringLiteral("integer"),
                                                  QStringLiteral("Zoom x."))},
              {QStringLiteral("y"), typedProperty(QStringLiteral("integer"),
                                                  QStringLiteral("Zoom y."))},
              {QStringLiteral("width"),
               typedProperty(QStringLiteral("integer"),
                             QStringLiteral("Zoom width."))},
              {QStringLiteral("height"),
               typedProperty(QStringLiteral("integer"),
                             QStringLiteral("Zoom height."))}},
          {})));
}

void appendActionTools(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_click"),
      QStringLiteral(
          "Click the element with [ref] from the latest snapshot (injected at "
          "the "
          "browser level, so the user's mouse is untouched). button is left "
          "(default), right (context menu), or middle; click_count 2 "
          "double-clicks "
          "and 3 triple-clicks; modifiers like \"Control+Shift\" enable "
          "multi/range "
          "select."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("ref"),
               stringProperty(QStringLiteral("Element ref, e.g. \"e5\"."))},
              {QStringLiteral("button"),
               stringProperty(
                   QStringLiteral("left | right | middle (optional)."))},
              {QStringLiteral("click_count"),
               typedProperty(QStringLiteral("integer"),
                             QStringLiteral("1, 2, or 3 (optional)."))},
              {QStringLiteral("modifiers"),
               stringProperty(QStringLiteral("e.g. \"Control\", \"Shift\" "
                                             "(optional)."))}},
          QJsonArray{QStringLiteral("ref")})));
  tools.append(toolEntry(
      QStringLiteral("browser_type"),
      QStringLiteral("Type text into the element with [ref] from the latest "
                     "snapshot. Set submit "
                     "to press Enter afterward."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("text"),
               stringProperty(QStringLiteral("Text to type."))},
              {QStringLiteral("ref"), stringProperty(QStringLiteral(
                                          "Target element ref, e.g. \"e5\"."))},
              {QStringLiteral("submit"),
               typedProperty(QStringLiteral("boolean"),
                             QStringLiteral("Press Enter after typing."))}},
          QJsonArray{QStringLiteral("text"), QStringLiteral("ref")})));
  tools.append(toolEntry(
      QStringLiteral("browser_press_key"),
      QStringLiteral(
          "Press a key or chord, e.g. \"Enter\", \"Escape\", \"Shift+Tab\". "
          "A chord means what it means on the browser's platform: select all "
          "is \"Meta+A\" on macOS and \"Control+A\" on Windows and Linux."),
      toolSchema(
          QJsonObject{{QStringLiteral("keys"), stringProperty(QStringLiteral(
                                                   "Key or chord to press."))}},
          QJsonArray{QStringLiteral("keys")})));
  tools.append(toolEntry(
      QStringLiteral("browser_scroll"),
      QStringLiteral(
          "Scroll the page, or the element with [ref] if given (brought into "
          "view first if needed). Replies once the scroll has come to rest, "
          "with how far that scroll moved the content (scrolled), what the "
          "wheel landed on (hit), and how far the scrollers under it could "
          "still travel that way when it did (room). scrolled 0 with room 0 "
          "is an edge already reached; scrolled 0 with room left means the "
          "wheel never reached the scroller."),
      toolSchema(
          QJsonObject{{QStringLiteral("ref"),
                       stringProperty(QStringLiteral(
                           "Element ref to scroll (optional)."))},
                      {QStringLiteral("direction"),
                       stringProperty(QStringLiteral("\"up\" or \"down\"."))},
                      {QStringLiteral("amount"),
                       typedProperty(QStringLiteral("integer"),
                                     QStringLiteral("Pixels to scroll."))}},
          {})));
  tools.append(
      toolEntry(QStringLiteral("browser_dialog"),
                QStringLiteral("Set how the NEXT JavaScript dialog is answered "
                               "and report the last one. "
                               "Dialogs are auto-answered (alert/beforeunload "
                               "accepted, confirm/prompt "
                               "dismissed); call this with action \"accept\" "
                               "just before the step that "
                               "opens a confirm/prompt you want to accept."),
                toolSchema(QJsonObject{{QStringLiteral("action"),
                                        stringProperty(QStringLiteral(
                                            "\"accept\" or \"dismiss\" "
                                            "(default) for the next dialog."))},
                                       {QStringLiteral("text"),
                                        stringProperty(QStringLiteral(
                                            "Text for an accepted prompt() "
                                            "dialog (optional)."))}},
                           {})));
}

void appendPointerTools(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_click_at"),
      QStringLiteral("Click at pixel coordinates read from the most recent "
                     "browser_screenshot "
                     "(x,y in that image's pixels). Use this only for targets "
                     "with no [ref] "
                     "(canvas, image maps); prefer browser_click by ref "
                     "otherwise. Supports "
                     "button, click_count, and modifiers like browser_click."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("x"),
               typedProperty(QStringLiteral("number"),
                             QStringLiteral("X in screenshot pixels."))},
              {QStringLiteral("y"),
               typedProperty(QStringLiteral("number"),
                             QStringLiteral("Y in screenshot pixels."))},
              {QStringLiteral("button"),
               stringProperty(
                   QStringLiteral("left | right | middle (optional)."))},
              {QStringLiteral("click_count"),
               typedProperty(QStringLiteral("integer"),
                             QStringLiteral("1, 2, or 3 (optional)."))},
              {QStringLiteral("modifiers"),
               stringProperty(
                   QStringLiteral("e.g. \"Control+Shift\" (optional)."))}},
          QJsonArray{QStringLiteral("x"), QStringLiteral("y")})));
  tools.append(toolEntry(
      QStringLiteral("browser_hover"),
      QStringLiteral(
          "Move the pointer over the element with [ref] to reveal hover menus, "
          "tooltips, or row actions, then take a fresh snapshot to read what "
          "appeared. duration_ms lets hover-intent UI settle. An element with "
          "no accessibility role -- a link with no href, a div with only an "
          "onmouseenter handler -- gets no ref; hover it by x/y instead, which "
          "are pixels of the latest browser_screenshot, exactly as "
          "browser_click_at takes them. Give a ref or x/y, never both."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("ref"),
               stringProperty(
                   QStringLiteral("Element ref to hover, e.g. \"e5\"."))},
              {QStringLiteral("x"),
               typedProperty(QStringLiteral("number"),
                             QStringLiteral(
                                 "Screenshot x, for an element with no ref."))},
              {QStringLiteral("y"),
               typedProperty(QStringLiteral("number"),
                             QStringLiteral(
                                 "Screenshot y, for an element with no ref."))},
              {QStringLiteral("duration_ms"),
               typedProperty(QStringLiteral("integer"),
                             QStringLiteral("Dwell time in ms (optional)."))}},
          QJsonArray{QStringLiteral("ref")})));
  tools.append(toolEntry(
      QStringLiteral("browser_drag"),
      QStringLiteral(
          "Drag from a source to a target with interpolated moves (sliders, "
          "sortable/kanban lists, splitters, canvas, media scrubbers). Give "
          "the "
          "source as [ref] or from_x/from_y and the target as to_ref or "
          "to_x/to_y. x/y are pixels of the most recent browser_screenshot, "
          "as for browser_click_at. "
          "hold_ms pauses after press for long-press pickup."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("ref"),
               stringProperty(QStringLiteral(
                   "Source element ref (optional if from_x/from_y)."))},
              {QStringLiteral("to_ref"),
               stringProperty(QStringLiteral(
                   "Target element ref (optional if to_x/to_y)."))},
              {QStringLiteral("from_x"),
               typedProperty(QStringLiteral("number"),
                             QStringLiteral(
                                 "Source X in screenshot pixels (optional)."))},
              {QStringLiteral("from_y"),
               typedProperty(QStringLiteral("number"),
                             QStringLiteral(
                                 "Source Y in screenshot pixels (optional)."))},
              {QStringLiteral("to_x"),
               typedProperty(QStringLiteral("number"),
                             QStringLiteral(
                                 "Target X in screenshot pixels (optional)."))},
              {QStringLiteral("to_y"),
               typedProperty(QStringLiteral("number"),
                             QStringLiteral(
                                 "Target Y in screenshot pixels (optional)."))},
              {QStringLiteral("steps"),
               typedProperty(QStringLiteral("integer"),
                             QStringLiteral("Interpolated moves (optional)."))},
              {QStringLiteral("hold_ms"),
               typedProperty(QStringLiteral("integer"),
                             QStringLiteral("Hold after press (optional)."))}},
          {})));
}

void appendFormControlTools(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_select"),
      QStringLiteral("Select an option in a <select> dropdown with [ref] from "
                     "the latest snapshot, "
                     "by option value, visible label, or zero-based index "
                     "(give exactly one). "
                     "Fires the page's input and change events."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("ref"),
               stringProperty(
                   QStringLiteral("The <select> element ref, e.g. \"e5\"."))},
              {QStringLiteral("value"),
               stringProperty(QStringLiteral(
                   "Option value attribute to select (optional)."))},
              {QStringLiteral("label"),
               stringProperty(QStringLiteral(
                   "Visible option text to select (optional)."))},
              {QStringLiteral("index"),
               typedProperty(
                   QStringLiteral("integer"),
                   QStringLiteral("Zero-based option index (optional)."))},
              {QStringLiteral("values"),
               QJsonObject{{QStringLiteral("type"), QStringLiteral("array")},
                           {QStringLiteral("items"),
                            QJsonObject{{QStringLiteral("type"),
                                         QStringLiteral("string")}}},
                           {QStringLiteral("description"),
                            QStringLiteral("Option values or labels to select "
                                           "in a multiple-select "
                                           "(optional).")}}}},
          QJsonArray{QStringLiteral("ref")})));
  tools.append(toolEntry(
      QStringLiteral("browser_upload"),
      QStringLiteral(
          "Give a file input local files as the user picking them would: the "
          "page gets real File objects and its handlers run. A click on a file "
          "input never opens a dialog -- the reply says a file chooser opened; "
          "then call this with paths and no ref. Or pass ref: the input, or "
          "the button or label that opens it (a hidden input shows in the "
          "snapshot as filechooser (hidden)). Absolute paths; several need an "
          "input marked multiple. Up to 2 GiB a file, or what "
          "CHROME_CONTROL_MCP_UPLOAD_MAX_MB sets; no path reaches the page."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("ref"),
               stringProperty(QStringLiteral(
                   "Target file input ref, e.g. \"e5\" (optional; omit to fill "
                   "the file chooser the page opened)."))},
              {QStringLiteral("paths"),
               QJsonObject{{QStringLiteral("type"), QStringLiteral("array")},
                           {QStringLiteral("items"),
                            QJsonObject{{QStringLiteral("type"),
                                         QStringLiteral("string")}}},
                           {QStringLiteral("description"),
                            QStringLiteral(
                                "Absolute paths of the files to attach.")}}}},
          QJsonArray{QStringLiteral("paths")})));
  tools.append(toolEntry(
      QStringLiteral("browser_set_value"),
      QStringLiteral(
          "Set the value of a form control with [ref] from the latest snapshot "
          "and fire "
          "its input/change events. Works for range sliders, "
          "date/time/color/number "
          "inputs, and hidden or custom controls; pass checked (true/false) "
          "for a "
          "checkbox or radio. Use browser_type for normal text fields."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("ref"), stringProperty(QStringLiteral(
                                          "Target control ref, e.g. \"e5\"."))},
              {QStringLiteral("value"),
               stringProperty(
                   QStringLiteral("Value to set (e.g. \"7\", \"2026-07-29\", "
                                  "\"#ff2d95\")."))},
              {QStringLiteral("checked"),
               typedProperty(
                   QStringLiteral("boolean"),
                   QStringLiteral("For a checkbox/radio: checked state."))}},
          QJsonArray{QStringLiteral("ref")})));
  tools.append(toolEntry(
      QStringLiteral("browser_media"),
      QStringLiteral("Control an <audio> or <video> element with [ref] from "
                     "the latest snapshot. "
                     "action is play, pause, mute, unmute, seek, volume, or "
                     "rate; value is the "
                     "seconds (seek), 0..1 (volume), or playback rate. Returns "
                     "the media state."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("ref"),
               stringProperty(
                   QStringLiteral("The media element ref, e.g. \"e5\"."))},
              {QStringLiteral("action"),
               stringProperty(QStringLiteral(
                   "play | pause | mute | unmute | seek | volume | "
                   "rate."))},
              {QStringLiteral("value"),
               stringProperty(QStringLiteral(
                   "Numeric argument for seek/volume/rate (optional)."))}},
          QJsonArray{QStringLiteral("ref"), QStringLiteral("action")})));
  QJsonObject clipboardAction = stringProperty(QStringLiteral(
      "write: put text, html and/or files on your clipboard (replacing what "
      "was there). read: return it. clear: empty it. copy / cut: the "
      "selection (or [ref]'s contents) in the tab. paste: into the focused "
      "element (or [ref])."));
  clipboardAction.insert(
      QStringLiteral("enum"),
      QJsonArray{QStringLiteral("write"), QStringLiteral("read"),
                 QStringLiteral("clear"), QStringLiteral("copy"),
                 QStringLiteral("cut"), QStringLiteral("paste")});
  tools.append(toolEntry(
      QStringLiteral("browser_clipboard"),
      QStringLiteral(
          "Your own clipboard, separate from the user's and every other "
          "agent's; nothing reaches the system clipboard. Copy, cut and paste "
          "keys (browser_press_key, Control or Meta with C, X, V) and a page's "
          "copy and paste buttons use it. Put text, HTML or an image on it to "
          "paste into any editor -- the page gets a real paste, with "
          "formatting and files -- instead of a shell clipboard command, "
          "which everyone shares. Files: absolute paths, as for "
          "browser_upload. Emptied when you release your last tab."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("action"), clipboardAction},
              {QStringLiteral("text"),
               stringProperty(QStringLiteral(
                   "write: plain text (optional; text and html together "
                   "at most 512 KiB)."))},
              {QStringLiteral("html"),
               stringProperty(QStringLiteral(
                   "write: the same content as HTML, for editors that keep "
                   "formatting (optional)."))},
              {QStringLiteral("paths"),
               QJsonObject{{QStringLiteral("type"), QStringLiteral("array")},
                           {QStringLiteral("items"),
                            QJsonObject{{QStringLiteral("type"),
                                         QStringLiteral("string")}}},
                           {QStringLiteral("description"),
                            QStringLiteral("write: absolute paths of files "
                                           "(images, documents) to put on "
                                           "the clipboard (optional).")}}},
              {QStringLiteral("ref"),
               stringProperty(QStringLiteral(
                   "copy / cut: the element whose contents to take; paste: "
                   "the element to paste into (optional)."))},
              {QStringLiteral("plain"),
               typedProperty(QStringLiteral("boolean"),
                             QStringLiteral("paste: text only, without "
                                            "formatting or files "
                                            "(optional)."))}},
          QJsonArray{QStringLiteral("action")})));
}

void appendTabTools(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_tabs"),
      QStringLiteral("List the tabs in the session's window with index, title, "
                     "and URL."),
      toolSchema({}, {})));
  tools.append(toolEntry(
      QStringLiteral("browser_console"),
      QStringLiteral(
          "What the page has said since this session attached: console "
          "messages, uncaught exceptions and unhandled rejections, and what "
          "the browser itself reported about the page (a blocked load, a CSP "
          "violation, a subresource that failed). Read this when an action "
          "appeared to do nothing -- a click that changed nothing usually "
          "threw. Newest last; total and omitted say what this reply left "
          "out, and dropped how many the buffer discarded, so an empty list "
          "means silence rather than lost history."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("level"),
               stringProperty(QStringLiteral(
                   "Only this level: error, warning, info, log, or debug "
                   "(optional; default all)."))},
              {QStringLiteral("limit"),
               typedProperty(
                   QStringLiteral("integer"),
                   QStringLiteral("How many of the most recent to return "
                                  "(default 50)."))},
              {QStringLiteral("clear"),
               typedProperty(QStringLiteral("boolean"),
                             QStringLiteral("Discard the buffer after replying "
                                            "(default false)."))}},
          {})));
  tools.append(toolEntry(
      QStringLiteral("browser_network"),
      QStringLiteral(
          "The requests this page made since the session attached: method, "
          "URL, resource type, status, MIME type, and the milliseconds until "
          "the response arrived; a request that never got one carries the "
          "browser's error text "
          "instead of a status. Use it to confirm a form actually posted, or "
          "to find the call behind a page that looks broken. in_flight "
          "counts requests still waiting, so an empty list is not mistaken "
          "for a page that asked for nothing."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("failed_only"),
               typedProperty(QStringLiteral("boolean"),
                             QStringLiteral("Only failures and status >= 400 "
                                            "(default false)."))},
              {QStringLiteral("limit"),
               typedProperty(
                   QStringLiteral("integer"),
                   QStringLiteral("How many of the most recent to return "
                                  "(default 50)."))},
              {QStringLiteral("clear"),
               typedProperty(QStringLiteral("boolean"),
                             QStringLiteral("Discard the buffer after replying "
                                            "(default false)."))}},
          {})));
  tools.append(toolEntry(
      QStringLiteral("browser_select_tab"),
      QStringLiteral(
          "Make a tab the session's tab, named by tab_id or by index -- give "
          "exactly one. The tab is NOT brought to the front and its window is "
          "never raised: the browser goes on showing whichever tab its user "
          "chose, and this session drives its own in the background. An index "
          "is only meaningful against a listing, so call browser_tabs first; "
          "the call is refused if the tabs moved since that listing so the "
          "index cannot land on a tab you did not choose."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("index"),
               typedProperty(QStringLiteral("integer"),
                             QStringLiteral("Zero-based tab index from the "
                                            "last browser_tabs listing "
                                            "(give this or tab_id)."))},
              {QStringLiteral("tab_id"),
               tabIdProperty(QStringLiteral(
                   "Chrome tab id to make the session's tab (from "
                   "browser_new_tab or browser_tabs; give this or index)."))},
              {QStringLiteral("agent"), agentProperty()}},
          {})));
  tools.append(toolEntry(
      QStringLiteral("browser_new_tab"),
      QStringLiteral(
          "Open a new tab in the session's window, optionally navigating to a "
          "URL. It opens in the BACKGROUND -- the browser goes on showing "
          "whichever tab its user chose -- and becomes the session's tab, "
          "marked in the tab strip while this session drives it. The reply "
          "carries its tab_id: pass that to every later call, so another "
          "agent sharing this server cannot retarget you."),
      toolSchema(
          QJsonObject{{QStringLiteral("url"), stringProperty(QStringLiteral(
                                                  "URL to open (optional)."))},
                      {QStringLiteral("agent"), agentProperty()},
                      {QStringLiteral("profile"),
                       profileProperty(QStringLiteral("open the tab in"))}},
          {})));
  tools.append(toolEntry(
      QStringLiteral("browser_close_tab"),
      QStringLiteral(
          "Close the tab named by tab_id or index, or the session's tab if "
          "neither is given. When you pass an index, call browser_tabs first: "
          "closing is not undoable, so the index is checked against that "
          "listing and refused if the tabs moved."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("index"),
               typedProperty(
                   QStringLiteral("integer"),
                   QStringLiteral("Zero-based tab index from the last "
                                  "browser_tabs listing (optional; give this "
                                  "or tab_id, not both)."))},
              {QStringLiteral("tab_id"),
               tabIdProperty(QStringLiteral(
                   "Chrome tab id to close (from browser_new_tab or "
                   "browser_tabs; optional; give this or index, not "
                   "both)."))}},
          {})));
  tools.append(toolEntry(
      QStringLiteral("browser_release"),
      QStringLiteral(
          "Call this when your task is done: tabs this session opened close, "
          "tabs it borrowed are handed back, never closed, and the AI group "
          "and highlight go. With other agents on this server, pass your "
          "tab_id to release only your tabs: that tab, tabs opened from it, "
          "and every tab under your agent name. keep_open:true hands the tabs "
          "you opened to the user instead. The reply lists what was closed, "
          "handed back and kept."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("tab_id"),
               tabIdProperty(QStringLiteral(
                   "Release your tabs: this one, the tabs opened from it, and "
                   "every tab of the same agent name (optional; omit to "
                   "release every tab this session holds)."))},
              {QStringLiteral("keep_open"),
               typedProperty(
                   QStringLiteral("boolean"),
                   QStringLiteral("Leave the tabs this session opened open for "
                                  "the user instead of closing them "
                                  "(optional; default false)."))}},
          {})));
  tools.append(toolEntry(
      QStringLiteral("browser_group_tabs"),
      QStringLiteral("Group tabs into a Chrome tab group (creating one), "
                     "optionally naming and "
                     "coloring it. tab_indices is a comma-separated list of "
                     "zero-based tab "
                     "indices; the active tab is grouped if omitted."),
      toolSchema(
          QJsonObject{{QStringLiteral("tab_indices"),
                       stringProperty(QStringLiteral(
                           "Comma-separated zero-based tab indices, e.g. "
                           "\"0,1,2\" (optional; default the active tab)."))},
                      {QStringLiteral("title"), stringProperty(QStringLiteral(
                                                    "Group name (optional)."))},
                      {QStringLiteral("color"),
                       stringProperty(QStringLiteral(
                           "Group color: grey, blue, red, yellow, green, pink, "
                           "purple, cyan, or orange (optional)."))}},
          {})));
  tools.append(toolEntry(
      QStringLiteral("browser_ungroup_tabs"),
      QStringLiteral("Remove tabs from their Chrome tab group. tab_indices is "
                     "a comma-separated "
                     "list of zero-based tab indices; the active tab is "
                     "ungrouped if omitted."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("tab_indices"),
               stringProperty(QStringLiteral(
                   "Comma-separated zero-based tab indices (optional)."))}},
          {})));
}

void appendWaitForTool(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_wait_for"),
      QStringLiteral(
          "Wait until a condition holds on the active tab, or timeout. Give "
          "exactly "
          "one of text (page text appears), url_contains (URL contains a "
          "substring), "
          "selector (a CSS selector matches, pierces shadow DOM), or "
          "network_idle "
          "(no in-flight network requests for idle_ms). Set absent to wait for "
          "a "
          "text/url/selector condition to go away instead. Read-only polling."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("text"),
               stringProperty(
                   QStringLiteral("Page text to wait for (optional)."))},
              {QStringLiteral("url_contains"),
               stringProperty(QStringLiteral(
                   "Substring the tab URL must contain (optional)."))},
              {QStringLiteral("selector"),
               stringProperty(
                   QStringLiteral("CSS selector to wait for (optional)."))},
              {QStringLiteral("network_idle"),
               typedProperty(
                   QStringLiteral("boolean"),
                   QStringLiteral(
                       "Wait until network activity settles (optional)."))},
              {QStringLiteral("idle_ms"),
               typedProperty(
                   QStringLiteral("integer"),
                   QStringLiteral(
                       "Quiet window for network_idle in ms (default 500)."))},
              {QStringLiteral("absent"),
               typedProperty(
                   QStringLiteral("boolean"),
                   QStringLiteral(
                       "Wait for the condition to be false (optional)."))},
              {QStringLiteral("timeout_ms"),
               typedProperty(QStringLiteral("integer"),
                             // The cap is stated because it is enforced by
                             // clamping: a caller asking for more than this got
                             // less and was told nothing about it.
                             QStringLiteral("Max wait in ms (default 8000, cap "
                                            "120000)."))}},
          {})));
}

void appendInspectionTools(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_get_value"),
      QStringLiteral("Read the current state of a control with [ref]: value, "
                     "checked, selected "
                     "options, contenteditable text, and disabled. Read-only."),
      toolSchema(QJsonObject{{QStringLiteral("ref"),
                              stringProperty(QStringLiteral(
                                  "Target control ref, e.g. \"e5\"."))}},
                 QJsonArray{QStringLiteral("ref")})));
  tools.append(toolEntry(
      QStringLiteral("browser_get_attribute"),
      QStringLiteral(
          "Read an element's attributes by [ref]: give name for one attribute "
          "(e.g. href, src, aria-label), or omit name for all attributes. "
          "Read-only."),
      toolSchema(
          QJsonObject{{QStringLiteral("ref"),
                       stringProperty(
                           QStringLiteral("Target element ref, e.g. \"e5\"."))},
                      {QStringLiteral("name"),
                       stringProperty(QStringLiteral(
                           "Attribute name (optional; all if omitted)."))}},
          QJsonArray{QStringLiteral("ref")})));
  tools.append(toolEntry(
      QStringLiteral("browser_box"),
      QStringLiteral(
          "Report an element's geometry by [ref]: position/size in CSS px, "
          "screenshot_center (the center in browser_screenshot pixels, ready "
          "for browser_click_at at any display scale), whether it is "
          "in "
          "the viewport, and whether an overlay covers its center (occlusion). "
          "Read-only."),
      toolSchema(QJsonObject{{QStringLiteral("ref"),
                              stringProperty(QStringLiteral(
                                  "Target element ref, e.g. \"e5\"."))}},
                 QJsonArray{QStringLiteral("ref")})));
  tools.append(toolEntry(
      QStringLiteral("browser_focus"),
      QStringLiteral("Focus the element with [ref] (to then browser_press_key "
                     "into it without "
                     "clicking)."),
      toolSchema(QJsonObject{{QStringLiteral("ref"),
                              stringProperty(QStringLiteral(
                                  "Target element ref, e.g. \"e5\"."))}},
                 QJsonArray{QStringLiteral("ref")})));
  tools.append(toolEntry(
      QStringLiteral("browser_reveal"),
      QStringLiteral(
          "Scroll the element with [ref] into view (before a screenshot or "
          "browser_click_at)."),
      toolSchema(QJsonObject{{QStringLiteral("ref"),
                              stringProperty(QStringLiteral(
                                  "Target element ref, e.g. \"e5\"."))}},
                 QJsonArray{QStringLiteral("ref")})));
}

void appendWindowTools(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_windows"),
      QStringLiteral(
          "List the open browser windows (window_id, focused, type, state, "
          "tab_count) "
          "so a model-opened popup or new window is visible. Read-only."),
      toolSchema({}, {})));
  tools.append(toolEntry(
      QStringLiteral("browser_window"),
      QStringLiteral("Manage a browser window. action is new (open a window "
                     "without taking OS focus, optionally at a URL; it becomes "
                     "the session's window; took_os_focus reports a compositor "
                     "that focused it anyway, so prefer browser_new_tab), "
                     "focus (make window_id the "
                     "session's working window; it is not raised and the user "
                     "keeps OS focus), or close (close window_id). Get "
                     "window_id from browser_windows."),
      toolSchema(
          QJsonObject{{QStringLiteral("action"),
                       stringProperty(QStringLiteral("new | focus | close."))},
                      {QStringLiteral("window_id"),
                       typedProperty(QStringLiteral("integer"),
                                     QStringLiteral(
                                         "Target window id for focus/close."))},
                      {QStringLiteral("url"),
                       stringProperty(QStringLiteral(
                           "URL to open for action new (optional)."))},
                      {QStringLiteral("profile"),
                       profileProperty(QStringLiteral(
                           "open the window in, for action new"))}},
          QJsonArray{QStringLiteral("action")})));
}

void appendInfraTools(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_emulate"),
      QStringLiteral("Emulate a device on the active tab for "
                     "responsive/mobile/UA testing: give "
                     "width+height (CSS px, with optional device_scale_factor "
                     "and mobile), a "
                     "user_agent string, and/or touch. Pass reset:true to "
                     "clear all emulation "
                     "and restore the real device. Overrides also clear when "
                     "you switch tabs."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("width"),
               typedProperty(QStringLiteral("integer"),
                             QStringLiteral("Viewport width in CSS "
                                            "px (with height)."))},
              {QStringLiteral("height"),
               typedProperty(QStringLiteral("integer"),
                             QStringLiteral("Viewport height in CSS "
                                            "px (with width)."))},
              {QStringLiteral("device_scale_factor"),
               typedProperty(
                   QStringLiteral("number"),
                   QStringLiteral("Device pixel ratio, e.g. 1.25, 1.5, 2 "
                                  "(optional, default 1)."))},
              {QStringLiteral("mobile"),
               typedProperty(
                   QStringLiteral("boolean"),
                   QStringLiteral(
                       "Emulate a mobile device (meta viewport, optional)."))},
              {QStringLiteral("user_agent"),
               stringProperty(
                   QStringLiteral("User-Agent string to send (optional)."))},
              {QStringLiteral("touch"),
               typedProperty(
                   QStringLiteral("boolean"),
                   QStringLiteral("Enable touch input emulation (optional)."))},
              {QStringLiteral("reset"),
               typedProperty(
                   QStringLiteral("boolean"),
                   QStringLiteral(
                       "Clear all emulation and restore the real device."))}},
          {})));
}

void appendPrintTool(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_print"),
      QStringLiteral("Print the active tab to a PDF file (no printer, no OS "
                     "dialog) and save it "
                     "to the user's Downloads/ChromeControlMCP folder; returns "
                     "the saved path. Options: "
                     "landscape, scale (0.1-2), paper_width/paper_height "
                     "(inches), print_background "
                     "(default true), and page_ranges like \"1-3\"."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("landscape"),
               typedProperty(
                   QStringLiteral("boolean"),
                   QStringLiteral("Landscape orientation (optional)."))},
              {QStringLiteral("scale"),
               typedProperty(QStringLiteral("number"),
                             QStringLiteral(
                                 "Render scale 0.1-2 (optional, default 1)."))},
              {QStringLiteral("paper_width"),
               typedProperty(
                   QStringLiteral("number"),
                   QStringLiteral("Paper width in inches (optional)."))},
              {QStringLiteral("paper_height"),
               typedProperty(
                   QStringLiteral("number"),
                   QStringLiteral("Paper height in inches (optional)."))},
              {QStringLiteral("print_background"),
               typedProperty(QStringLiteral("boolean"),
                             QStringLiteral("Print CSS backgrounds (optional, "
                                            "default true)."))},
              {QStringLiteral("page_ranges"),
               stringProperty(QStringLiteral(
                   "Pages to print, e.g. \"1-3\" (optional)."))}},
          {})));
}

void appendPermissionTool(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_permission"),
      QStringLiteral(
          "Set a site permission so automation can pre-answer prompts. name: "
          "geolocation, notifications, camera, microphone, images, "
          "javascript, popups or automatic_downloads; setting: allow, block "
          "or ask (the default). allow needs an explicit origin (e.g. "
          "\"https://site.com\"): a grant persists, so the site getting the "
          "camera is named, not taken from whichever tab is in front. block "
          "and ask default to the active tab."),
      toolSchema(
          QJsonObject{{QStringLiteral("name"),
                       stringProperty(QStringLiteral(
                           "Permission to set, e.g. geolocation or camera."))},
                      {QStringLiteral("profile"),
                       profileProperty(QStringLiteral("set it in"))},
                      {QStringLiteral("setting"),
                       stringProperty(
                           QStringLiteral("allow, block, or ask (default)."))},
                      {QStringLiteral("origin"),
                       stringProperty(QStringLiteral(
                           "Origin the setting applies to. Required for "
                           "setting=allow; defaults to the active tab for "
                           "block and ask."))}},
          QJsonArray{QStringLiteral("name"), QStringLiteral("setting")})));
}

void appendStorageTool(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_storage"),
      QStringLiteral("Read or write the active tab's web storage: action is "
                     "get, set, remove, "
                     "clear, or keys; area is local (default) or session. "
                     "get/set/remove need a "
                     "key; set needs a string value. Returns the value, the "
                     "key list, or a count. "
                     "Values/keys are capped to keep results bounded."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("action"),
               stringProperty(
                   QStringLiteral("get, set, remove, clear, or keys."))},
              {QStringLiteral("area"),
               stringProperty(QStringLiteral("local (default) or session."))},
              {QStringLiteral("key"), stringProperty(QStringLiteral(
                                          "Storage key for get/set/remove."))},
              {QStringLiteral("value"), stringProperty(QStringLiteral(
                                            "String value to store for set."))},
              {QStringLiteral("expect_origin"),
               stringProperty(QStringLiteral(
                   "Origin you expect the active tab to be on, e.g. "
                   "https://example.com (optional). The call is refused if the "
                   "tab is somewhere else, so a tab change cannot redirect the "
                   "read or write at another site's storage."))}},
          QJsonArray{QStringLiteral("action")})));
}

void appendCookiesTool(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_cookies"),
      QStringLiteral("Read, set, or remove cookies for a url (defaults to the "
                     "active tab). "
                     "action=get returns the cookies including their values "
                     "(may include session "
                     "tokens); set needs name+value (options: path, secure, "
                     "http_only, same_site, "
                     "expires_days -- a set is confined to the url's domain); "
                     "remove needs name."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("action"),
               stringProperty(QStringLiteral("get, set, or remove."))},
              {QStringLiteral("profile"),
               profileProperty(QStringLiteral("use the cookies of"))},
              {QStringLiteral("url"),
               stringProperty(QStringLiteral(
                   "Cookie url (optional; defaults to the active tab)."))},
              {QStringLiteral("name"),
               stringProperty(QStringLiteral("Cookie name for set/remove."))},
              {QStringLiteral("value"),
               stringProperty(QStringLiteral("Cookie value for set."))},
              {QStringLiteral("path"), stringProperty(QStringLiteral(
                                           "Cookie path for set (optional)."))},
              {QStringLiteral("secure"),
               typedProperty(QStringLiteral("boolean"),
                             QStringLiteral("Secure flag (optional)."))},
              {QStringLiteral("http_only"),
               typedProperty(QStringLiteral("boolean"),
                             QStringLiteral("HttpOnly flag (optional)."))},
              {QStringLiteral("same_site"),
               stringProperty(QStringLiteral(
                   "no_restriction, lax, or strict (optional)."))},
              {QStringLiteral("expires_days"),
               typedProperty(
                   QStringLiteral("number"),
                   QStringLiteral(
                       "Lifetime in days; omit for a session cookie."))}},
          QJsonArray{QStringLiteral("action")})));
}

void appendDownloadTool(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_download"),
      QStringLiteral(
          "Download a url to disk and wait for it to finish, returning the "
          "saved path "
          "and byte size. filename is optional and must be a relative name (no "
          "absolute path, no \"..\"); omit it to derive the name from the url. "
          "timeout_ms bounds the wait (default 30000)."),
      toolSchema(
          QJsonObject{{QStringLiteral("url"), stringProperty(QStringLiteral(
                                                  "http(s) url to download."))},
                      {QStringLiteral("filename"),
                       stringProperty(QStringLiteral(
                           "Relative save name, e.g. \"reports/a.pdf\" "
                           "(optional)."))},
                      {QStringLiteral("timeout_ms"),
                       typedProperty(
                           QStringLiteral("integer"),
                           QStringLiteral(
                               "Max wait in ms (optional, default 30000)."))}},
          QJsonArray{QStringLiteral("url")})));
}

void appendRecordTools(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_record_start"),
      QStringLiteral(
          "Record the session's tab to a .webm video (no audio) until "
          "browser_record_stop, which returns the saved path; the video never "
          "comes back in a reply. One recording per session at a time. "
          "Chrome shows no "
          "separate recording indicator, only the debugging banner that is "
          "up for the whole session."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("filename"),
               stringProperty(QStringLiteral(
                   "Relative name for the .webm, e.g. \"runs/login.webm\". "
                   "Omit to have one derived from the time."))},
              {QStringLiteral("resolution"),
               choiceProperty(
                   QStringLiteral("\"standard\" (up to 1280x800, "
                                  "default) or \"full\" (device "
                                  "pixels)."),
                   {QStringLiteral("standard"), QStringLiteral("full")})}},
          {})));
  tools.append(toolEntry(
      QStringLiteral("browser_record_stop"),
      QStringLiteral(
          "Stop the recording started by browser_record_start and return the "
          "saved video path, its duration, and the path of a JSON timeline "
          "written beside it. The timeline lists every command that ran while "
          "recording -- its id, the command name in `cmd`, `offset_ms`, and "
          "the DOM generation in `dom_epoch` -- so the video can be read "
          "against what drove it."),
      toolSchema(QJsonObject{}, {})));
}

void appendHttpAuthTool(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_http_auth"),
      QStringLiteral(
          "Arm HTTP Basic/Digest credentials so 401 auth challenges on the "
          "active tab "
          "are answered automatically (no native auth dialog). Give username + "
          "password before navigating to a protected page; pass clear:true to "
          "disarm. "
          "Credentials clear on a tab switch. The password is never echoed "
          "back."),
      toolSchema(
          QJsonObject{
              {QStringLiteral("username"),
               stringProperty(
                   QStringLiteral("Auth username (required unless clear)."))},
              {QStringLiteral("password"),
               stringProperty(QStringLiteral(
                   "Auth password (used only to answer challenges)."))},
              {QStringLiteral("clear"),
               typedProperty(
                   QStringLiteral("boolean"),
                   QStringLiteral("Disarm and stop intercepting auth."))},
              {QStringLiteral("origin"),
               stringProperty(
                   QStringLiteral("Origin the credentials are for, e.g. "
                                  "https://example.com (optional "
                                  "but recommended). Arming is refused if the "
                                  "active tab is somewhere "
                                  "else, so a focus change cannot bind them to "
                                  "another site."))}},
          {})));
}

void appendAdvancedInputTools(QJsonArray &tools) {
  tools.append(toolEntry(
      QStringLiteral("browser_js_click"),
      QStringLiteral("Click the element with [ref] via its DOM click() method, "
                     "as a fallback "
                     "when a normal browser_click cannot land (target occluded "
                     "by an overlay, "
                     "zero-size but present, or ignoring synthetic pointer "
                     "events). Prefer "
                     "browser_click otherwise."),
      toolSchema(QJsonObject{{QStringLiteral("ref"),
                              stringProperty(QStringLiteral(
                                  "Target element ref, e.g. \"e5\"."))}},
                 QJsonArray{QStringLiteral("ref")})));
}

// Cap how many omitted-frame URLs are listed so a page spawning hundreds of
// cross-origin iframes cannot flood the outline.
constexpr int kMaxOmittedFramesListed = 20;

// Cross-origin (out-of-process) iframes are not reached by the single-pass
// capture. Rather than a bare "some content is missing", list the omitted
// frames' URLs so the model can navigate into a frame it needs. Each URL is
// page-derived, so it is collapsed to one line and length-capped (a newline in
// a URL could otherwise forge an outline line); refs are only ever trusted from
// ref_index, never parsed from this text. Falls back to the older boolean-only
// note when an extension does not send the URL list.
//
// The list is cut twice -- once by the extension's own cap, once by this one --
// and either cut has to be stated. The extension's cut arrives as
// omittedFramesTruncated rather than as a longer array, so the note does not
// depend on the two caps being kept numerically in step: raising one alone
// would otherwise turn a cut list back into an apparently complete one.
void appendOmittedFramesNote(const QJsonObject &capture, QString &outline) {
  const QJsonArray frames =
      capture.value(QStringLiteral("omittedFrames")).toArray();
  if (!frames.isEmpty()) {
    outline +=
        QStringLiteral("  ... (cross-origin iframe content not included; "
                       "browser_navigate to a frame URL to read it):\n");
    bool cut = capture.value(QStringLiteral("omittedFramesTruncated")).toBool();
    int listed = 0;
    for (const QJsonValue value : frames) {
      if (listed >= kMaxOmittedFramesListed) {
        cut = true;
        break;
      }
      const QString url = oneLine(value.toString(), kMaxUrlChars);
      if (url.isEmpty()) {
        continue;
      }
      outline += QStringLiteral("    - %1\n").arg(url);
      ++listed;
    }
    if (cut) {
      outline += QStringLiteral("    ... (more omitted frames)\n");
    }
    return;
  }
  if (capture.value(QStringLiteral("iframesOmitted")).toBool()) {
    outline += QStringLiteral("  ... (cross-origin iframe content is not "
                              "included in this snapshot)\n");
  }
}

// -- Shown lines: slimming, options, elision, find ---------------------------

// One renderable capture record, before slimming decides whether it shows.
struct RawLine {
  QJsonObject node;
  QString role;
  QString name;
  QString ref;
  int raw_depth{0};
  bool interactable{false};
};

// A record's line: role, name, ref and state, without indentation. role is
// untrusted, so it arrives escaped and capped like name: a hostile role cannot
// inject newlines, brackets or quotes and forge outline lines or [ref=]
// entries.
QString nodeLineText(const RawLine &raw) {
  QString line = QStringLiteral("- ") + raw.role;
  if (!raw.name.isEmpty()) {
    line += QStringLiteral(" \"") + raw.name + QLatin1Char('"');
  }
  if (!raw.ref.isEmpty()) {
    line += QStringLiteral(" [ref=") + raw.ref + QLatin1Char(']');
  }
  const QString suffix = stateSuffix(raw.node);
  if (!suffix.isEmpty()) {
    line += QLatin1Char(' ') + suffix;
  }
  return line;
}

// A text record that only repeats words its parent's name already says: a
// link "Send message" with a text child "Send message", or the inline text
// runs Chrome splits a text node into. The parent carries the words (and the
// ref); the child adds nothing but a line. Compared on the page's own names,
// not the capped ones the outline prints, so a long label still matches.
bool repeatsParentName(const RawLine &line, const RawLine &parent) {
  const bool text = line.role == QLatin1String("statictext") ||
                    line.role == QLatin1String("inlinetextbox");
  if (!text || !line.ref.isEmpty()) {
    return false;
  }
  // An inline run is one laid-out line of its text node, by definition part
  // of it -- however long the text, and however its name was capped.
  if (line.role == QLatin1String("inlinetextbox") &&
      parent.role == QLatin1String("statictext")) {
    return true;
  }
  const QString words =
      line.node.value(QStringLiteral("name")).toString().simplified();
  const QString said =
      parent.node.value(QStringLiteral("name")).toString().simplified();
  return !words.isEmpty() && !said.isEmpty() &&
         said.contains(words, Qt::CaseInsensitive);
}

// An unnamed, stateless record with no ref and nothing to act on: a wrapper.
// One holding a single shown line folds into it.
bool isBareWrapper(const RawLine &line) {
  return line.ref.isEmpty() && !line.interactable && line.name.isEmpty() &&
         !roleIsHeading(line.role) && !roleIsContainer(line.role) &&
         stateSuffix(line.node).isEmpty();
}

QString indentFor(int depth) {
  return QString(static_cast<qsizetype>(depth) * kSpacesPerIndentLevel,
                 QLatin1Char(' '));
}

// Each record's nearest renderable ancestor, from the raw depths: records
// arrive in document (pre-)order, so the ancestors are the open stack.
QVector<qsizetype> rawParents(const QVector<RawLine> &raw) {
  QVector<qsizetype> parent(raw.size(), -1);
  QVector<qsizetype> open;
  for (qsizetype i = 0; i < raw.size(); ++i) {
    while (!open.isEmpty() &&
           raw.at(open.last()).raw_depth >= raw.at(i).raw_depth) {
      open.removeLast();
    }
    parent.replace(i, open.isEmpty() ? -1 : open.last());
    open.append(i);
  }
  return parent;
}

// The renderable records as the lines a snapshot shows. Two rules remove only
// repetition -- text that repeats its parent's name, and wrappers holding a
// single shown line -- and indentation then counts shown ancestors, not the
// page's raw nesting, which reached 40 spaces under dropped wrappers.
QVector<SnapshotLine> slimLines(const QVector<RawLine> &raw) {
  const qsizetype count = raw.size();
  const QVector<qsizetype> parent = rawParents(raw);
  QVector<bool> shown(count, true);
  for (qsizetype i = 0; i < count; ++i) {
    shown.replace(i, parent.at(i) < 0 ||
                         !repeatsParentName(raw.at(i), raw.at(parent.at(i))));
  }
  const auto shownParent = [&parent, &shown](qsizetype i) {
    qsizetype up = parent.at(i);
    while (up >= 0 && !shown.at(up)) {
      up = parent.at(up);
    }
    return up;
  };
  QVector<int> children(count, 0);
  for (qsizetype i = 0; i < count; ++i) {
    const qsizetype up = shown.at(i) ? shownParent(i) : -1;
    if (up >= 0) {
      children.replace(up, children.at(up) + 1);
    }
  }
  for (qsizetype i = 0; i < count; ++i) {
    if (children.at(i) == 1 && isBareWrapper(raw.at(i))) {
      shown.replace(i, false);
    }
  }
  QVector<SnapshotLine> lines;
  QVector<qsizetype> line_of(count, -1);
  for (qsizetype i = 0; i < count; ++i) {
    if (!shown.at(i)) {
      continue;
    }
    const qsizetype up = shownParent(i);
    SnapshotLine line;
    line.text = nodeLineText(raw.at(i));
    line.role = raw.at(i).role;
    line.name = raw.at(i).name;
    line.value =
        oneLine(raw.at(i).node.value(QStringLiteral("value")).toString(),
                kMaxValueChars);
    line.ref = raw.at(i).ref;
    line.parent = up < 0 ? -1 : line_of.at(up);
    line.depth =
        up < 0 ? 0
               : std::min(lines.at(line_of.at(up)).depth + 1, kMaxIndentDepth);
    line.interactable = raw.at(i).interactable;
    line.offscreen = raw.at(i).node.value(QStringLiteral("offscreen")).toBool();
    line_of.replace(i, lines.size());
    lines.append(line);
  }
  return lines;
}

// One line of an outline being built: which snapshot line, under which entry,
// at what depth here, and its text with indentation and newline.
struct OutlineEntry {
  qsizetype line{0};
  qsizetype parent{-1};
  int depth{0};
  QString rendered;
};

// Each entry's subtree end, one past its last descendant, from the depths.
QVector<qsizetype> subtreeEnds(const QVector<OutlineEntry> &entries) {
  const qsizetype count = entries.size();
  QVector<qsizetype> ends(count, count);
  QVector<qsizetype> open;
  for (qsizetype i = 0; i < count; ++i) {
    while (!open.isEmpty() &&
           entries.at(open.last()).depth >= entries.at(i).depth) {
      ends.replace(open.last(), i);
      open.removeLast();
    }
    open.append(i);
  }
  return ends;
}

// What a collapsed region's line says about the lines it stands for, and how
// to reach them.
QString omittedStub(qsizetype hidden, const QString &ref) {
  if (ref.isEmpty()) {
    return QStringLiteral(" (%1 lines omitted; browser_find reaches them)")
        .arg(hidden);
  }
  return QStringLiteral(
             " (%1 lines omitted: browser_snapshot ref=%2, or browser_find)")
      .arg(QString::number(hidden), ref);
}

// Which entries an elided outline keeps whatever it costs: the lines on
// screen -- or, with no positions, the top half of the budget -- every
// landmark and heading, and the ancestors of each.
QVector<bool> elisionKeeps(const QVector<OutlineEntry> &entries,
                           const SnapshotView &view, int max_chars) {
  const qsizetype count = entries.size();
  QVector<bool> kept(count, false);
  qsizetype running = 0;
  for (qsizetype i = 0; i < count; ++i) {
    const SnapshotLine &line = view.lines.at(entries.at(i).line);
    const bool on_screen =
        view.positions ? !line.offscreen : running < max_chars / 2;
    running += entries.at(i).rendered.size();
    if (on_screen || roleIsLandmark(line.role) || roleIsHeading(line.role)) {
      for (qsizetype up = i; up >= 0 && !kept.at(up);
           up = entries.at(up).parent) {
        kept.replace(up, true);
      }
    }
  }
  return kept;
}

// One way to shorten an elided outline: hide entries [first, end) behind a
// stub. A region's stub rides on its own first line (`own_line` false, the
// region's root is `anchor`); a run of sibling regions under one parent gets a
// stub line of its own (`own_line` true, the parent is `anchor`, -1 at the
// top). `saved` is the characters it takes off.
struct Elision {
  qsizetype first{0};
  qsizetype end{0};
  qsizetype anchor{-1};
  qsizetype saved{0};
  bool own_line{false};
};

// The ref a stub names: the region's root, or the parent of a run.
QString elisionRef(const QVector<OutlineEntry> &entries,
                   const SnapshotView &view, const Elision &elision) {
  return elision.anchor < 0
             ? QString()
             : view.lines.at(entries.at(elision.anchor).line).ref;
}

// Every region and every run of sibling regions that holds none of what
// elisionKeeps names, with what hiding it would save.
QVector<Elision> elisionCandidates(const QVector<OutlineEntry> &entries,
                                   const SnapshotView &view,
                                   const QVector<qsizetype> &ends,
                                   const QVector<qsizetype> &kept_before,
                                   const QVector<qsizetype> &chars_before) {
  const qsizetype count = entries.size();
  const auto free_of_kept = [&kept_before](qsizetype from, qsizetype to) {
    return kept_before.at(to) == kept_before.at(from);
  };
  QVector<Elision> candidates;
  const auto consider = [&](Elision elision) {
    const qsizetype stub =
        omittedStub(elision.end - elision.first,
                    elisionRef(entries, view, elision))
            .size() +
        (elision.own_line
             ? entries.at(elision.first).depth * kSpacesPerIndentLevel + 6
             : 0);
    elision.saved =
        chars_before.at(elision.end) - chars_before.at(elision.first) - stub;
    if (elision.saved > 0) {
      candidates.append(elision);
    }
  };
  for (qsizetype i = 0; i < count; ++i) {
    if (ends.at(i) - i >= 2 && free_of_kept(i + 1, ends.at(i))) {
      consider({i + 1, ends.at(i), i, 0, false});
    }
  }
  // Runs: consecutive children of one parent, each wholly free of kept
  // lines. Parents in document order, so equal savings break the same way on
  // every run.
  QMap<qsizetype, QVector<qsizetype>> children;
  for (qsizetype i = 0; i < count; ++i) {
    auto kids = children.find(entries.at(i).parent);
    if (kids == children.end()) {
      kids = children.insert(entries.at(i).parent, {});
    }
    kids->append(i);
  }
  for (auto it = children.cbegin(); it != children.cend(); ++it) {
    qsizetype run_first = -1;
    qsizetype run_end = -1;
    int run_children = 0;
    const auto close_run = [&]() {
      // One child alone is its own region, which keeps its line and names
      // its own ref; a run is two siblings or more.
      if (run_first >= 0 && run_children >= 2) {
        consider({run_first, run_end, it.key(), 0, true});
      }
      run_first = -1;
    };
    for (const qsizetype child : it.value()) {
      if (free_of_kept(child, ends.at(child))) {
        if (run_first < 0) {
          run_first = child;
          run_children = 0;
        }
        run_end = ends.at(child);
        ++run_children;
      } else {
        close_run();
      }
    }
    close_run();
  }
  return candidates;
}

// Fit an outline to max_chars without cutting it at the tail: what
// elisionKeeps names stays, and the largest regions -- or runs of sibling
// regions -- holding none of it collapse to one line with a count and a way
// in. Only when what must stay is itself over the cap is the rest cut, at a
// line boundary, saying so.
QString elideOutline(const QVector<OutlineEntry> &entries,
                     const SnapshotView &view, int max_chars) {
  const qsizetype count = entries.size();
  const QVector<qsizetype> ends = subtreeEnds(entries);
  const QVector<bool> kept = elisionKeeps(entries, view, max_chars);
  QVector<qsizetype> kept_before(count + 1, 0);
  QVector<qsizetype> chars_before(count + 1, 0);
  for (qsizetype i = 0; i < count; ++i) {
    kept_before.replace(i + 1, kept_before.at(i) + (kept.at(i) ? 1 : 0));
    chars_before.replace(i + 1,
                         chars_before.at(i) + entries.at(i).rendered.size());
  }
  QVector<Elision> candidates =
      elisionCandidates(entries, view, ends, kept_before, chars_before);
  // Largest first: anything holding another candidate saves more than it, so
  // the outer one collapses and the ones inside are never counted twice.
  std::stable_sort(
      candidates.begin(), candidates.end(),
      [](const Elision &a, const Elision &b) { return a.saved > b.saved; });
  qsizetype total = chars_before.at(count);
  QVector<bool> hidden(count, false);
  QVector<qsizetype> tail_stub(count, -1);
  QVector<qsizetype> line_stub(count, -1);
  for (qsizetype c = 0; c < candidates.size(); ++c) {
    const Elision &elision = candidates.at(c);
    if (total <= max_chars) {
      break;
    }
    if (hidden.at(elision.first) ||
        (!elision.own_line && hidden.at(elision.anchor))) {
      continue;
    }
    std::fill(hidden.begin() + elision.first, hidden.begin() + elision.end,
              true);
    if (elision.own_line) {
      line_stub.replace(elision.first, c);
    } else {
      tail_stub.replace(elision.anchor, c);
    }
    total -= elision.saved;
  }
  const auto stubFor = [&](qsizetype c) {
    const Elision &elision = candidates.at(c);
    return omittedStub(elision.end - elision.first,
                       elisionRef(entries, view, elision));
  };
  QString text;
  for (qsizetype i = 0; i < count; ++i) {
    if (line_stub.at(i) >= 0) {
      text += indentFor(entries.at(i).depth) + QStringLiteral("- ...") +
              stubFor(line_stub.at(i)) + QLatin1Char('\n');
    }
    if (hidden.at(i)) {
      continue;
    }
    if (tail_stub.at(i) >= 0) {
      text += entries.at(i).rendered.chopped(1) + stubFor(tail_stub.at(i)) +
              QLatin1Char('\n');
    } else {
      text += entries.at(i).rendered;
    }
  }
  if (text.size() > max_chars) {
    const qsizetype cut = text.lastIndexOf(QLatin1Char('\n'), max_chars - 1);
    const qsizetype keep = cut < 0 ? 0 : cut + 1;
    const qsizetype rest = text.mid(keep).count(QLatin1Char('\n'));
    text = text.left(keep) +
           QStringLiteral("  ... (%1 more lines: narrow with browser_snapshot "
                          "ref or filter, or raise max_chars)\n")
               .arg(rest);
  }
  return text + QStringLiteral("  ... (shortened to fit max_chars %1: "
                               "browser_snapshot ref=<a region> reads one "
                               "part, browser_find locates an element)\n")
                    .arg(max_chars);
}

// Roles a find names in words: "field" means any text entry, "menu" any menu
// item. A role word not listed here matches only itself.
const QHash<QString, QStringList> &roleWords() {
  static const QStringList kEntry{
      QStringLiteral("textbox"), QStringLiteral("searchbox"),
      QStringLiteral("combobox"), QStringLiteral("spinbutton")};
  static const QStringList kChoice{QStringLiteral("combobox"),
                                   QStringLiteral("listbox")};
  static const QHash<QString, QStringList> kWords{
      {QStringLiteral("button"), {QStringLiteral("button")}},
      {QStringLiteral("link"), {QStringLiteral("link")}},
      {QStringLiteral("field"), kEntry},
      {QStringLiteral("input"), kEntry},
      {QStringLiteral("textbox"), kEntry},
      {QStringLiteral("checkbox"), {QStringLiteral("checkbox")}},
      {QStringLiteral("radio"), {QStringLiteral("radio")}},
      {QStringLiteral("tab"), {QStringLiteral("tab")}},
      {QStringLiteral("menu"),
       {QStringLiteral("menu"), QStringLiteral("menuitem"),
        QStringLiteral("menuitemcheckbox"), QStringLiteral("menuitemradio")}},
      {QStringLiteral("heading"), {QStringLiteral("heading")}},
      {QStringLiteral("image"),
       {QStringLiteral("image"), QStringLiteral("img")}},
      {QStringLiteral("dropdown"), kChoice},
      {QStringLiteral("select"), kChoice},
      {QStringLiteral("option"), {QStringLiteral("option")}},
      {QStringLiteral("switch"), {QStringLiteral("switch")}},
      {QStringLiteral("slider"), {QStringLiteral("slider")}},
      {QStringLiteral("dialog"),
       {QStringLiteral("dialog"), QStringLiteral("alertdialog")}}};
  return kWords;
}

// The role word @p word stands for, plural or not; empty when it is not one.
QString roleWordKey(const QString &word) {
  if (roleWords().contains(word)) {
    return word;
  }
  if (word.endsWith(QLatin1Char('s')) &&
      roleWords().contains(word.chopped(1))) {
    return word.chopped(1);
  }
  return {};
}

QSet<QString> rolesFor(const QString &role) {
  const QString key = roleWordKey(role);
  if (key.isEmpty()) {
    return {role};
  }
  const QStringList &roles = roleWords().value(key);
  return {roles.cbegin(), roles.cend()};
}

QString normalized(const QString &text) {
  return text.simplified().toCaseFolded();
}

QStringList wordsOf(const QString &text) {
  static const QRegularExpression kBetweenWords(
      QStringLiteral("[^\\p{L}\\p{N}]+"),
      QRegularExpression::UseUnicodePropertiesOption);
  return text.split(kBetweenWords, Qt::SkipEmptyParts);
}

// Whether the match of @p length at @p at in @p haystack starts and ends on a
// word boundary.
bool wordBounded(const QString &haystack, qsizetype at, qsizetype length) {
  const qsizetype after = at + length;
  return (at == 0 || !haystack.at(at - 1).isLetterOrNumber()) &&
         (after >= haystack.size() || !haystack.at(after).isLetterOrNumber());
}

// How well a normalised name matches a normalised needle: whole name, start,
// a whole word, anywhere; and for a phrase, how many of its words the name
// has. Zero is no match.
int nameScore(const QString &name, const QString &needle, bool natural) {
  if (name.isEmpty() || needle.isEmpty()) {
    return 0;
  }
  if (name == needle) {
    return kScoreExact;
  }
  if (name.startsWith(needle)) {
    return kScorePrefix;
  }
  const qsizetype at = name.indexOf(needle);
  if (at >= 0) {
    return wordBounded(name, at, needle.size()) ? kScoreWord : kScoreSubstring;
  }
  if (!natural) {
    return 0;
  }
  QStringList wanted = wordsOf(needle);
  wanted.removeIf(
      [](const QString &word) { return word.size() < kMinOverlapWordChars; });
  if (wanted.isEmpty()) {
    return 0;
  }
  const QStringList have = wordsOf(name);
  const auto matched = std::count_if(
      wanted.cbegin(), wanted.cend(),
      [&have](const QString &word) { return have.contains(word); });
  if (matched * 2 < wanted.size()) {
    return 0;
  }
  return kScoreOverlapBase +
         static_cast<int>(kScoreOverlapSpan * matched / wanted.size());
}

struct FindMatch {
  qsizetype line{0};
  int score{0};
};

// Every line matching the needle (or the pattern), within @p roles when any
// are given, best first and in page order among equals.
QVector<FindMatch> matchLines(const SnapshotView &view, const QString &needle,
                              bool natural, const QRegularExpression *pattern,
                              const QSet<QString> &roles) {
  QVector<FindMatch> matches;
  for (qsizetype i = 0; i < view.lines.size(); ++i) {
    const SnapshotLine &line = view.lines.at(i);
    if (!roles.isEmpty() && !roles.contains(line.role)) {
      continue;
    }
    int score = 0;
    if (pattern != nullptr) {
      if (pattern->match(line.name).hasMatch()) {
        score = kScoreRegex;
      } else if (!line.value.isEmpty() &&
                 pattern->match(line.value).hasMatch()) {
        score = kScoreValue;
      }
    } else if (needle.isEmpty()) {
      score = kScoreRoleOnly;
    } else {
      score = nameScore(normalized(line.name), needle, natural);
      if (score == 0 && normalized(line.value).contains(needle)) {
        score = kScoreValue;
      }
    }
    if (score == 0) {
      continue;
    }
    if (!line.ref.isEmpty()) {
      score += kBoostActionable;
    }
    if (view.positions && !line.offscreen) {
      score += kBoostOnScreen;
    }
    matches.append({i, score});
  }
  std::stable_sort(
      matches.begin(), matches.end(),
      [](const FindMatch &a, const FindMatch &b) { return a.score > b.score; });
  return matches;
}

// Where a match sits: off-screen when it is, then up to three containers above
// it, nearest first.
QString findContext(const SnapshotView &view, qsizetype at) {
  QStringList parts;
  for (qsizetype up = view.lines.at(at).parent;
       up >= 0 && parts.size() < kFindContextAncestors;
       up = view.lines.at(up).parent) {
    const SnapshotLine &line = view.lines.at(up);
    if (!roleIsContext(line.role)) {
      continue;
    }
    QString part = line.role;
    if (!line.name.isEmpty()) {
      part += QStringLiteral(" \"") + line.name + QLatin1Char('"');
    }
    if (!line.ref.isEmpty()) {
      part += QStringLiteral(" [ref=") + line.ref + QLatin1Char(']');
    }
    parts.append(part);
  }
  QString context = parts.isEmpty() ? QString()
                                    : QStringLiteral("in: ") +
                                          parts.join(QStringLiteral(" > "));
  if (view.positions && view.lines.at(at).offscreen) {
    context = context.isEmpty() ? QStringLiteral("off-screen")
                                : QStringLiteral("off-screen; ") + context;
  }
  return context;
}

// The share of character pairs two strings have in common (Dice's
// coefficient): 1 for the same text, 0 for nothing alike.
double pairSimilarity(const QString &a, const QString &b) {
  if (a.size() < 2 || b.size() < 2) {
    return a == b ? 1.0 : 0.0;
  }
  QHash<QString, int> pairs;
  for (qsizetype i = 0; i + 1 < a.size(); ++i) {
    const QString pair = a.mid(i, 2);
    pairs.insert(pair, pairs.value(pair) + 1);
  }
  int shared = 0;
  for (qsizetype i = 0; i + 1 < b.size(); ++i) {
    const auto it = pairs.find(b.mid(i, 2));
    if (it != pairs.end() && it.value() > 0) {
      --it.value();
      ++shared;
    }
  }
  return 2.0 * shared / static_cast<double>(a.size() + b.size() - 2);
}

// The names on the page nearest to what a find looked for, as a sentence;
// empty when nothing is near.
QString closestNames(const SnapshotView &view, const QString &needle) {
  struct Near {
    QString name;
    double similarity{0.0};
  };
  QVector<Near> near;
  QSet<QString> seen;
  for (const SnapshotLine &line : view.lines) {
    const QString name = normalized(line.name);
    if (name.isEmpty() || seen.contains(name)) {
      continue;
    }
    seen.insert(name);
    const double similarity = pairSimilarity(name, needle);
    if (similarity > 0.0) {
      near.append({line.name, similarity});
    }
  }
  std::stable_sort(near.begin(), near.end(), [](const Near &a, const Near &b) {
    return a.similarity > b.similarity;
  });
  QStringList names;
  for (qsizetype i = 0; i < std::min(near.size(), kClosestNames); ++i) {
    names.append(QLatin1Char('"') + near.at(i).name + QLatin1Char('"'));
  }
  return names.isEmpty()
             ? QString()
             : QStringLiteral("Closest names: ") +
                   names.join(QStringLiteral(", ")) + QStringLiteral(". ");
}

// How a find names what it looked for, in its own replies.
QString describeFind(const FindQuery &query) {
  QString what =
      !query.regex.isEmpty()
          ? QStringLiteral("regex /") + query.regex + QLatin1Char('/')
          : (query.natural ? QStringLiteral("query \"")
                           : QStringLiteral("text \"")) +
                query.text + QLatin1Char('"');
  if (!query.role.isEmpty()) {
    what += QStringLiteral(" with role ") + query.role;
  }
  return what;
}

} // namespace

bool commandIsTabScoped(const QString &cmd) {
  return tabScopedCommands().contains(cmd);
}

bool tabIdFromJson(const QJsonValue &value, qint64 *out) {
  qint64 id = 0;
  if (!asBackendId(value, &id) || id > std::numeric_limits<int>::max()) {
    return false;
  }
  *out = id;
  return true;
}

SnapshotView renderSnapshot(const QJsonObject &capture) {
  return renderSnapshot(capture, QJsonObject{}, 1);
}

SnapshotView renderSnapshot(const QJsonObject &capture,
                            const QJsonObject &carried_index) {
  return renderSnapshot(capture, carried_index, 1);
}

SnapshotView renderSnapshot(const QJsonObject &capture,
                            const QJsonObject &carried_index,
                            qint64 first_new_ref) {
  SnapshotView view;
  view.url =
      oneLine(capture.value(QStringLiteral("url")).toString(), kMaxUrlChars);
  view.title = oneLine(capture.value(QStringLiteral("title")).toString(),
                       kMaxTitleChars);
  view.positions = capture.value(QStringLiteral("viewport")).isObject();

  QJsonObject ref_index;
  // A ref names a NODE, not a position. The outline is rebuilt on every
  // snapshot, and numbering purely by document order means an element that
  // gains a ref-worthy sibling above it answers to a different ref in the next
  // snapshot -- while every ref the model is still holding resolves silently,
  // to the wrong element. The previous snapshot's index is therefore carried in
  // by backendNodeId: a node seen before keeps the ref it was issued, and only
  // a genuinely new node takes a new number.
  QHash<qint64, QString> carried;
  QSet<QString> taken;
  for (auto it = carried_index.begin(); it != carried_index.end(); ++it) {
    qint64 carried_id = 0;
    if (asBackendId(
            it.value().toObject().value(QStringLiteral("backendNodeId")),
            &carried_id)) {
      carried.insert(carried_id, it.key());
      // Reserved whether or not that node is still here: a fresh number that
      // collided with a carried ref appearing later in the document would hand
      // two nodes the same name.
      taken.insert(it.key());
    }
  }
  // The last number issued; the first new node takes the one after it. Never
  // below e1, and never below the caller's floor, so a name the session issued
  // earlier and has since dropped cannot come back on a different node.
  qint64 next_ref = std::max<qint64>(first_new_ref, 1) - 1;
  int emitted = 0;
  // The extension caps its own node walk and marks the capture truncated; honor
  // that marker so the model is told the outline is partial even though our
  // local emitted count never reaches kMaxNodes for an already-capped capture.
  // A page-derived bool consumed only to append a fixed literal note -- no
  // injection surface.
  bool truncated = capture.value(QStringLiteral("truncated")).toBool();
  const QJsonArray nodes = capture.value(QStringLiteral("nodes")).toArray();
  QVector<RawLine> raw;
  int scanned = 0;
  for (const QJsonValue value : nodes) {
    if (scanned >= kMaxScanNodes) {
      // A capture padded past the scan bound: stop and tell the model the
      // outline is partial rather than iterate an attacker-chosen node count.
      truncated = true;
      break;
    }
    ++scanned;
    const QJsonObject node = value.toObject();
    const bool interactable =
        node.value(QStringLiteral("interactable")).toBool();
    const QString name =
        escapeName(node.value(QStringLiteral("name")).toString());
    if (!nodeIsRenderable(node, interactable, name)) {
      continue;
    }
    if (emitted >= kMaxNodes) {
      truncated = true;
      break;
    }
    // An interactable OR value-bearing node, or a container, with a valid
    // integer backendNodeId gets a ref; otherwise it is shown for context but
    // cannot be acted on.
    qint64 backend_id = 0;
    QString ref;
    if (nodeIsRefWorthy(node, interactable) &&
        asBackendId(node.value(QStringLiteral("backendNodeId")), &backend_id)) {
      ref = carried.value(backend_id);
      if (ref.isEmpty()) {
        // Only a node never seen takes a new number, and it steps over every
        // name a carried ref has reserved. The carried name itself is already
        // in `taken`, so this must not be a plain "while taken" over both --
        // that would throw away the very ref this is here to preserve.
        ref = QStringLiteral("e%1").arg(++next_ref);
        while (taken.contains(ref)) {
          ref = QStringLiteral("e%1").arg(++next_ref);
        }
      }
      taken.insert(ref);
      view.highest_ref = std::max(view.highest_ref, refNumber(ref));
      ++view.element_count;
      ref_index.insert(
          ref, QJsonObject{{QStringLiteral("backendNodeId"), backend_id},
                           {QStringLiteral("role"),
                            node.value(QStringLiteral("role")).toString()},
                           {QStringLiteral("name"), name}});
    }
    QString role = escapeName(node.value(QStringLiteral("role")).toString());
    if (role.isEmpty()) {
      role = QStringLiteral("generic");
    }
    raw.append({node, role, name, ref,
                std::max(0, node.value(QStringLiteral("depth")).toInt(0)),
                interactable});
    ++emitted;
  }
  QString notes;
  if (truncated) {
    notes += QStringLiteral(
        "  ... (more elements omitted; the page is very large: browser_find "
        "searches what was captured, browser_snapshot ref reads one part)\n");
  }
  // The single-pass capture does not reach cross-origin (out-of-process)
  // iframes; when the extension reports them, name the omitted frames so the
  // model can navigate into them rather than treat the snapshot as the whole
  // page.
  appendOmittedFramesNote(capture, notes);

  view.lines = slimLines(raw);
  const QString outline =
      std::accumulate(view.lines.cbegin(), view.lines.cend(), QString(),
                      [](QString text, const SnapshotLine &line) {
                        return std::move(text) + indentFor(line.depth) +
                               line.text + QLatin1Char('\n');
                      });
  view.outline = outline + notes;
  view.notes = std::move(notes);
  view.ref_index = std::move(ref_index);
  return view;
}

QString outlineOptionsFrom(const QJsonObject &arguments, OutlineOptions *out) {
  OutlineOptions options;
  options.ref = arguments.value(QStringLiteral("ref")).toString();
  if (arguments.contains(QStringLiteral("depth"))) {
    const int depth = arguments.value(QStringLiteral("depth")).toInt(-1);
    if (depth < 0 || depth > kMaxOutlineDepth) {
      return QStringLiteral("depth must be between 0 and %1.")
          .arg(kMaxOutlineDepth);
    }
    options.depth = depth;
  }
  if (arguments.contains(QStringLiteral("filter"))) {
    const QString filter = arguments.value(QStringLiteral("filter")).toString();
    if (filter != QLatin1String("all") &&
        filter != QLatin1String("interactive") &&
        filter != QLatin1String("viewport")) {
      return QStringLiteral(
          "filter must be \"all\", \"interactive\" or \"viewport\".");
    }
    options.filter = filter == QLatin1String("all") ? QString() : filter;
  }
  if (arguments.contains(QStringLiteral("max_chars"))) {
    const int max_chars = arguments.value(QStringLiteral("max_chars")).toInt(0);
    if (max_chars < kMinOutlineChars || max_chars > kMaxOutlineChars) {
      return QStringLiteral("max_chars must be between %1 and %2.")
          .arg(kMinOutlineChars)
          .arg(kMaxOutlineChars);
    }
    options.max_chars = max_chars;
  }
  *out = std::move(options);
  return {};
}

Outline renderOutline(const SnapshotView &view, const OutlineOptions &options) {
  Outline out;
  const qsizetype count = view.lines.size();
  out.total = static_cast<int>(count);
  QVector<bool> chosen(count, true);
  int base = 0;
  if (!options.ref.isEmpty()) {
    const auto root = std::find_if(view.lines.cbegin(), view.lines.cend(),
                                   [&options](const SnapshotLine &line) {
                                     return line.ref == options.ref;
                                   });
    if (root == view.lines.cend()) {
      out.error = QStringLiteral("Element ref '") + options.ref +
                  QStringLiteral("' is not shown on the page any more; call "
                                 "browser_snapshot without ref, or "
                                 "browser_find.");
      return out;
    }
    const qsizetype at = root - view.lines.cbegin();
    base = root->depth;
    qsizetype end = at + 1;
    while (end < count && view.lines.at(end).depth > base) {
      ++end;
    }
    for (qsizetype i = 0; i < count; ++i) {
      chosen.replace(i, i >= at && i < end);
    }
  }
  qsizetype off_screen = 0;
  if (options.filter == QLatin1String("viewport") && !view.positions) {
    out.error = QStringLiteral(
        "This Chrome extension is older than the server and does not say "
        "where elements are, so filter \"viewport\" cannot be applied. Reload "
        "Chrome Control MCP at chrome://extensions, or use filter "
        "\"interactive\".");
    return out;
  }
  for (qsizetype i = 0; i < count; ++i) {
    const SnapshotLine &line = view.lines.at(i);
    if (!chosen.at(i)) {
      continue;
    }
    if (options.depth >= 0 && line.depth - base > options.depth) {
      chosen.replace(i, false);
    } else if (options.filter == QLatin1String("interactive")) {
      chosen.replace(i, !line.ref.isEmpty() || roleIsHeading(line.role));
    } else if (options.filter == QLatin1String("viewport") && line.offscreen) {
      chosen.replace(i, false);
      ++off_screen;
    }
  }
  QVector<OutlineEntry> entries;
  QVector<qsizetype> entry_of(count, -1);
  for (qsizetype i = 0; i < count; ++i) {
    if (!chosen.at(i)) {
      continue;
    }
    qsizetype up = view.lines.at(i).parent;
    while (up >= 0 && !chosen.at(up)) {
      up = view.lines.at(up).parent;
    }
    OutlineEntry entry;
    entry.line = i;
    entry.parent = up < 0 ? -1 : entry_of.at(up);
    entry.depth = up < 0 ? 0
                         : std::min(entries.at(entry_of.at(up)).depth + 1,
                                    kMaxIndentDepth);
    entry.rendered =
        indentFor(entry.depth) + view.lines.at(i).text + QLatin1Char('\n');
    entry_of.replace(i, entries.size());
    entries.append(entry);
  }
  out.shown = static_cast<int>(entries.size());
  QString text = std::accumulate(entries.cbegin(), entries.cend(), QString(),
                                 [](QString joined, const OutlineEntry &entry) {
                                   return std::move(joined) + entry.rendered;
                                 });
  if (options.max_chars > 0 && text.size() > options.max_chars) {
    text = elideOutline(entries, view, options.max_chars);
  }
  if (off_screen > 0) {
    text += QStringLiteral("  ... (%1 lines off-screen: browser_snapshot "
                           "without filter, or browser_find)\n")
                .arg(off_screen);
  }
  out.text = text + view.notes;
  return out;
}

QString findQueryFrom(const QJsonObject &arguments, FindQuery *out) {
  FindQuery query;
  const QString text =
      arguments.value(QStringLiteral("text")).toString().trimmed();
  const QString phrase =
      arguments.value(QStringLiteral("query")).toString().trimmed();
  const QString pattern = arguments.value(QStringLiteral("regex")).toString();
  const int given = static_cast<int>(!text.isEmpty()) +
                    static_cast<int>(!phrase.isEmpty()) +
                    static_cast<int>(!pattern.isEmpty());
  if (given == 0) {
    return QStringLiteral(
        "browser_find needs one of text (the words to look for), query (the "
        "same as a phrase, where a role word such as \"button\" or \"link\" "
        "filters by role) or regex (a pattern).");
  }
  if (given > 1) {
    return QStringLiteral(
        "Give browser_find one of text, query or regex, not several.");
  }
  query.text = text.isEmpty() ? phrase : text;
  query.natural = !phrase.isEmpty();
  query.regex = pattern;
  if (query.text.size() > kMaxFindTextChars ||
      query.regex.size() > kMaxFindTextChars) {
    return QStringLiteral(
               "browser_find takes at most %1 characters; look for a shorter "
               "part of the name.")
        .arg(kMaxFindTextChars);
  }
  if (!query.regex.isEmpty()) {
    const QRegularExpression compiled(
        query.regex, QRegularExpression::CaseInsensitiveOption |
                         QRegularExpression::UseUnicodePropertiesOption);
    if (!compiled.isValid()) {
      return QStringLiteral("regex does not compile: %1 (at character %2).")
          .arg(compiled.errorString(),
               QString::number(compiled.patternErrorOffset()));
    }
  }
  query.role =
      arguments.value(QStringLiteral("role")).toString().trimmed().toLower();
  if (query.role.size() > kMaxFindRoleChars) {
    return QStringLiteral("role takes at most %1 characters.")
        .arg(kMaxFindRoleChars);
  }
  if (arguments.contains(QStringLiteral("max_results"))) {
    const int max_results =
        arguments.value(QStringLiteral("max_results")).toInt(0);
    if (max_results < 1 || max_results > kMaxFindResults) {
      return QStringLiteral("max_results must be between 1 and %1.")
          .arg(kMaxFindResults);
    }
    query.max_results = max_results;
  }
  *out = std::move(query);
  return {};
}

QString renderFind(const SnapshotView &view, const FindQuery &query) {
  QSet<QString> roles =
      query.role.isEmpty() ? QSet<QString>{} : rolesFor(query.role);
  QString needle = normalized(query.text);
  if (query.natural) {
    QStringList words;
    for (const QString &word :
         needle.split(QLatin1Char(' '), Qt::SkipEmptyParts)) {
      const QString key = roleWordKey(word);
      if (key.isEmpty()) {
        words.append(word);
      } else {
        roles.unite(rolesFor(key));
      }
    }
    needle = words.join(QLatin1Char(' '));
  }
  std::optional<QRegularExpression> pattern;
  if (!query.regex.isEmpty()) {
    pattern.emplace(query.regex,
                    QRegularExpression::CaseInsensitiveOption |
                        QRegularExpression::UseUnicodePropertiesOption);
  }
  QVector<FindMatch> matches =
      matchLines(view, needle, query.natural,
                 pattern.has_value() ? &*pattern : nullptr, roles);
  // A role word can be part of the name itself ("Image settings"): with
  // nothing found under the role it implied, look again by the whole phrase.
  if (matches.isEmpty() && query.natural && query.role.isEmpty() &&
      !roles.isEmpty()) {
    matches = matchLines(view, normalized(query.text), true, nullptr, {});
  }
  const QString what = describeFind(query);
  if (matches.isEmpty()) {
    return QStringLiteral("No element matches ") + what + QStringLiteral(". ") +
           closestNames(view,
                        needle.isEmpty() ? normalized(query.text) : needle) +
           QStringLiteral("Try fewer words, or browser_snapshot with filter "
                          "\"interactive\".\n") +
           view.notes;
  }
  const qsizetype shown =
      std::min<qsizetype>(matches.size(), query.max_results);
  QString text = QStringLiteral("Found %1 %2 for ")
                     .arg(QString::number(matches.size()),
                          matches.size() == 1 ? QStringLiteral("match")
                                              : QStringLiteral("matches")) +
                 what +
                 (shown < matches.size()
                      ? QStringLiteral(" (showing the best %1):\n").arg(shown)
                      : QStringLiteral(":\n"));
  for (qsizetype k = 0; k < shown; ++k) {
    const qsizetype at = matches.at(k).line;
    text += view.lines.at(at).text + QLatin1Char('\n');
    const QString context = findContext(view, at);
    if (!context.isEmpty()) {
      text += QStringLiteral("    ") + context + QLatin1Char('\n');
    }
  }
  return text + view.notes;
}

QString readRequestFrom(const QJsonObject &arguments, ReadRequest *out) {
  ReadRequest request;
  if (arguments.contains(QStringLiteral("offset"))) {
    const qint64 offset =
        arguments.value(QStringLiteral("offset")).toInteger(-1);
    if (offset < 0) {
      return QStringLiteral("offset must be 0 or more.");
    }
    request.offset = offset;
  }
  if (arguments.contains(QStringLiteral("max_chars"))) {
    const qint64 max_chars =
        arguments.value(QStringLiteral("max_chars")).toInteger(0);
    if (max_chars < 1 || max_chars > kMaxReadChars) {
      return QStringLiteral("max_chars must be between 1 and %1.")
          .arg(kMaxReadChars);
    }
    request.max_chars = max_chars;
  }
  const bool by_ref = arguments.contains(QStringLiteral("ref"));
  const bool by_selector = arguments.contains(QStringLiteral("selector"));
  const bool by_mode = arguments.contains(QStringLiteral("mode"));
  if (static_cast<int>(by_ref) + static_cast<int>(by_selector) +
          static_cast<int>(by_mode) >
      1) {
    return QStringLiteral(
        "browser_read reads one of ref, selector or mode at a time.");
  }
  if (by_selector) {
    const QString selector =
        arguments.value(QStringLiteral("selector")).toString();
    if (selector.trimmed().isEmpty() || selector.size() > kMaxSelectorChars) {
      return QStringLiteral(
                 "selector must be a CSS selector of at most %1 characters.")
          .arg(kMaxSelectorChars);
    }
  }
  if (by_mode && arguments.value(QStringLiteral("mode")).toString() !=
                     QLatin1String("main")) {
    return QStringLiteral("mode must be \"main\": the page's main content.");
  }
  request.scoped = by_ref || by_selector || by_mode;
  *out = request;
  return {};
}

QString pageRead(QJsonObject &payload, const ReadRequest &request) {
  if (request.scoped && !payload.contains(QStringLiteral("scope"))) {
    return QStringLiteral(
        "This Chrome extension is older than the server and reads only the "
        "whole page, so it cannot read one element or the main content. "
        "Reload Chrome Control MCP at chrome://extensions, then read again.");
  }
  QString content = payload.value(QStringLiteral("content")).toString();
  const auto pastEnd = [](qint64 offset, qint64 total) {
    return QStringLiteral("offset %1 is past the end of the text, which is %2 "
                          "characters long.")
        .arg(QString::number(offset), QString::number(total));
  };
  qint64 total = 0;
  const qint64 offset = request.offset;
  if (payload.contains(QStringLiteral("total"))) {
    // A current extension paged the text itself: hold it to what was asked.
    total = payload.value(QStringLiteral("total")).toInteger(-1);
    if (total < 0 ||
        payload.value(QStringLiteral("offset")).toInteger(-1) != offset) {
      return QStringLiteral("The browser extension returned a different part "
                            "of the page than asked; read again.");
    }
    if (offset > 0 && offset >= total) {
      return pastEnd(offset, total);
    }
    content = content.left(request.max_chars);
  } else {
    // An extension older than 1.12.0 returned the text from its start, up to
    // its own cap: page it here.
    total = content.size();
    if (offset > 0 && offset >= total) {
      return pastEnd(offset, total);
    }
    content = content.mid(offset, request.max_chars);
  }
  const qint64 end = offset + content.size();
  payload.insert(QStringLiteral("content"), content);
  payload.insert(QStringLiteral("offset"), offset);
  payload.insert(QStringLiteral("total"), total);
  payload.insert(QStringLiteral("truncated"),
                 end < total ||
                     payload.value(QStringLiteral("truncated")).toBool());
  if (end < total) {
    payload.insert(QStringLiteral("next_offset"), end);
  } else {
    payload.remove(QStringLiteral("next_offset"));
  }
  return {};
}

QJsonArray browserToolCatalog() {
  QJsonArray tools;
  appendNavTools(tools);
  appendActionTools(tools);
  appendPointerTools(tools);
  appendFormControlTools(tools);
  appendTabTools(tools);
  appendWaitForTool(tools);
  appendInspectionTools(tools);
  appendWindowTools(tools);
  appendInfraTools(tools);
  appendPrintTool(tools);
  appendPermissionTool(tools);
  appendStorageTool(tools);
  appendCookiesTool(tools);
  appendDownloadTool(tools);
  appendRecordTools(tools);
  appendHttpAuthTool(tools);
  appendAdvancedInputTools(tools);
  return withTabIdArguments(tools, commandSpecs());
}

ExtensionCommand buildExtensionCommand(const QString &tool,
                                       const QJsonObject &arguments,
                                       const QJsonObject &ref_index) {
  const auto &specs = commandSpecs();
  const auto it = specs.constFind(tool);
  if (it == specs.constEnd()) {
    return fail(QStringLiteral("Unknown browser tool: %1").arg(tool));
  }
  const CmdSpec &spec = it.value();
  const QString unknown = rejectUnknownArgs(tool, spec, arguments);
  if (!unknown.isEmpty()) {
    return fail(unknown);
  }
  QJsonObject command{{QStringLiteral("cmd"), spec.m_cmd}};
  // tab_id first: a ref resolved below checks its own tab binding against the
  // tab the caller named, so the caller's choice has to be in the frame by
  // then.
  if (acceptsTabId(spec.m_cmd)) {
    const QString error = copyArg(arguments, tabIdArgSpec(), command);
    if (!error.isEmpty()) {
      return fail(error);
    }
  }
  if (spec.m_ref_mode != QLatin1String("none")) {
    const QString error =
        resolveRef(arguments, ref_index,
                   spec.m_ref_mode == QLatin1String("required"), command);
    if (!error.isEmpty()) {
      return fail(error);
    }
  }
  for (const ArgSpec &arg : spec.m_args) {
    const QString error = copyArg(arguments, arg, command);
    if (!error.isEmpty()) {
      return fail(error);
    }
  }
  // Tool-specific extras (drag's second ref endpoint, array-valued
  // upload/select args).
  const QString extra = applyToolExtras(tool, arguments, ref_index, command);
  if (!extra.isEmpty()) {
    return fail(extra);
  }
  return {command, true, QString()};
}

} // namespace chrome_control_mcp::browser
