// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

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
struct SnapshotView {
  QString url;
  QString title;
  QString outline;
  QJsonObject ref_index;
  int element_count{0};
  qint64 highest_ref{0};
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

} // namespace chrome_control_mcp::browser
