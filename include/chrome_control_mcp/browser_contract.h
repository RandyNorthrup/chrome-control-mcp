// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QVector>

/// @file browser_contract.h
/// @brief Pure, OS-agnostic contract for the assistant's browser-control
/// surface.
///
/// This is the design core of Chrome Control MCP's browser control, modeled on
/// how OpenAI Codex drives Chrome: the model works off a filtered DOM (a tree
/// of interactable elements with stable ids) and acts on elements by id, not
/// screen pixels. A Chrome MV3 extension attaches the DevTools Protocol to the
/// user's active tab, walks the live DOM, and streams a normalized node list
/// here; this module turns that into the compact outline the model reads and
/// translates the model's tool calls into commands the extension executes over
/// CDP.
///
/// Everything here is deliberately transport-free and free of any Windows / CDP
/// / Chrome dependency so the contract can be locked and unit-tested with JSON
/// fixtures before the extension and native-messaging bridge exist. The
/// extension side and the live MCP wiring build against this contract.
namespace chrome_control_mcp::browser {

/// One shown line of a rendered snapshot, kept beside the outline so a find
/// and the snapshot's options choose lines without parsing text back. `text`
/// is the line as the outline prints it, without indentation or newline;
/// `parent` is the index of the nearest shown ancestor, -1 at the top, and
/// `depth` how many shown ancestors it has. `offscreen` is the capture's own
/// mark, true only for a main-document element wholly outside the viewport.
struct SnapshotLine {
  QString text;
  QString role;
  QString name;
  QString value;
  QString ref;
  qsizetype parent{-1};
  int depth{0};
  bool interactable{false};
  bool offscreen{false};
};

/// The rendered view of one DOM capture, ready for the model.
///
/// `outline` is the human/model-facing text (a Playwright-aria-style indented
/// tree). `ref_index` maps each assigned element ref (e.g. "e5") to a small
/// object carrying the CDP `backendNodeId` plus role/name, so a later
/// click/type by ref resolves back to the exact node. `element_count` is how
/// many interactable refs were assigned. `highest_ref` is the largest ref
/// number in `ref_index` (carried or new), 0 when it is empty: a caller that
/// must never hand out the same name twice keeps the maximum of it across
/// snapshots and passes one more as the next snapshot's first_new_ref.
/// `lines` are the outline's lines as data, `notes` the truncation and
/// omitted-frame lines that close it, and `positions` whether the capture said
/// where the viewport is (an extension older than 1.12.0 does not).
struct SnapshotView {
  QString url;
  QString title;
  QString outline;
  QJsonObject ref_index;
  int element_count{0};
  qint64 highest_ref{0};
  QVector<SnapshotLine> lines;
  QString notes;
  bool positions{false};
};

/// What part of a snapshot to show: the subtree under `ref`, `depth` levels
/// below its root (-1 for all), a `filter` ("" for all, "interactive", or
/// "viewport"), and at most `max_chars` characters (0 for no cap).
struct OutlineOptions {
  QString ref;
  int depth{-1};
  QString filter;
  int max_chars{0};
  [[nodiscard]] bool any() const {
    return !ref.isEmpty() || depth >= 0 || !filter.isEmpty() || max_chars > 0;
  }
};

/// A snapshot shown under options: the outline text, how many of the view's
/// lines it shows, and an error the model can act on when an option cannot be
/// honoured for this capture (a ref no longer shown, positions not reported).
struct Outline {
  QString text;
  int shown{0};
  int total{0};
  QString error;
};

/// What browser_find looks for: `text` (literal words; with `natural`, a
/// phrase whose role words become a role filter) or a `regex`, optionally
/// within one `role`, returning at most `max_results` lines.
struct FindQuery {
  QString text;
  bool natural{false};
  QString regex;
  QString role;
  int max_results{10};
};

/// Which part of a page browser_read returns: `max_chars` characters from
/// `offset`, and whether it asked for one element or the main content
/// (`scoped`), which only an extension 1.12.0 or later can honour.
struct ReadRequest {
  qint64 offset{0};
  qint64 max_chars{30'000};
  bool scoped{false};
};

/// One translated extension command. `ok` is false with a human-readable
/// `error` when the tool call cannot be honored (unknown tool, missing required
/// argument, or a `ref` that is not in the current snapshot's index). `command`
/// is the JSON envelope the extension consumes over the native-messaging
/// bridge.
struct ExtensionCommand {
  QJsonObject command;
  bool ok{false};
  QString error;
};

/// Filter + render a raw DOM capture from the extension into the model-facing
/// SnapshotView. The capture shape is the contract this function defines:
///
/// ```json
/// { "url": "...", "title": "...", "nodes": [
///     { "backendNodeId": 42, "role": "button", "name": "Sign in",
///       "tag": "button", "value": "", "depth": 2, "interactable": true,
///       "visible": true, "disabled": false, "editable": false,
///       "bounds": { "x": 10, "y": 20, "width": 80, "height": 30 } }, ... ] }
/// ```
///
/// Invisible and zero-area nodes are dropped; interactable nodes get an `eN`
/// ref. Rendering is total: a missing or malformed capture yields an empty
/// outline with element_count 0 rather than throwing.
[[nodiscard]] SnapshotView renderSnapshot(const QJsonObject &capture);

/// The same, carrying `carried_index` -- the previous snapshot's ref_index for
/// this same document -- so a node keeps the ref it was already issued.
///
/// A ref names a node, not a position. Numbering purely by document order means
/// an element that gains a ref-worthy sibling above it answers to a different
/// ref in the next snapshot, so a ref the model is still holding resolves
/// silently, to the wrong element. Carrying by backendNodeId keeps `e29`
/// meaning the node it meant, and issues new numbers only for nodes never seen.
/// Pass an empty object whenever the document may have changed underneath that
/// index (a navigation), where a backendNodeId no longer names the same node.
[[nodiscard]] SnapshotView renderSnapshot(const QJsonObject &capture,
                                          const QJsonObject &carried_index);

/// The same, with a floor under every NEW ref number: a node never seen before
/// is named e<first_new_ref> or above, never below.
///
/// Carrying by backendNodeId stops a ref moving to the node next door within
/// one document. It does nothing about a ref that has LEFT the index -- its
/// node went away, the page navigated, the snapshot came from another tab --
/// and is then issued again for whatever happens to be numbered there next. A
/// model still holding the old one gets a silent wrong target instead of
/// "Unknown element ref". The session keeps a high-water mark of every ref it
/// has issued and passes one more, so no name is ever reused for the life of
/// the server. Values below 1 are treated as 1.
[[nodiscard]] SnapshotView renderSnapshot(const QJsonObject &capture,
                                          const QJsonObject &carried_index,
                                          qint64 first_new_ref);

/// True iff the extension command @p cmd acts on one tab, and so takes the
/// optional `tab_id` argument that names it. Exposed so the session can tell a
/// tab-scoped reply that failed to say which tab it touched (fail closed) from
/// a command that never touched one (nothing to reconcile).
[[nodiscard]] bool commandIsTabScoped(const QString &cmd);

/// Read a Chrome tab id: a positive JSON integer no larger than a 32-bit int,
/// which is what chrome.tabs hands out. Anything else -- a string, a fraction,
/// zero, a negative, a magnitude past int32 -- is refused rather than coerced,
/// so a malformed id can never be mistaken for a real tab. One definition for
/// the ref bindings here and the reply frames the session reads, so a tab id
/// either side stores is always one the model could pass back as `tab_id`.
[[nodiscard]] bool tabIdFromJson(const QJsonValue &value, qint64 *out);

/// The browser tool catalog advertised to the model: one entry per tool with a
/// strict JSON-Schema `inputSchema` (`additionalProperties:false`). DOM-first,
/// so the primary act-on-element tools take a `ref` from the latest snapshot.
/// Every tab-scoped tool also takes an optional `tab_id`.
[[nodiscard]] QJsonArray browserToolCatalog();

/// Translate a model tool call into the extension command envelope. `ref_index`
/// maps each live ref to `{backendNodeId, role, name, tabId}`, used to resolve
/// any `ref`/`to_ref` argument to a `backendNodeId` AND to the tab its snapshot
/// came from: the command is sent with that `tab_id`, and a call whose own
/// `tab_id` names a different tab is refused rather than letting either one
/// win. An entry without `tabId` is unbound and adds no `tab_id`. Never throws:
/// bad input comes back as `ok == false` with a reason the model can read and
/// recover from.
[[nodiscard]] ExtensionCommand
buildExtensionCommand(const QString &tool, const QJsonObject &arguments,
                      const QJsonObject &ref_index);

/// Read browser_snapshot's options out of a tool call's arguments into @p out.
/// Empty on success, else why they cannot be honoured.
[[nodiscard]] QString outlineOptionsFrom(const QJsonObject &arguments,
                                         OutlineOptions *out);

/// Show @p view under @p options. Applied in one order: the subtree under the
/// ref, the depth below its root, the filter, and last the character cap,
/// which collapses the largest regions holding nothing on screen (or, with no
/// positions, nothing near the top), no landmark and no heading, to one line
/// each, rather than cutting the outline at its tail.
[[nodiscard]] Outline renderOutline(const SnapshotView &view,
                                    const OutlineOptions &options);

/// Mark with a leading `*` every ref in @p view that is not in @p known -- the
/// refs this snapshot is the first to show -- in its lines and its outline.
void markNewRefs(SnapshotView *view, const QSet<QString> &known);

/// Read browser_find's arguments into @p out. Empty on success, else why the
/// call cannot be honoured: none or several of text, query and regex; a value
/// too long; a pattern that does not compile; max_results out of range.
[[nodiscard]] QString findQueryFrom(const QJsonObject &arguments,
                                    FindQuery *out);

/// The lines of @p view that match @p query, best first, each in the
/// snapshot's exact line format with its ref and followed by the containers
/// it sits in; or, with no match, the closest names on the page. Code, not a
/// model: the same query on the same capture always gives the same answer.
[[nodiscard]] QString renderFind(const SnapshotView &view,
                                 const FindQuery &query);

/// Read browser_read's paging and scoping arguments into @p out. Empty on
/// success, else why they cannot be honoured.
[[nodiscard]] QString readRequestFrom(const QJsonObject &arguments,
                                      ReadRequest *out);

/// Fit the extension's read payload to @p request, in place: page a reply an
/// older extension returned whole, add `offset`, `total` and `next_offset`,
/// and refuse a scoped read an older extension answered with the whole page.
/// Empty on success, else the error to return.
[[nodiscard]] QString pageRead(QJsonObject &payload,
                               const ReadRequest &request);

} // namespace chrome_control_mcp::browser
