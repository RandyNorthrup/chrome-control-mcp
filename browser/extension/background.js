// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Chrome Control MCP -- background service worker.
//
// Unit 6 scope: the DOM READ path. The extension connects to the native host over
// Chrome native messaging (the chrome_control_mcp relay), waits for the bridge to come up,
// then answers command frames forwarded from the Chrome Control MCP assistant:
//   - snapshot  : attach the DevTools protocol to the active tab and build the filtered
//                 DOM capture the model reads (roles/names from the accessibility tree,
//                 geometry from a DOM snapshot, joined by backendNodeId).
//   - read      : return the active tab's text or html.
//   - navigate / back / forward / reload : drive history via chrome.tabs.
//   - listTabs / selectTab / newTab / closeTab : tab management via chrome.tabs.
//   - click / type / pressKey / scroll : input injected over CDP Input (unit 7).
//   - screenshot : a PNG of the active tab via CDP Page.captureScreenshot (unit 8).
//   - clickAt : coordinate click at screenshot pixels, dpr-converted to CSS px (unit 9).
//   - dialog : arm the next JS dialog's response + report the last one (unit 10); dialogs
//              are auto-answered by an onEvent handler so the page never wedges.
//
// PROTOCOL: the native host is a thin relay in strict request/reply. For every
// {type:"command", id, cmd, ...} frame this worker replies EXACTLY ONCE with
// {type:"result", id, cmd, payload} or {type:"error", id, cmd, error}. It NEVER sends
// an unsolicited frame (that would desync the relay's one-op pump). The relay's own
// {type:"bridge_ready"|"bridge_unavailable"} frames are informational. A {type:"cancel"} frame
// retires whatever command is in flight -- the polling handlers stop and that command answers
// with its own error -- and is itself never replied to, so the pump stays in step.
//
// SECURITY: page content is untrusted DATA. The worker never eval()s page-controlled
// strings, never lets a page decide what is permitted, and only navigates to http(s).
// The real control against a hostile page is the assistant-side confirmation gate.

const HOST_NAME = "com.chromecontrolmcp.browser";

// Bridge protocol version the extension speaks; must match kBrowserBridgeProtocol on
// the native side. A mismatch is surfaced rather than silently tolerated.
//
// 2: command frames may name the tab they act on (`tab_id`), replies say which tab they acted on
// (`tabId`, with that tab's own `domEpoch`) and which tabs the session stopped holding
// (`goneTabIds`). A protocol-1 extension would ignore `tab_id` and act on whatever its single
// current tab was -- the wrong page, silently -- which is why this is a version and not a field.
const BRIDGE_PROTOCOL = 2;

// The CDP roles we treat as actionable (get a ref the model can act on). Kept lower-cased
// for a case-insensitive match against the accessibility tree's role values.
const INTERACTABLE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "gridcell",
  "scrollbar",
  // Media elements. browser_media exists to drive these, and without a ref it cannot be aimed at
  // one: a <video> whose controls the page draws itself is not focusable and carries no AX value,
  // so it was emitted as scenery the model could see and not touch. Measured on a direct .mp4 in
  // Chrome's own viewer and on one of two videos on the same page -- the other happened to be
  // focusable, which is why this looked arbitrary.
  "video",
  "audio",
]);

// Inline handler attributes that say the page wired this element to the pointer itself.
//
// Chrome's own DOMSnapshot isClickable covers click, and covers it properly: measured against a
// real Chrome, it flags a div with an inline onclick AND one wired with addEventListener, which
// no attribute scan could see. What it does not flag is hover -- an element with only
// onmouseenter comes back false -- and browser_hover has to be able to reach what it is aimed at.
// mousedown/pointerdown are here for the same reason: custom controls are routinely built on them
// and never fire a click listener for Chrome to notice.
const POINTER_HANDLER_ATTRS = new Set([
  "onmouseenter",
  "onmouseover",
  "onmousedown",
  "onmouseup",
  "onpointerenter",
  "onpointerover",
  "onpointerdown",
  "onpointerup",
]);

// Roles that are pure structure -- not interactable on their own even when focusable.
const STRUCTURAL_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "group",
  "genericcontainer",
]);

// Hard caps so a hostile or enormous page cannot blow up the worker or the frame.
const MAX_CAPTURE_NODES = 2000;
const MAX_READ_CHARS = 200000;
const NAV_TIMEOUT_MS = 15000;
const DEFAULT_SCROLL_PX = 400;
// How many omitted cross-origin frame URLs a reply LISTS; a hostile page could otherwise spawn
// thousands of iframes. A page hiding fifty frames must not read as one hiding twenty, so when the
// cap bites the reply carries omittedFramesTruncated alongside the list. That flag is what the
// renderer reports, rather than inferring truncation from the array's length: a length convention
// silently couples this constant to the renderer's own cap, and raising either one alone would
// turn a cut list back into an apparently complete one.
const MAX_OMITTED_FRAMES = 20;
// How much of a control's live value the accessibility capture carries. A value longer than
// this is cut and flagged with value_truncated rather than silently shortened, so a clipped
// entry is never mistaken for the control's full contents.
const AX_VALUE_MAX_CHARS = 80;
// Skia caps a single raster surface at 16384 DEVICE px per edge; a full-page clip past
// that fails the capture. Chrome reads the clip in DIPs and rasterizes it at the display's
// scale, so the clip is clamped to this cap divided by that scale (below).
const MAX_SHOT_EDGE_PX = 16384;
// The largest base64 image/PDF payload a reply may carry. These mirror kMaxScreenshotBase64 and
// kMaxPdfBase64 on the bridge side: past them the bridge refuses the payload, and past the
// relay's own frame cap the frame does not parse at all and the connection is torn down -- the
// caller then sees a transport reset rather than a size error it could act on. Refusing here
// keeps an oversized capture an honest, recoverable error.
const MAX_SHOT_BASE64 = 16 * 1024 * 1024;
const MAX_PDF_BASE64 = 24 * 1024 * 1024;

// Chrome answers Page.captureScreenshot only once the tab produces a compositor frame, and a tab
// that is not the front tab of an on-screen window produces none: the capture then never returns.
// The session works in a tab of its own, beside the user's, so that is the ORDINARY case here --
// left alone the wait runs out the app's whole transport deadline, which resets the bridge and
// ends the session over one screenshot. A screencast makes Chrome composite a tab that is not on
// screen, so the capture is taken with one running; its frames are bounded to a single pixel
// because nothing reads them, and it is always stopped again.
const FRAME_FORCING_SCREENCAST = {
  format: "jpeg",
  quality: 1,
  maxWidth: 1,
  maxHeight: 1,
  everyNthFrame: 1,
};
// A capture of a tab that IS on screen answers in milliseconds; this is the patience for one
// before the frame-forcing path is tried instead, long enough that a large full-page raster on a
// slow machine is not abandoned mid-way.
const ON_SCREEN_CAPTURE_DEADLINE_MS = 4000;
// The bound on a forced capture. Every path here must end well inside the app's transport
// deadline so a screenshot that cannot be taken is one failed tool call, not a dead bridge.
const FORCED_CAPTURE_DEADLINE_MS = 15000;

// CDP Input.dispatchKeyEvent modifier bitmask (Alt=1, Control=2, Meta=4, Shift=8).
// These tables are indexed by a caller-supplied token, so they carry NO prototype: a plain object
// literal answers "constructor"/"toString"/"valueOf" with an inherited member, and a lookup that
// treats a truthy hit as a real definition would accept a modifier or key that was never declared.
const MODIFIER_BITS = Object.assign(Object.create(null), {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  command: 4,
  cmd: 4,
  shift: 8,
});
// Named non-printable keys the model may press, mapped to their DOM code + legacy
// keyCode (needed so browser shortcuts like Control+A actually register).
const KEY_DEFS = Object.assign(Object.create(null), {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
});
// OEM punctuation -> [DOM code, Windows virtual key code]. ASCII charCodeAt is NOT the
// virtual key (e.g. '.' is 46 = VK_DELETE), so a chord like Control+/ needs the real VK.
const OEM_KEYS = Object.assign(Object.create(null), {
  ";": ["Semicolon", 186],
  ":": ["Semicolon", 186],
  "=": ["Equal", 187],
  "+": ["Equal", 187],
  ",": ["Comma", 188],
  "<": ["Comma", 188],
  "-": ["Minus", 189],
  _: ["Minus", 189],
  ".": ["Period", 190],
  ">": ["Period", 190],
  "/": ["Slash", 191],
  "?": ["Slash", 191],
  "`": ["Backquote", 192],
  "~": ["Backquote", 192],
  "[": ["BracketLeft", 219],
  "{": ["BracketLeft", 219],
  "\\": ["Backslash", 220],
  "|": ["Backslash", 220],
  "]": ["BracketRight", 221],
  "}": ["BracketRight", 221],
  "'": ["Quote", 222],
  '"': ["Quote", 222],
});
// The character a printable key produces while Shift is HELD (US layout). A chord dispatches the
// unshifted token as its `text` otherwise, so "Shift+1" would insert "1" where the caller asked
// for "!" -- the wrong character, reported as the chord that was sent.
const SHIFTED_KEYS = Object.assign(Object.create(null), {
  1: "!",
  2: "@",
  3: "#",
  4: "$",
  5: "%",
  6: "^",
  7: "&",
  8: "*",
  9: "(",
  0: ")",
  ";": ":",
  "=": "+",
  ",": "<",
  "-": "_",
  ".": ">",
  "/": "?",
  "`": "~",
  "[": "{",
  "\\": "|",
  "]": "}",
  "'": '"',
});
// macOS: the editing command each key chord means there. On Windows and Linux Chrome's own
// renderer turns Control+A into Select All; on macOS those bindings live in the operating
// system's key-binding table (Cocoa's NSStandardKeyBindingResponding), which a DevTools
// Input.dispatchKeyEvent never passes through -- so a synthetic Command+A, Backspace or
// Option+ArrowLeft reaches the page and edits nothing. The keyDown must carry the command
// itself, in Input.dispatchKeyEvent's `commands` field.
//
// Keyed by the modifiers in the fixed order Shift, Control, Alt, Meta, then the DOM `code`.
// Ported entry for entry from Playwright's macEditingCommands.ts (microsoft/playwright,
// packages/playwright-core/src/server/macEditingCommands.ts; Copyright 2017 Google Inc.,
// modifications copyright Microsoft Corporation; Apache License 2.0 -- see
// THIRD_PARTY_NOTICES.md), which transcribes Chromium's default macOS key bindings. Values keep
// the Cocoa selector spelling (trailing ':'); macEditingCommands() turns them into Chromium
// command names.
const MAC_EDITING_COMMANDS = Object.assign(Object.create(null), {
  Backspace: "deleteBackward:",
  Enter: "insertNewline:",
  NumpadEnter: "insertNewline:",
  Escape: "cancelOperation:",
  ArrowUp: "moveUp:",
  ArrowDown: "moveDown:",
  ArrowLeft: "moveLeft:",
  ArrowRight: "moveRight:",
  F5: "complete:",
  Delete: "deleteForward:",
  Home: "scrollToBeginningOfDocument:",
  End: "scrollToEndOfDocument:",
  PageUp: "scrollPageUp:",
  PageDown: "scrollPageDown:",
  "Shift+Backspace": "deleteBackward:",
  "Shift+Enter": "insertNewline:",
  "Shift+NumpadEnter": "insertNewline:",
  "Shift+Escape": "cancelOperation:",
  "Shift+ArrowUp": "moveUpAndModifySelection:",
  "Shift+ArrowDown": "moveDownAndModifySelection:",
  "Shift+ArrowLeft": "moveLeftAndModifySelection:",
  "Shift+ArrowRight": "moveRightAndModifySelection:",
  "Shift+F5": "complete:",
  "Shift+Delete": "deleteForward:",
  "Shift+Home": "moveToBeginningOfDocumentAndModifySelection:",
  "Shift+End": "moveToEndOfDocumentAndModifySelection:",
  "Shift+PageUp": "pageUpAndModifySelection:",
  "Shift+PageDown": "pageDownAndModifySelection:",
  "Shift+Numpad5": "delete:",
  "Control+Tab": "selectNextKeyView:",
  "Control+Enter": "insertLineBreak:",
  "Control+NumpadEnter": "insertLineBreak:",
  "Control+Quote": "insertSingleQuoteIgnoringSubstitution:",
  "Control+KeyA": "moveToBeginningOfParagraph:",
  "Control+KeyB": "moveBackward:",
  "Control+KeyD": "deleteForward:",
  "Control+KeyE": "moveToEndOfParagraph:",
  "Control+KeyF": "moveForward:",
  "Control+KeyH": "deleteBackward:",
  "Control+KeyK": "deleteToEndOfParagraph:",
  "Control+KeyL": "centerSelectionInVisibleArea:",
  "Control+KeyN": "moveDown:",
  "Control+KeyO": ["insertNewlineIgnoringFieldEditor:", "moveBackward:"],
  "Control+KeyP": "moveUp:",
  "Control+KeyT": "transpose:",
  "Control+KeyV": "pageDown:",
  "Control+KeyY": "yank:",
  "Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter:",
  "Control+ArrowUp": "scrollPageUp:",
  "Control+ArrowDown": "scrollPageDown:",
  "Control+ArrowLeft": "moveToLeftEndOfLine:",
  "Control+ArrowRight": "moveToRightEndOfLine:",
  "Shift+Control+Enter": "insertLineBreak:",
  "Shift+Control+NumpadEnter": "insertLineBreak:",
  "Shift+Control+Tab": "selectPreviousKeyView:",
  "Shift+Control+Quote": "insertDoubleQuoteIgnoringSubstitution:",
  "Shift+Control+KeyA": "moveToBeginningOfParagraphAndModifySelection:",
  "Shift+Control+KeyB": "moveBackwardAndModifySelection:",
  "Shift+Control+KeyE": "moveToEndOfParagraphAndModifySelection:",
  "Shift+Control+KeyF": "moveForwardAndModifySelection:",
  "Shift+Control+KeyN": "moveDownAndModifySelection:",
  "Shift+Control+KeyP": "moveUpAndModifySelection:",
  "Shift+Control+KeyV": "pageDownAndModifySelection:",
  "Shift+Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter:",
  "Shift+Control+ArrowUp": "scrollPageUp:",
  "Shift+Control+ArrowDown": "scrollPageDown:",
  "Shift+Control+ArrowLeft": "moveToLeftEndOfLineAndModifySelection:",
  "Shift+Control+ArrowRight": "moveToRightEndOfLineAndModifySelection:",
  "Alt+Backspace": "deleteWordBackward:",
  "Alt+Enter": "insertNewlineIgnoringFieldEditor:",
  "Alt+NumpadEnter": "insertNewlineIgnoringFieldEditor:",
  "Alt+Escape": "complete:",
  "Alt+ArrowUp": ["moveBackward:", "moveToBeginningOfParagraph:"],
  "Alt+ArrowDown": ["moveForward:", "moveToEndOfParagraph:"],
  "Alt+ArrowLeft": "moveWordLeft:",
  "Alt+ArrowRight": "moveWordRight:",
  "Alt+Delete": "deleteWordForward:",
  "Alt+PageUp": "pageUp:",
  "Alt+PageDown": "pageDown:",
  "Shift+Alt+Backspace": "deleteWordBackward:",
  "Shift+Alt+Enter": "insertNewlineIgnoringFieldEditor:",
  "Shift+Alt+NumpadEnter": "insertNewlineIgnoringFieldEditor:",
  "Shift+Alt+Escape": "complete:",
  "Shift+Alt+ArrowUp": "moveParagraphBackwardAndModifySelection:",
  "Shift+Alt+ArrowDown": "moveParagraphForwardAndModifySelection:",
  "Shift+Alt+ArrowLeft": "moveWordLeftAndModifySelection:",
  "Shift+Alt+ArrowRight": "moveWordRightAndModifySelection:",
  "Shift+Alt+Delete": "deleteWordForward:",
  "Shift+Alt+PageUp": "pageUp:",
  "Shift+Alt+PageDown": "pageDown:",
  "Control+Alt+KeyB": "moveWordBackward:",
  "Control+Alt+KeyF": "moveWordForward:",
  "Control+Alt+Backspace": "deleteWordBackward:",
  "Shift+Control+Alt+KeyB": "moveWordBackwardAndModifySelection:",
  "Shift+Control+Alt+KeyF": "moveWordForwardAndModifySelection:",
  "Shift+Control+Alt+Backspace": "deleteWordBackward:",
  "Meta+NumpadSubtract": "cancel:",
  "Meta+Backspace": "deleteToBeginningOfLine:",
  "Meta+ArrowUp": "moveToBeginningOfDocument:",
  "Meta+ArrowDown": "moveToEndOfDocument:",
  "Meta+ArrowLeft": "moveToLeftEndOfLine:",
  "Meta+ArrowRight": "moveToRightEndOfLine:",
  "Shift+Meta+NumpadSubtract": "cancel:",
  "Shift+Meta+Backspace": "deleteToBeginningOfLine:",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection:",
  "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection:",
  "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection:",
  "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection:",
  "Meta+KeyA": "selectAll:",
  "Meta+KeyC": "copy:",
  "Meta+KeyX": "cut:",
  "Meta+KeyV": "paste:",
  "Meta+KeyZ": "undo:",
  "Shift+Meta+KeyZ": "redo:",
});
// The assistant's on-page CONTROL PRESENCE: a page-injected overlay so the user SEES that the
// assistant is driving this tab and where its pointer is -- distinct from their untouched OS
// cursor. It is a prominent neon-pink pointer (with a pulsing halo), a viewport frame, and an
// "AI CONTROL" badge. Cosmetic only (never a security boundary): a hostile page can hide it but
// cannot use it to drive input. It is auto-hidden while a screenshot is captured so it never
// bleeds into the image the model reads (and does not obscure page media in a capture).
// How much of what the page says is kept, and how much of any one thing it says.
//
// Both are page-controlled: the text of a console message and the URL of a request are written by
// the site, not by us. A cap on each entry keeps one enormous string from filling a reply, and a
// cap on the ring keeps a page that logs in a loop from growing the worker without bound.
const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 200;
const MAX_PENDING_REQUESTS = 500;
const MAX_ENTRY_TEXT_CHARS = 512;
const MAX_ENTRY_URL_CHARS = 512;

// Page text, bounded and flattened. Truncation is MARKED: a message that was cut and a message
// that happened to end there must not read the same.
function boundedText(value, limit) {
  const text = value === undefined || value === null ? "" : String(value);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "\u2026" : flat;
}

// Push onto a ring, returning 1 if something had to be dropped to make room.
function pushBounded(ring, entry, limit) {
  ring.push(entry);
  if (ring.length <= limit) {
    return 0;
  }
  ring.shift();
  return 1;
}

// One console argument as text. CDP gives a RemoteObject: a primitive carries `value`, and
// anything else carries a `description` or at least a type. Rendering an object as "[object
// Object]" would throw away the only useful part, so the description is preferred where there is
// one -- that is where a thrown Error's message and class live.
function consoleArgText(argument) {
  if (!argument || typeof argument !== "object") {
    return "";
  }
  if (Object.prototype.hasOwnProperty.call(argument, "value")) {
    return String(argument.value);
  }
  if (typeof argument.description === "string") {
    return argument.description;
  }
  if (typeof argument.unserializableValue === "string") {
    return argument.unserializableValue;
  }
  return argument.type ? "[" + argument.type + "]" : "";
}

// Where a message came from, when CDP says. The top frame is the useful one; the rest is noise in
// a reply a model has to read.
function topFrameOf(stackTrace) {
  const frames =
    stackTrace && Array.isArray(stackTrace.callFrames)
      ? stackTrace.callFrames
      : [];
  const frame = frames.length > 0 ? frames[0] : null;
  if (!frame || !frame.url) {
    return null;
  }
  return (
    boundedText(frame.url, MAX_ENTRY_URL_CHARS) +
    ":" +
    ((Number(frame.lineNumber) || 0) + 1)
  );
}

// Is this URL inline content rather than something fetched over the network?
//
// A data: or blob: URL is bytes the page already had: no connection, no server, no status worth
// reporting. They are also numerous -- the media element's own controls load dozens of data:
// icons for their buttons -- and logging them filled the ring and pushed out every request the
// page actually made. Measured in the live suite: a network log that was nothing but base64 SVG.
function isInlineRequestUrl(url) {
  return /^(data|blob):/i.test(String(url || ""));
}

function recordConsole(tab, entry) {
  tab.consoleDropped += pushBounded(
    tab.consoleEntries,
    entry,
    MAX_CONSOLE_ENTRIES,
  );
}

function recordNetwork(tab, entry) {
  tab.networkDropped += pushBounded(
    tab.networkEntries,
    entry,
    MAX_NETWORK_ENTRIES,
  );
}

const AGENT_CURSOR_ID = "__chrome_control_mcp_agent_cursor__";
const CONTROL_STYLE_ID = "__chrome_control_mcp_control_style__";
const CONTROL_FRAME_ID = "__chrome_control_mcp_control_frame__";
const CONTROL_BADGE_ID = "__chrome_control_mcp_control_badge__";
// The ids the presence overlay owns, for bulk hide/remove.
const PRESENCE_IDS = [
  CONTROL_STYLE_ID,
  CONTROL_FRAME_ID,
  CONTROL_BADGE_ID,
  AGENT_CURSOR_ID,
];
// Where a tab's agent cursor is parked until the first real pointer action moves it.
const PARKED_CURSOR = Object.freeze({ x: 24, y: 24 });

// Everything one assistant session owns that is not about one particular page.
//
// A session is one MCP server: one native port, one relay, one server process. Several agents can
// sit behind one server -- sub-agents, parallel tasks of the same client -- and the server cannot
// tell them apart. So nothing about a PAGE lives here: that is on the tab (makeTabState), and a
// command names the tab it means. When this record held one "current tab" with one snapshot, one
// screenshot transform and one debugger attachment, agent B opening a tab silently moved agent A,
// and switching between two tabs detached the first and wiped its logs, refs and dialog arm.
function makeSession() {
  return {
    port: null,

    // The recording this session is making, or null. Holding it here rather
    // than in the offscreen document is what makes a session's death able to
    // clean it up: releaseAttachedState finds it because it is session state
    // like any other.
    //
    // { id, tabId, startedAt, filename, timeline: [...] }
    recording: null,

    // True when this port was opened to look for a server and every one that
    // was offered is already held. Losing such a port must not start the
    // reconnect cycle, which would open a surplus port every two seconds.
    surplus: false,

    // True for a port opened only to look for a server nothing holds yet (the alarm's probe, or a
    // relay saying a new server has published). Its loss must clear the probe flag, or no further
    // probe is ever made -- which is how a second editor went unattached for a whole day.
    probe: false,

    // Which server this port is attached to, as the pid string the relay
    // offered, or "" before any offer has been answered. A session identifies
    // its server by this rather than by anything it could look up itself.
    serverId: "",

    health: { connected: false, bridge: null, error: null },

    // True only while the host has completed the bridge_ready handshake AND declared the exact
    // protocol this worker speaks. Command frames are privileged (input injection, cookies, web
    // storage, permissions), so they run only against a bridge that announced itself and agrees on
    // the frame shape: a detected protocol skew has to STOP something to be a check at all, and an
    // unannounced host must not get a command executed on its say-so. Cleared on
    // bridge_unavailable and on port loss.
    bridgeReady: false,

    // The tabs this session holds, by Chrome tab id. A tab is held from the moment the session
    // adopts it (the user's tab it was handed, or one it picked with browser_select_tab), opens it
    // (browser_new_tab, browser_window new), or a page it is driving opens it during one of its
    // commands (a target=_blank link, window.open) -- until the tab closes, the user takes it back
    // by dragging it out of the AI group, or the session releases it. Holding is exclusive: no
    // other session may act on a held tab.
    tabs: new Map(),

    // The tab a command acts on when it names none. Only ever a tab this session holds. When it
    // closes, the session moves to another tab it holds; with none left it says so rather than
    // taking over a tab the user is using -- Chrome activates a neighbour on close, and that
    // neighbour is the user's.
    currentTabId: null,

    // The window the session works in: where tab listings, tab indices and new tabs resolve. It
    // outlives the current tab, so a new tab still opens beside the work after that tab closes.
    sessionWindowId: null,

    // The session's tab groups, one per agent per window, keyed by groupKey(windowId, agent). A
    // tab group belongs to exactly one window, so an agent working in two windows has two.
    groups: new Map(),
    groupSyncQueued: false,

    // What this session's groups are called and coloured. `label` is the MCP client's own name as
    // the server forwards it; `colors` maps each agent name ("" for unnamed) to the group colour it
    // was given, chosen so no two live groups share one.
    label: "",
    colors: new Map(),

    // When the session's port went away (it is then parked in pendingLeases), and whether it has
    // been let go of for good, after which nothing may mark tabs on its behalf.
    parkedAt: 0,
    ended: false,

    // Tabs this session stopped holding since its last reply, so the server can drop every ref it
    // bound to them. Reported once, on the next reply, then forgotten.
    goneTabIds: new Set(),

    // The tab the command in flight acted on, for its reply's tabId and domEpoch.
    actedTabId: null,

    // What the command in flight caused: tabs its page opened, and a file chooser its page asked
    // for. Both are reported on that command's reply, because they are results of what it did.
    openedDuringCommand: [],
    chooserDuringCommand: null,

    // Windows this session's pages asked to open (Page.windowOpen) in the last few seconds, waiting
    // to be matched to the tab Chrome creates for each: {url, at, opener}.
    windowOpens: [],

    // Until when a tab opened from one of this session's pages counts as this session's own doing:
    // Infinity while a command that can open one is running, a short grace after it ends. A tab
    // opened from the session's page OUTSIDE that window -- the user middle-clicking a link in it,
    // pressing Ctrl+T while looking at it -- is the user's, and never joins the session.
    openerUntil: 0,

    // When this session last ran a command, and whether it went quiet long enough for its tabs to
    // be stood down (debugger detached, highlight off, group greyed). Its next command resumes.
    lastCommandAt: Date.now(),
    idle: false,

    // Monotonic counter of command frames accepted. A handler that polls (browser_wait_for) holds
    // the generation it started under; the moment a newer command arrives -- or the session is torn
    // down -- its generation is stale and the loop must abandon rather than keep driving the page
    // and eventually post a reply into a relay that has already been reset.
    commandGeneration: 0,

    reconnectTimer: null,

    // Whether this port ever reached a bridge. What separates "no server is running" from "the
    // server went away", which want different retry intervals.
    everReady: false,

    // The tab listing browser_tabs last returned: the window it was taken from and the tab id at
    // each index. A tab index is POSITIONAL -- it shifts whenever a tab opens, closes, or moves, and
    // "the last focused window" can resolve to a DIFFERENT window than the one that was listed -- so
    // an index names a tab only while it still names the tab the model read at that index. Null when
    // no listing is outstanding (nothing was listed, or an action shifted the positions).
    lastTabListing: null,

    // The window ids browser_windows last reported (and the ones this session opened itself), as a
    // Set. A window id is a bare small integer with no shape of its own, so a stale id from an earlier
    // listing -- or one the model simply guessed -- names a live window just as well as a real one,
    // and focus/close would then act on a window the operator never saw listed. Null until a listing
    // is taken.
    lastWindowListing: null,

    // A file's bytes, in base64, keyed by the upload id the app minted for it. One entry per file in
    // flight; entries go as soon as the upload is applied, abandoned, or the session ends.
    uploadChunks: new Map(),

    // Each agent's clipboard, keyed by agent name ("" for the session's shared group): text,
    // markup and files, in this worker's memory only. See "Agent clipboards".
    clipboards: new Map(),

    // What a page in one of this session's tabs did with the agent's clipboard during (or just
    // after) the last command, reported on the next reply and then cleared.
    clipboardDuringCommand: null,
  };
}

// Everything a session knows about one page it holds.
//
// Each of these is a correctness guard whose failure is silent, and each is about ONE page: a
// snapshot's refs, a screenshot's transform, an armed dialog answer, the network-idle count. Kept
// per tab, two agents working two tabs of one session cannot invalidate each other's -- and the
// debugger stays attached to every held tab, so moving between them loses nothing.
function makeTabState(tabId, origin) {
  return {
    id: tabId,

    // "opened": this session created it, so it is closed when the session releases it or ends.
    // "adopted": the user's tab -- the one it was handed, or one the user dragged into the AI group.
    // Handed back when the session is done, never closed.
    origin,

    // The agent this tab is for, as a tool call named it ("" when none did). Decides which of the
    // session's groups the tab sits in, and so its colour.
    agent: "",

    // The held tab whose page opened this one (a popup, a target=_blank link), or null. Releasing a
    // tab releases what it opened too: an agent that says it is done with its tab is done with the
    // pages its clicks spawned, and those were left open behind it.
    openedFrom: null,

    // True while this session's debugger is attached to the tab, and the attach in progress if
    // one is, so a command and a background attach never race each other into two attaches.
    attached: false,
    attaching: null,

    lastUsedAt: Date.now(),

    // Until when a page in this tab may use the agent's clipboard: Infinity while one of the
    // agent's input commands on this tab runs, a moment after one ends, 0 otherwise. A page asking
    // outside it is refused, as a page with no clipboard permission is.
    inputUntil: 0,

    // Where this tab's agent cursor last went, so a redraw after a navigation re-parks it there.
    cursor: { x: PARKED_CURSOR.x, y: PARKED_CURSOR.y },

    // A monotonic DOM-generation counter, reported on every reply that acted on this tab. It moves
    // whenever the DOM the server's refs were captured against goes away under us -- a top-frame
    // navigation, an in-document (SPA) route change, or a detach (tab close / DevTools). The server
    // compares it across replies and retires this tab's refs when it moves, so an external
    // navigation cannot leave a stale ref addressable. Per tab: a navigation in one agent's tab
    // must not retire another agent's refs.
    domEpoch: 0,

    // The domEpoch the last snapshot of this tab was captured at, or null with none outstanding.
    // Blink allocates backendNodeIds from a per-renderer counter, so after a cross-site navigation a
    // live id names an arbitrary node of the NEW document. The server's epoch check is post-hoc by
    // construction -- it reads the marker off the REPLY, i.e. after the click already landed -- so
    // the generation is pinned here too and checked BEFORE dispatching.
    lastSnapshotEpoch: null,

    // Fingerprint of the render the most recent screenshot of this tab captured: {fullPage, dpr,
    // scale, offsetX, offsetY, scrollX, scrollY, href, epoch, ...}. A coordinate the model reads off
    // that image (browser_click_at, browser_drag's x/y) is meaningful only against it, so it converts
    // with THIS transform (not a re-read) and refuses if the zoom, pinch, scroll, or document changed
    // since -- a full-page shot is document-space, not click-space. null when no valid screenshot is
    // outstanding.
    lastShot: null,

    // Live network-activity tracking for browser_wait_for network_idle: the IDS of the in-flight
    // requests and the timestamp of the last request start/finish. Fed by the CDP Network domain
    // events; reset on navigation/detach so a stalled request cannot wedge idle. Ids rather than a
    // counter, because a redirect re-fires Network.requestWillBeSent for the SAME requestId and
    // still reports only one completion: counting events ratchets the total upward, and a single
    // redirected subresource would keep network_idle from ever holding again.
    inflightRequests: new Set(),
    lastNetworkActivityMs: 0,

    // True only while the Network domain is actually instrumenting the tab. The idle predicate is
    // read entirely off the events above, so without them it reports a quiet page having observed
    // nothing at all -- a statement about the page made from no evidence.
    networkInstrumented: false,

    // What the page said, and what it asked the network for, since the session attached.
    //
    // An agent that clicks a button and sees nothing happen has, until now, had no way to learn
    // that the page threw "TypeError: x is not a function" -- the one fact that explains it. Both
    // of these are RINGS with a hard cap: every field in them is page-controlled, and a page that
    // logs in a loop must cost a bounded amount of memory and a bounded reply, not an unbounded
    // one. What falls off the back is counted rather than forgotten, because "the oldest entries
    // are gone" and "there were none" are different answers.
    consoleEntries: [],
    consoleDropped: 0,

    // Keyed by requestId so a response can be paired with the method and URL that asked for it;
    // CDP reports those on two different events. Bounded for the same reason, and pruned when a
    // request completes so a long-lived page does not accumulate one entry per subresource.
    networkPending: new Map(),
    networkEntries: [],
    networkDropped: 0,

    // The tab's real User-Agent, captured before any browser_emulate override so reset can restore
    // it. Null until first captured; cleared on detach.
    originalUserAgent: null,

    // Credentials armed for HTTP auth challenges via browser_http_auth. Null = disarmed (no Fetch
    // interception). When set, it is { username, password, origin } and the Fetch domain is enabled;
    // the onEvent handler answers an auth challenge with these ONLY when the challenge origin matches
    // the armed origin. Cleared on detach and on top-frame navigation (Fetch is per-attachment, so it
    // auto-disables on detach too).
    httpAuthCreds: null,

    // The last failure answering a request Fetch paused, or null when none has happened. A
    // urlPattern:"*" interception pauses EVERY request, so a continue/continueWithAuth that never
    // lands leaves that resource stalled and the page hanging on it. The handler is an event callback
    // with no caller to fail, so the failure is recorded instead of discarded: browser_http_auth
    // reports it back, which is the only way a stalled interception is visible at all.
    lastFetchError: null,

    // A one-shot response armed for the NEXT JavaScript dialog by browser_dialog, e.g.
    // {accept:true, text:"..."}. It is scoped to the single command that follows the arm (see
    // runCommand): consumed if that command's action opens a dialog, otherwise dropped when the
    // command finishes -- so an armed "accept" can never linger and auto-confirm an unrelated
    // later dialog. Also cleared on navigation and teardown.
    pendingDialogPolicy: null,

    // True only while a command that could open a dialog is executing on this tab. Clearing the arm
    // when that command finishes still leaves it live through the gap BEFORE the command arrives --
    // an arbitrary idle window in which a page's own setTimeout confirm() consumes the accept meant
    // for the next tool call. The arm is only visible to the handler while a dispatch is in flight.
    dialogArmActive: false,

    // The most recent dialog handled on this tab: {type, message, accepted}. Reported by
    // browser_dialog so the model can see what an auto-dismissed alert/confirm said.
    lastDialog: null,

    // A file picker the page asked for during one of this session's commands, which was caught
    // instead of shown: {kind: "input"|"picker", backendNodeId?, multiple, directory, at}. Chrome
    // refuses a native file dialog to a tab that is not in front, and shows one over the user's work
    // when it is, so an agent never gets a native dialog. browser_upload with no ref fills this.
    fileChooser: null,

    // Whether the page's file pickers are being caught right now, and the timer that stops catching
    // them a moment after the command that may have opened one.
    pickersArmed: false,
    disarmTimer: null,
  };
}

// Every assistant session this worker is serving. One per native port, and one
// port per MCP server that published a bridge record, so two editors driving
// two servers get a session each instead of contending for one.
//
// A Set rather than a map keyed by server id: a session exists from the moment
// its port opens, which is before the relay has offered it a server to attach
// to, so there is a window in which it has no id to be keyed by.
const sessions = new Set();

// Which session holds a tab, and its record of it, or null. A browser event names only a tab, so
// this is how one is routed to the session it concerns -- the one place a session is searched for.
//
// A session whose port went away still holds its tabs until its server is known to be gone (see
// pendingLeases), so another session cannot take them in the meantime.
function holderOf(tabId) {
  if (typeof tabId !== "number") {
    return null;
  }
  for (const session of [...sessions, ...pendingLeases.values()]) {
    const tab = session.tabs.get(tabId);
    if (tab) {
      return { session, tab };
    }
  }
  return null;
}

// The same, only while the session's debugger is attached to it: the debugger's own events name a
// target, and one the session is no longer attached to is none of its business.
function attachedHolderOf(tabId) {
  const held = holderOf(tabId);
  return held && held.tab.attached ? held : null;
}

// When the probe now open was opened, or 0 when none is.
//
// A relay offers its list once, at startup, so a session that is already up
// never hears about a server that started later -- a second editor opening.
// The probe is how that is noticed: it opens a port, reads a fresh offer, and
// either takes a server nothing holds or finds none and goes away.
//
// A timestamp rather than a flag because a flag that is set and never cleared stops discovery for
// the life of the worker -- which is exactly what happened when a probe port could not be opened,
// or was lost before its offer arrived. A probe older than this is presumed lost.
let probeOpenedAt = 0;
const PROBE_STALE_MS = 15000;

function probeInFlight() {
  return probeOpenedAt !== 0 && Date.now() - probeOpenedAt < PROBE_STALE_MS;
}

// Open a port to look for servers nothing holds, unless one is already looking.
//
// Every probe STARTS A PROCESS (connectNative launches the native host), so what calls this is
// rationed: the alarm's safety net is not forced and so obeys the reconnect backoff, and only a
// relay's own report that a server nothing holds has published -- an event, not a timer -- may
// skip the wait.
function probeForServers({ force = false } = {}) {
  if (probeInFlight()) {
    return;
  }
  probeOpenedAt = Date.now();
  const opened = connect({ force });
  if (!opened) {
    probeOpenedAt = 0;
    return;
  }
  for (const session of sessions) {
    if (session.port === opened) {
      session.probe = true;
    }
  }
}

// A session is attached to at most one server; these say what the worker holds.
function anyPortOpen() {
  for (const session of sessions) {
    if (session.port) {
      return true;
    }
  }
  return false;
}

// Only a session with a port holds its server: one whose port went away is waiting to be picked
// back up, and counting it as held would keep every port from attaching to that server again.
function heldServers() {
  return [...sessions]
    .filter((session) => session.port)
    .map((session) => session.serverId)
    .filter((id) => id !== "");
}

// The servers in `offered` that no session has taken. One port per server is
// the whole point: a second port onto a server already held would give two
// sessions the same browser authority.
//
// A server whose session was lost a moment ago and whose tabs are waiting to be picked back up is
// put first, so a relay that dropped and came back resumes the work it was doing rather than
// leaving those tabs to be cleaned up while it attaches to some other server.
function unheldServers(offered) {
  const held = new Set(heldServers());
  const free = offered
    .map(String)
    .filter((id) => id !== "" && !held.has(id) && !serverRefused(id));
  return [
    ...free.filter((id) => pendingLeases.has(id)),
    ...free.filter((id) => !pendingLeases.has(id)),
  ];
}

// Servers that refused this worker, and until when they are left alone.
//
// A server that will not take a relay -- an older version speaking another protocol, a copy of
// the program the registration does not name -- refuses every attempt the same way. Picking it
// again on every offer is a process started for a known answer, and with the relay telling the
// worker about servers as they appear it could be picked as fast as offers arrive. So a refusal
// sets that server aside on a doubling interval, and only for this worker's lifetime: a server
// that was updated or restarted gets a new pid, and is a different server.
const refusedServers = new Map();
const REFUSED_MIN_MS = 60000;
const REFUSED_MAX_MS = 30 * 60000;

function serverRefused(id) {
  const entry = refusedServers.get(id);
  return Boolean(entry) && Date.now() < entry.until;
}

function noteServerRefused(id) {
  if (!id) {
    return;
  }
  const previous = refusedServers.get(id);
  const wait = previous
    ? Math.min(previous.wait * 2, REFUSED_MAX_MS)
    : REFUSED_MIN_MS;
  refusedServers.set(id, { wait, until: Date.now() + wait });
}

// The session other than @p session that holds @p tabId, or null.
//
// Two sessions driving one tab would each invalidate the other's snapshot, ref index and
// screenshot transform without anything failing, so the second one to reach for it is refused.
//
// Chrome enforces the same thing for the CDP half by allowing one debugger
// client per target, but that does not cover chrome.tabs, chrome.windows,
// cookies or downloads -- which is why this exists rather than being left to
// the browser.
function leaseHolder(tabId, session) {
  const held = holderOf(tabId);
  return held && held.session !== session ? held.session : null;
}

// Refuse a tab another session is driving, naming which one, so the operator
// can tell "busy" from "gone".
function requireUnleasedTab(session, tab) {
  const holder = tab && leaseHolder(tab.id, session);
  if (holder) {
    throw new Error(
      "That tab is being driven by another Chrome Control MCP session" +
        (holder.label ? " (" + holder.label + ")" : "") +
        (holder.serverId ? " (server " + holder.serverId + ")" : "") +
        ". Choose a different tab, or open one with browser_new_tab.",
    );
  }
}

// True when two origins are the same scheme://host:port. Both inputs are normalized through URL
// so "https://host" and "https://host:443" compare equal; falls back to strict string equality
// if either is not a parseable absolute origin (in which case a non-match fails closed).
function originsMatch(a, b) {
  if (!a || !b) {
    return false;
  }
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch (_e) {
    return a === b;
  }
}

// The real origin of a document URL, or null when it has none to compare (unparseable, or an
// opaque origin such as file:/sandboxed, which serializes to the string "null" and would
// otherwise compare EQUAL to every other opaque origin).
function originOf(url) {
  try {
    const origin = new URL(url).origin;
    return origin && origin !== "null" ? origin : null;
  } catch (_e) {
    return null;
  }
}

// -- Native messaging port ---------------------------------------------------
//
// How often a bridge that is not there gets asked for again.
//
// Every attempt STARTS A PROCESS. connectNative makes Chrome launch the native host, which looks
// for a published server, finds none, says so and exits. That is cheap once and ruinous in a loop,
// and it was a loop: a 2 s retry armed by its own disconnect, plus one attempt on every tab event.
// A browser with no MCP server running therefore spawned a host process every couple of seconds
// for as long as it was open, and faster than that while the user was browsing. Reported from a
// machine where it was loud enough to interfere with unrelated work, and the way out was to
// disable the extension -- which is the right instinct and the wrong thing to have to do.
//
// So the interval grows while nothing answers and resets the moment something does: a bridge that
// IS there is still found within two seconds, and one that is not is asked for every two minutes.
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 120000;

// Kept at module scope, not on a session: the point is to remember across the sessions that keep
// failing, each of which is a fresh record. Chrome retires this worker after ~30 s idle, so both
// values are mirrored into session storage -- a backoff that forgets every 30 s is not a backoff.
let reconnectDelayMs = RECONNECT_MIN_MS;
let nextAttemptAt = 0;

// Whether the user has switched the bridge off from the toolbar. Remembered where the browser
// keeps it across a restart: somebody who turned it off because it was in their way must not find
// it back on tomorrow.
let bridgePaused = false;

// Whether the pause has been decided by something other than the startup read -- a toolbar click
// on a worker that has only just woken. The read is asynchronous and finishes after module
// evaluation, so without this it would put such a decision back to whatever storage happened to
// say, and a user's click would be undone by a race they cannot see.
let bridgePauseDecided = false;

// The same for the interval: once an attempt has failed, the live values are the truth and a
// seed that arrives afterwards is stale.
let backoffTouched = false;

const BRIDGE_PAUSED_KEY = "chrome_control_mcp.paused";
const BACKOFF_KEY = "chrome_control_mcp.backoff";

// Storage is best-effort throughout. It can be absent (the unit harness stubs `chrome` without
// it), and a bridge that refuses to work because it could not save a preference would be a worse
// failure than forgetting one.
function rememberBackoff() {
  try {
    void chrome.storage.session.set({
      [BACKOFF_KEY]: { delayMs: reconnectDelayMs, nextAttemptAt },
    });
  } catch (_e) {
    // Nothing to do: the in-memory values above still hold for this worker.
  }
}

function growReconnectDelay() {
  backoffTouched = true;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  rememberBackoff();
}

// A bridge answered, so the next one that does not gets the short interval again. Without this the
// backoff would be a one-way ratchet: an editor restarted after a long quiet spell would be found
// two minutes later rather than two seconds.
function resetReconnectDelay() {
  backoffTouched = true;
  reconnectDelayMs = RECONNECT_MIN_MS;
  nextAttemptAt = 0;
  rememberBackoff();
}

// Whether an attempt may be made now.
//
// The window this consults is opened by a FAILED attempt, and it holds off the callers that have no
// schedule of their own: the tab events and the alarm, which fire without limit and were the paths
// that made the old 2 s interval moot. The scheduled retry is already spaced by its own timer, and
// passes `force` to say so -- without that it could be refused a millisecond early and arm nothing
// further, which would stop the retrying altogether.
//
// `force` never overrides the pause. Pausing is the one state the extension does not get to talk
// itself out of.
function connectAttemptAllowed(force) {
  if (bridgePaused) {
    return false;
  }
  return force || Date.now() >= nextAttemptAt;
}

// What the toolbar icon says. Only the paused state gets a badge: an extension that decorates
// itself while it is working normally is its own kind of noise, and "no server running" is the
// ordinary state on a machine where the editor is simply closed.
function showBridgeState() {
  try {
    if (bridgePaused) {
      void chrome.action.setBadgeText({ text: "off" });
      void chrome.action.setBadgeBackgroundColor({ color: "#8a8a8a" });
      void chrome.action.setTitle({
        title: "Chrome Control MCP: paused. Click to resume.",
      });
      return;
    }
    void chrome.action.setBadgeText({ text: "" });
    void chrome.action.setTitle({
      title: anyPortOpen()
        ? "Chrome Control MCP: connected. Click to pause."
        : "Chrome Control MCP: no server found. Click to retry now.",
    });
  } catch (_e) {
    // No action surface (the unit harness). The state above is what matters.
  }
}

// Turn the bridge off, or back on, and remember which.
//
// Pausing closes the open ports as well as stopping the attempts: a user who switches this off
// while it is connected means "stop driving my browser", not "stop trying to reconnect later".
async function setBridgePaused(paused) {
  bridgePauseDecided = true;
  bridgePaused = paused;
  showBridgeState();
  try {
    void chrome.storage.local.set({ [BRIDGE_PAUSED_KEY]: paused });
  } catch (_e) {
    // Not remembered across a restart, but honoured for this one.
  }
  if (!paused) {
    return;
  }
  for (const session of [...sessions]) {
    const port = session.port;
    session.port = null;
    // Everything goes back to the user as it stands: nothing is closed, because pausing says
    // "stop driving my browser", not "throw away what you were doing" -- the user may well want to
    // look at it. The tabs leave the AI group and lose the highlight, so nothing still claims them.
    void standDown(session, { closeOpened: false });
    sessions.delete(session);
    if (port) {
      try {
        port.disconnect();
      } catch (_e) {
        // Already gone, which is the state we wanted.
      }
    }
  }
}

// Read back what the user chose before this worker existed. Chrome retires the worker every ~30 s,
// so this runs often; it must not start an attempt of its own, only decide whether one is allowed.
async function loadBridgeState() {
  try {
    const stored = await chrome.storage.local.get(BRIDGE_PAUSED_KEY);
    if (!bridgePauseDecided) {
      bridgePaused = Boolean(stored && stored[BRIDGE_PAUSED_KEY] === true);
    }
  } catch (_e) {
    // Running is the safe default: the bridge is what the extension is for.
  }
  try {
    const stored = backoffTouched
      ? null
      : await chrome.storage.session.get(BACKOFF_KEY);
    const saved = stored && stored[BACKOFF_KEY];
    if (saved && typeof saved.delayMs === "number") {
      reconnectDelayMs = Math.min(
        Math.max(saved.delayMs, RECONNECT_MIN_MS),
        RECONNECT_MAX_MS,
      );
    }
    if (saved && typeof saved.nextAttemptAt === "number") {
      nextAttemptAt = saved.nextAttemptAt;
    }
  } catch (_e) {
    // A forgotten interval costs one extra attempt, which is the old behaviour once.
  }
  showBridgeState();
}

// What a session says when its server speaks another bridge protocol, in terms of what to do.
function protocolMismatchText(hostProtocol) {
  const newer = Number(hostProtocol) > BRIDGE_PROTOCOL;
  return (
    "Bridge protocol mismatch: host " +
    hostProtocol +
    ", extension " +
    BRIDGE_PROTOCOL +
    ". " +
    (newer
      ? "The Chrome Control MCP extension loaded in Chrome is older than the server: reload it " +
        "at chrome://extensions (or restart Chrome) so Chrome loads the copy installed with the server."
      : "The server is older than this extension: restart the editor or agent that started it so " +
        "it runs the installed version.")
  );
}

// A server newer than this extension means the files on disk were updated and Chrome is still
// running the old ones -- Chrome does not reload an unpacked extension when its files change.
// Reloading picks the new ones up. Once per protocol, remembered across the reload, so an
// extension loaded from a folder that was NOT updated (the files really are old) cannot loop.
const RELOADED_FOR_KEY = "chrome_control_mcp.reloadedForProtocol";

async function reloadForNewerHost(hostProtocol) {
  if (!(Number(hostProtocol) > BRIDGE_PROTOCOL)) {
    return;
  }
  try {
    const stored = await chrome.storage.local.get(RELOADED_FOR_KEY);
    if (stored && stored[RELOADED_FOR_KEY] === hostProtocol) {
      return;
    }
    await chrome.storage.local.set({ [RELOADED_FOR_KEY]: hostProtocol });
    chrome.runtime.reload();
  } catch (_e) {
    // Not reloaded: the session's error already tells the user how to do it by hand.
  }
}

// Three short numbers and nothing else, as every release has been called.
const VERSION_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;

// The version Chrome is running: the manifest it loaded, which stays what it was until the
// extension is reloaded, whatever the files on disk now say.
function extensionVersion() {
  try {
    const version = chrome.runtime.getManifest().version;
    return typeof version === "string" && VERSION_PATTERN.test(version)
      ? version
      : "";
  } catch (_e) {
    return "";
  }
}

// Negative, zero or positive as a is older than, the same as, or newer than b.
function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

// An installed copy newer than the one Chrome is running means the files on disk were updated and
// Chrome is still running the old ones. The protocol reload above catches that only when the update
// changed the protocol, which most do not: so after most updates the extension stayed old until the
// user happened to press reload, and nothing said so. The relay -- started from the installed copy
// -- reports the installed version in bridge_ready, and this reloads to pick it up.
//
// Only while nobody is using the extension: no session holds a tab, no command is running, and none
// has run for RELOAD_QUIET_MS. A reload takes every debugger, highlight and group off the tabs, so
// an agent mid-task must never meet one, and the quiet period is what keeps an agent that lets go of
// its last tab and at once opens another from landing in the second the reload takes. Checked when
// the report arrives, after each command, and on the reconnect alarm -- each a quiet period later.
//
// Once per installed version, remembered across the reload like the protocol one, so a copy loaded
// from a folder that was NOT updated comes back still old and does not reload again for it.
const RELOADED_FOR_VERSION_KEY = "chrome_control_mcp.reloadedForVersion";
const RELOAD_QUIET_MS = 10000;
const versionReload = {
  // The newest installed version a relay has reported that is newer than this extension, or null.
  newer: null,
  commandsRunning: 0,
  lastCommandEndedAt: 0,
  timer: null,
};

function noteInstalledVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    return;
  }
  const running = extensionVersion();
  if (running === "" || compareVersions(version, running) <= 0) {
    return;
  }
  if (
    versionReload.newer === null ||
    compareVersions(version, versionReload.newer) > 0
  ) {
    versionReload.newer = version;
  }
  scheduleVersionReload();
}

// Whether anything could be cut off by a reload now.
function extensionInUse() {
  if (versionReload.commandsRunning > 0) {
    return true;
  }
  if (Date.now() - versionReload.lastCommandEndedAt < RELOAD_QUIET_MS) {
    return true;
  }
  return [...sessions, ...pendingLeases.values()].some(
    (session) => session.tabs.size > 0,
  );
}

// Look again a quiet period from now, replacing any look already due: after a command the period
// runs from that command's end.
function scheduleVersionReload() {
  if (versionReload.newer === null) {
    return;
  }
  if (versionReload.timer !== null) {
    clearTimeout(versionReload.timer);
  }
  versionReload.timer = setTimeout(() => {
    versionReload.timer = null;
    void reloadForNewerInstall();
  }, RELOAD_QUIET_MS);
}

async function reloadForNewerInstall() {
  const version = versionReload.newer;
  if (version === null || extensionInUse()) {
    return;
  }
  try {
    const stored = await chrome.storage.local.get(RELOADED_FOR_VERSION_KEY);
    const before = stored ? stored[RELOADED_FOR_VERSION_KEY] : undefined;
    if (before === version) {
      // Reloaded for it already and still older: the folder Chrome loads was not updated.
      versionReload.newer = null;
      return;
    }
    await chrome.storage.local.set({ [RELOADED_FOR_VERSION_KEY]: version });
    // Asked again with nothing awaited between the answer and the reload: a command that started
    // while storage answered is never cut off. Put back, so a later look can still reload for it.
    if (extensionInUse()) {
      await chrome.storage.local.set({
        [RELOADED_FOR_VERSION_KEY]: before ?? null,
      });
      return;
    }
    chrome.runtime.reload();
  } catch (_e) {
    // Not reloaded: the server's notice tells the agent, and through it the user, to do it by hand.
  }
}

function scheduleReconnect(session) {
  if (session.reconnectTimer) {
    return;
  }
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    // The session this timer belonged to is finished: reconnecting means asking
    // for a fresh one, not reviving this record.
    sessions.delete(session);
    // Forced because THIS is the interval: the timer above already waited it out.
    connect({ force: true });
  }, reconnectDelayMs);
}

function onDisconnect(session) {
  const err = chrome.runtime.lastError;
  session.health.connected = false;
  session.health.error = err ? err.message : "port closed";
  session.bridgeReady = false; // the next host must handshake again before it can command us
  session.port = null;
  if (session.probe) {
    probeOpenedAt = 0; // this probe is over, whatever it found; the next one may go
  }
  console.warn("[ChromeControlMCP] host disconnected:", session.health.error);
  // Losing the port is not, by itself, the server going away: a relay can drop while its server
  // runs on. The session's tabs are parked rather than dropped -- debugger detached, highlight off,
  // group and holdings kept -- and the next offer decides: the server is still offered, so a port
  // attaches to it and picks its tabs back up; or it is not, and the session has ended, so its tabs
  // are cleaned up the way a release would.
  parkSession(session);
  if (session.surplus) {
    sessions.delete(session); // it had no server; there is nothing to retry for
    return;
  }
  // A port that never reached a bridge is the case the interval is for. One that DID reach one and
  // then lost it is a different fact -- the server went away, and it may well come straight back --
  // so it keeps the short interval it earned.
  // The window opens here, where the failure is known. Until an attempt has actually failed there
  // is nothing to hold off, which is why two editors can each open a port at once.
  nextAttemptAt = Date.now() + reconnectDelayMs;
  rememberBackoff();
  scheduleReconnect(session);
  // Longer NEXT time, not this time: a server that has only just gone (or that was a moment from
  // starting) is still picked up at the short interval, and it is the run of failures after that
  // which earns the waiting. A port that reached a bridge and then lost it keeps the short
  // interval outright -- the server going away is a different fact from one never being there.
  if (!session.everReady) {
    growReconnectDelay();
  }
}

// Open one native port and give it a session of its own.
//
// Chrome starts a separate host process per port, so a port IS a session: the
// relay behind it attaches to exactly one server. The session is closed over by
// this port's listeners, which is why no frame ever has to be matched back to a
// session by searching -- the closure already knows.
function connect({ force = false } = {}) {
  if (!connectAttemptAllowed(force)) {
    return null;
  }
  const session = makeSession();
  try {
    session.port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    session.health.connected = false;
    session.health.error = String(e);
    console.error("[ChromeControlMCP] connectNative threw:", e);
    scheduleReconnect(session);
    return null;
  }
  sessions.add(session);
  session.port.onMessage.addListener((msg) => onHostMessage(session, msg));
  session.port.onDisconnect.addListener(() => onDisconnect(session));
  return session.port;
}

function send(session, reply) {
  if (!session.port) {
    console.warn(
      "[ChromeControlMCP] no port to reply on; dropping",
      reply && reply.id,
    );
    return;
  }
  try {
    session.port.postMessage(reply);
  } catch (e) {
    // The reply IS the exchange: a frame that never reaches the relay leaves the app waiting out
    // its whole I/O deadline and then reporting a transport reset for a delivery failure already
    // known here. Posting a second frame down the same port cannot work either, so the port is
    // torn down at once -- the app fails in milliseconds with the connection gone, and the next
    // command arrives only after a fresh handshake.
    console.error("[ChromeControlMCP] postMessage threw:", e);
    const dead = session.port;
    session.port = null;
    try {
      dead.disconnect();
    } catch (_e) {
      // Already gone; the local state below is what matters.
    }
    session.health.connected = false;
    session.health.error =
      "reply could not be delivered: " +
      (e && e.message ? e.message : String(e));
    session.bridgeReady = false; // a reconnected host must handshake again before it can command us
    // Same as a lost port: the tabs wait, parked, for the next offer to say whether the server is
    // still there to pick them back up.
    parkSession(session);
    scheduleReconnect(session);
  }
}

// -- Recording ---------------------------------------------------------------

// Chrome allows exactly one offscreen document per extension, so this is shared
// by every session; the recorders inside it are keyed by session id.
const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_TARGET = "chrome_control_mcp.offscreen";

let offscreenReady = null;

async function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const existing = await chrome.runtime
        .getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })
        .catch(() => []);
      if (!existing || existing.length === 0) {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: ["USER_MEDIA"],
          justification:
            "Encoding a tab recording to webm, which needs a DOM the service worker does not have.",
        });
      }
    })();
    // A failed creation must not be remembered as success, or every later
    // recording would skip straight to messaging a document that is not there.
    offscreenReady = offscreenReady.catch((e) => {
      offscreenReady = null;
      throw e;
    });
  }
  return offscreenReady;
}

async function toOffscreen(message) {
  await ensureOffscreen();
  const reply = await chrome.runtime.sendMessage({
    ...message,
    target: OFFSCREEN_TARGET,
  });
  if (!reply || reply.ok !== true) {
    throw new Error((reply && reply.error) || "The recorder did not answer.");
  }
  return reply;
}

// A screencast frame for a session that is recording. Acknowledged either way:
// CDP stops sending frames until the last one is acked, so a dropped ack stalls
// the capture rather than merely losing a frame.
async function onScreencastFrame(session, tabId, params) {
  const sessionId = session.recording && session.recording.id;
  try {
    if (sessionId && params && params.data) {
      await toOffscreen({
        type: "record.frame",
        session: sessionId,
        data: params.data,
      });
    }
  } catch (_e) {
    // A frame that could not be drawn is a gap in the video, not a reason to
    // tear the session down.
  }
  if (params && typeof params.sessionId === "number") {
    await sendCdp(tabId, "Page.screencastFrameAck", {
      sessionId: params.sessionId,
    }).catch(() => undefined);
  }
}

// Every command that runs while recording, with the moment it ran and the DOM
// generation it ran against. This is the machine-readable half of a recording:
// it needs no second encoder, and it is what lets the video be read against
// what drove it.
function noteCommandForRecording(session, id, cmd) {
  const recording = session.recording;
  if (!recording || recording.timeline.length >= MAX_TIMELINE_ENTRIES) {
    return;
  }
  const recorded = session.tabs.get(recording.tabId);
  recording.timeline.push({
    id,
    cmd,
    offset_ms: Date.now() - recording.startedAt,
    dom_epoch: recorded ? recorded.domEpoch : null,
  });
}

// Enough for a long run; a cap because the timeline is held in memory and a
// runaway loop must not be able to grow it without bound.
const MAX_TIMELINE_ENTRIES = 5000;

function relativeName(name, fallback) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length === 0) {
    return fallback;
  }
  if (/^([a-zA-Z]:|\\|\/)/.test(trimmed) || trimmed.indexOf("..") >= 0) {
    throw new Error(
      'browser_record_start filename must be a relative name without "..".',
    );
  }
  return trimmed;
}

// A recording is of ONE tab, so a command that would move the session off it is
// refused while recording rather than silently ending the video.
//
// The involuntary cases are different and are not routed here: a tab that
// closes, or DevTools detaching us, ends the attachment and there is nothing
// left to record, so those discard. What must not happen is losing a recording
// to an action the operator could simply have done in the other order.
function requireNotRecording(session, what) {
  if (session.recording) {
    throw new Error(
      what +
        " is refused while this session is recording: a recording follows one " +
        "tab. Call browser_record_stop first.",
    );
  }
}

async function handleRecordStart(session, tabId, args) {
  if (session.recording) {
    // Refused rather than restarted: a start that silently discarded the first
    // recording would lose work with no way to tell it had happened.
    throw new Error(
      "This session is already recording. Call browser_record_stop first.",
    );
  }
  await ensureAttached(session, tabId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = relativeName(
    args && args.filename,
    "chrome-control-mcp/recording-" + stamp + ".webm",
  );
  if (!/\.webm$/i.test(filename)) {
    throw new Error("browser_record_start filename must end in .webm.");
  }
  const id = "rec-" + stamp + "-" + Math.random().toString(16).slice(2, 10);
  await toOffscreen({ type: "record.start", session: id });
  session.recording = {
    id,
    tabId,
    startedAt: Date.now(),
    filename,
    timeline: [],
  };
  try {
    await sendCdp(tabId, "Page.startScreencast", RECORDING_SCREENCAST);
  } catch (e) {
    // The encoder is already up; leaving it running with nothing feeding it
    // would leak it for the life of the worker.
    discardRecording(session);
    throw e;
  }
  return { ok: true, recording: true, filename };
}

// Screencast settings for a recording, as opposed to the single-frame forcing
// used by screenshots: JPEG because it is what the protocol offers, and a
// bounded size so a large page does not make every frame enormous.
const RECORDING_SCREENCAST = {
  format: "jpeg",
  quality: 80,
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 1,
};

async function handleRecordStop(session) {
  const recording = session.recording;
  if (!recording) {
    throw new Error("This session is not recording.");
  }
  session.recording = null;
  await sendCdp(recording.tabId, "Page.stopScreencast", {}).catch(
    () => undefined,
  );
  const finished = await toOffscreen({
    type: "record.stop",
    session: recording.id,
  });
  const durationMs = Date.now() - recording.startedAt;
  const videoPath = await saveRecordingFile(finished.url, recording.filename);
  const timelineName = recording.filename.replace(/\.webm$/i, ".timeline.json");
  const timeline = {
    recording: recording.id,
    started_at: new Date(recording.startedAt).toISOString(),
    duration_ms: durationMs,
    commands: recording.timeline,
  };
  const timelinePath = await saveRecordingFile(
    "data:application/json;base64," +
      btoa(unescape(encodeURIComponent(JSON.stringify(timeline, null, 2)))),
    timelineName,
  );
  return {
    ok: true,
    path: videoPath,
    bytes: finished.bytes,
    duration_ms: durationMs,
    commands: recording.timeline.length,
    timeline_path: timelinePath,
  };
}

// Land a data: url on disk and report where it went. The video never comes back
// through a tool reply: the bridge is one command, one reply, with hard caps on
// the reply, so a path is the only thing a video can be reported as.
async function saveRecordingFile(url, filename) {
  const id = await chrome.downloads.download({
    url,
    filename,
    conflictAction: "uniquify",
    saveAs: false,
  });
  if (typeof id !== "number") {
    throw new Error("The recording could not be saved.");
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [item] = await chrome.downloads.search({ id });
    if (item && item.state === "complete") {
      return item.filename;
    }
    if (item && item.state === "interrupted") {
      throw new Error(
        "Saving the recording was interrupted: " + (item.error || "unknown"),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Saving the recording did not finish in time.");
}

// -- Frame dispatch ----------------------------------------------------------

function onHostMessage(session, msg) {
  if (!msg || typeof msg !== "object") {
    return;
  }
  if (msg.type === "bridge_offers") {
    // The relay lists the servers publishing a bridge record and asks which one
    // this port should attach to. This worker cannot discover them by itself --
    // it has no filesystem access -- so the offer is the only way it learns
    // that any exist, which is why the relay asks rather than being told.
    //
    // Answering is the ONLY circumstance in which this worker speaks first on
    // this channel. A frame sent unprompted would be read by an older relay as
    // the reply to a command it had not yet sent, putting every later exchange
    // one step out of phase.
    const offered = Array.isArray(msg.servers) ? msg.servers.map(String) : [];
    if (session.probe) {
      probeOpenedAt = 0;
    }
    noteOfferedServers(offered);
    // One port per server: this port takes a server nothing else holds. If every
    // offered server is already taken, this port has no work -- it answers with
    // no session, and the relay reports the bridge unavailable and exits rather
    // than being left waiting.
    const available = unheldServers(offered);
    session.serverId = available.length > 0 ? available[0] : "";
    // With this extension's version, which the relay passes on to the server: an update that keeps
    // the protocol leaves Chrome running the old extension, and the server is what can tell the
    // agent. An older relay reads only the session.
    send(session, {
      type: "attach_session",
      session: session.serverId,
      version: extensionVersion(),
    });
    if (session.serverId === "") {
      // Every offered server is already held, so this port has nothing to do.
      // Mark it so losing it does not start the reconnect cycle: retrying would
      // open another surplus port every two seconds forever. An offer listing
      // NO servers is different -- nothing is running yet, and that is exactly
      // the case the reconnect cycle exists for.
      session.surplus = offered.length > 0;
      return;
    }
    // Another editor is running and nothing is attached to its server yet. One
    // more port is opened here; its own offer opens the next if more remain, so
    // the chain converges without this having to loop over an answer that has
    // not arrived yet.
    if (available.length > 1) {
      // Not a retry: this port's own offer named a server nothing holds, so the next port has
      // somewhere to go. The waiting interval is about bridges that are NOT there.
      connect({ force: true });
    }
    return;
  }
  if (msg.type === "bridge_servers") {
    // An attached relay saying the set of live servers changed: an editor started, or one
    // went away. It is the relay's own directory check, so hearing it costs no process --
    // unlike the alarm's probe, which has to start one to ask. A server nothing holds gets a
    // port now rather than up to a probe interval later; one that went away settles the
    // tabs its session left parked. Never answered: the relay does not wait for anything.
    const live = Array.isArray(msg.servers) ? msg.servers.map(String) : [];
    noteOfferedServers(live);
    if (unheldServers(live).length > 0) {
      probeForServers({ force: true });
    }
    return;
  }
  if (msg.type === "bridge_ready") {
    session.health.connected = true;
    session.health.bridge = "ready";
    session.health.error = null;
    session.everReady = true;
    resetReconnectDelay();
    showBridgeState();
    session.bridgeReady = msg.protocol === BRIDGE_PROTOCOL;
    if (!session.bridgeReady) {
      session.health.error = protocolMismatchText(msg.protocol);
      noteServerRefused(session.serverId);
      void reloadForNewerHost(msg.protocol);
    } else {
      // A server whose relay dropped and came back finds its tabs where it left them.
      resumeParkedSession(session);
    }
    // The relay's own version is the installed one: newer than this means the files were updated.
    noteInstalledVersion(msg.version);
    console.info("[ChromeControlMCP] bridge ready, protocol", msg.protocol);
    return;
  }
  if (msg.type === "bridge_unavailable") {
    session.health.connected = false;
    session.health.bridge = "unavailable";
    session.health.error = msg.error || "bridge unavailable";
    session.bridgeReady = false;
    // The server this port asked for would not take it. Asked again at once it would refuse
    // again, and each asking is a process: set it aside for a while instead.
    noteServerRefused(session.serverId);
    console.warn(
      "[ChromeControlMCP] bridge unavailable:",
      session.health.error,
    );
    return;
  }
  if (msg.type === "cancel") {
    // The host abandoning an exchange (its own I/O deadline elapsed) has no other way to stop a
    // handler that POLLS: browser_wait_for and browser_download keep driving the browser for as
    // long as their own timeout allows, then post a reply into a relay that has already been
    // reset. Retiring the generation is the signal those loops watch; the command they belong to
    // then fails with its own error, so the one-reply-per-command rule still holds. A cancel is
    // not a command frame and is never replied to.
    session.commandGeneration++;
    return;
  }
  if (msg.type === "command") {
    // A command frame has to be addressable and dispatchable before any of it runs: the id is
    // what correlates the single reply, the cmd is what selects the handler, and neither can be
    // inferred from the rest of the frame. A frame with no usable id cannot even be told so.
    if (typeof msg.id !== "string" || msg.id.length === 0) {
      console.warn(
        "[ChromeControlMCP] command frame with no usable id; dropping",
      );
      return;
    }
    if (typeof msg.cmd !== "string" || msg.cmd.length === 0) {
      send(session, {
        type: "error",
        id: msg.id,
        cmd: "",
        error: "The command frame carries no command name.",
      });
      return;
    }
    // The relay writes bridge_ready before it pumps a single command, so a command that
    // arrives without one comes from a host that never handshook -- or from one whose
    // protocol we already know we do not speak. Refuse it (still exactly one reply per
    // command frame, so the relay's one-op pump stays in step).
    if (!session.bridgeReady) {
      send(session, {
        type: "error",
        id: msg.id,
        cmd: msg.cmd,
        error:
          session.health.error ||
          "The bridge has not completed its readiness handshake.",
      });
      return;
    }
    handleCommand(session, msg);
    return;
  }
  console.warn("[ChromeControlMCP] unexpected frame type:", msg.type);
}

// How often a command that is still running says so.
//
// The host's reply budget was a SILENCE budget being spent as a work budget: 30 s with no frame
// on the pipe tore the connection down, while handlers are allowed far longer than that by
// design (browser_download runs to 120 s). A slow page, a big download or a loaded machine
// therefore surfaced as "browser did not reply within 30000 ms (connection reset)" -- a
// transport failure reported for work that was proceeding normally, and a connection reset for
// a browser that was fine. A beat inside the budget is what tells those two apart: the host
// restarts its deadline on each one and keeps a cap on the total, so silence still fails fast
// and progress no longer does.
//
// It earns its keep a second time in MV3. Chrome retires an idle service worker, and posting on
// the port is activity -- so the same beat that reports the work also keeps the worker that is
// doing it alive.
const PROGRESS_BEAT_MS = 5000;

// Beat for as long as `msg` is being handled, or null if the host did not ask for one.
//
// Only for a host that asked. An older server never sets the flag, and it would read a frame
// type it does not know as the reply to the command it is waiting for -- so the flag is what
// keeps a new extension safe in front of an old server.
function startProgressBeat(session, msg) {
  if (msg.progress !== true) {
    return null;
  }
  const started = Date.now();
  return setInterval(() => {
    send(session, {
      type: "progress",
      id: msg.id,
      cmd: msg.cmd,
      elapsed_ms: Date.now() - started,
    });
  }, PROGRESS_BEAT_MS);
}

function stopProgressBeat(beat) {
  if (beat !== null) {
    clearInterval(beat);
  }
}

async function handleCommand(session, msg) {
  const id = msg.id;
  const cmd = msg.cmd;
  // Every arriving frame retires whatever came before it. A polling handler captures this value
  // and re-reads it each iteration, so a loop whose command is no longer the live one stops
  // instead of running on against a page (and a relay) that has moved on without it.
  session.commandGeneration++;
  // Counted before anything awaits, so a reload that looks now sees this command.
  versionReload.commandsRunning += 1;
  beginCommand(session, msg);
  // A recording is a video of commands running, so the commands are recorded
  // too -- before the work, so the offset is when it started rather than when
  // it finished.
  noteCommandForRecording(session, id, cmd);
  const beat = startProgressBeat(session, msg);
  // The reply is built first and sent after the beat has stopped. Sending inside the try would
  // leave a window where the interval can still fire, and a progress frame AFTER the reply is
  // the one thing this must never do: the host has moved on, and it would read as the answer to
  // whatever command comes next.
  let reply;
  try {
    reply = {
      type: "result",
      id,
      cmd,
      payload: reportSideEffects(session, await runCommand(session, cmd, msg)),
    };
  } catch (e) {
    reply = {
      type: "error",
      id,
      cmd,
      error: e && e.message ? e.message : String(e),
    };
  } finally {
    stopProgressBeat(beat);
    endCommand(session, cmd);
    versionReload.commandsRunning -= 1;
    versionReload.lastCommandEndedAt = Date.now();
  }
  stampReply(session, reply);
  send(session, reply);
  scheduleVersionReload();
}

// What a command needs settled before it runs: who is asking, that the session is awake, and a
// clean slate for what this command will report about itself.
function beginCommand(session, msg) {
  session.lastCommandAt = Date.now();
  session.actedTabId = null;
  // openedDuringCommand and chooserDuringCommand are NOT reset here: a tab or picker a page opened
  // in the grace after the previous command replied is still news, and goes on this reply.
  // The server names its MCP client so the group can say whose tabs these are. Page- and
  // model-free (it is the client's own self-description, forwarded by the server), but still
  // bounded and stripped to printable text before it reaches the tab strip.
  if (typeof msg.client === "string") {
    const label = tabStripText(msg.client, 32);
    if (label !== session.label) {
      session.label = label;
      queueGroupSync(session);
    }
  }
  if (OPENER_COMMANDS.has(msg.cmd)) {
    session.openerUntil = Infinity;
  }
}

// How long after a command that can open things a page's new tab or file picker still counts as
// that command's doing. A click handler that opens its popup or picker after an await, a timer or
// a fetch lands a little after the click itself returns.
const OPENER_GRACE_MS = 2000;

// The commands whose page can, as a result, open a tab or a file picker: everything that delivers
// input or loads a document. A tab opened from the session's page while anything ELSE is running --
// a screenshot, a snapshot, a wait -- is the user's (middle-click, Ctrl+T), not the agent's.
const OPENER_COMMANDS = new Set([
  "click",
  "clickAt",
  "jsClick",
  "hover",
  "drag",
  "type",
  "pressKey",
  "select",
  "setValue",
  "media",
  "navigate",
  "back",
  "forward",
  "reload",
  "upload",
]);

function endCommand(session, cmd) {
  if (OPENER_COMMANDS.has(cmd)) {
    session.openerUntil = Date.now() + OPENER_GRACE_MS;
    scheduleFilePickerDisarm(session);
  }
}

// Fold what the command caused into its answer, when the answer has room for it. A payload that
// is not a plain object (none today) is left exactly as the handler built it.
function reportSideEffects(session, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  if (session.openedDuringCommand.length > 0) {
    payload.opened_tabs = session.openedDuringCommand.map((entry) => ({
      tab_id: entry.tab_id,
      url: entry.url,
      current: entry.tab_id === session.currentTabId,
    }));
    session.openedDuringCommand = [];
  }
  if (session.chooserDuringCommand) {
    payload.file_chooser = session.chooserDuringCommand;
    session.chooserDuringCommand = null;
  }
  // A copy or paste button the agent clicked used the agent's clipboard; say so, or the agent
  // cannot tell that the page's "Copied!" put anything anywhere.
  if (session.clipboardDuringCommand) {
    payload.page_clipboard = session.clipboardDuringCommand;
    session.clipboardDuringCommand = null;
  }
  return payload;
}

// The reply says which tab it acted on and that tab's DOM generation, so the server checks the
// refs bound to THAT tab -- and which tabs this session let go of, so it drops theirs. A command
// that touched no tab says nothing about any, rather than repeating some other tab's epoch.
//
// A command that acted on a tab always names it -- even one it just closed or let go of, and a
// user's tab it closed by index -- because the server reads a tab-scoped reply naming no tab as a
// change it cannot place, and retires EVERY tab's refs: one agent closing its own tab would
// silently invalidate every other agent's snapshot. A tab the session no longer holds carries a
// generation of 0; the server holds no refs for it worth checking, and drops it via goneTabIds.
function stampReply(session, reply) {
  if (session.actedTabId === null) {
    if (session.goneTabIds.size > 0) {
      reply.goneTabIds = [...session.goneTabIds];
      session.goneTabIds.clear();
    }
    return;
  }
  const acted = session.tabs.get(session.actedTabId);
  reply.tabId = session.actedTabId;
  reply.domEpoch = acted ? acted.domEpoch : 0;
  if (session.goneTabIds.size > 0) {
    reply.goneTabIds = [...session.goneTabIds];
    session.goneTabIds.clear();
  }
}

async function runCommand(session, cmd, args) {
  try {
    return await dispatchCommand(session, cmd, args);
  } finally {
    // The handles this command resolved end with it; nothing outlives the dispatch that made them.
    await releaseCdpObjects(session);
  }
}

// The command table. Each entry declares what its handler needs rather than repeating a
// call shape for every command: `tab` means the handler is given the active tab id, `args` means it
// is given the command's arguments.
//
// This is a Map, NOT an object literal, and that is a security property rather than a
// style choice. `cmd` arrives from the native-messaging relay, so an object literal would
// resolve inherited names -- COMMAND_TABLE["constructor"] and ["toString"] are truthy on
// any plain object, so a frame naming one would pass the "is this a known command?" test
// and then be called. A Map has no prototype chain to walk, so only keys put here match.
const COMMAND_TABLE = new Map([
  ["snapshot", { fn: captureSnapshot, tab: true, args: false }],
  ["read", { fn: handleRead, tab: true, args: true }],
  ["navigate", { fn: handleNavigate, tab: true, args: true }],
  [
    "back",
    {
      fn: (session, tabId) => handleHistory(session, tabId, "back"),
      tab: true,
      args: false,
    },
  ],
  [
    "forward",
    {
      fn: (session, tabId) => handleHistory(session, tabId, "forward"),
      tab: true,
      args: false,
    },
  ],
  ["reload", { fn: handleReload, tab: true, args: false }],
  ["listTabs", { fn: handleListTabs, tab: false, args: false }],
  ["selectTab", { fn: handleSelectTab, tab: false, args: true }],
  ["newTab", { fn: handleNewTab, tab: false, args: true }],
  ["closeTab", { fn: handleCloseTab, tab: false, args: true }],
  ["click", { fn: handleClick, tab: true, args: true }],
  ["clickAt", { fn: handleClickAt, tab: true, args: true }],
  ["hover", { fn: handleHover, tab: true, args: true }],
  ["drag", { fn: handleDrag, tab: true, args: true }],
  ["dialog", { fn: handleDialog, tab: true, args: true }],
  ["type", { fn: handleType, tab: true, args: true }],
  ["select", { fn: handleSelect, tab: true, args: true }],
  ["setValue", { fn: handleSetValue, tab: true, args: true }],
  ["media", { fn: handleMedia, tab: true, args: true }],
  ["pressKey", { fn: handlePressKey, tab: true, args: true }],
  ["scroll", { fn: handleScroll, tab: true, args: true }],
  ["screenshot", { fn: handleScreenshot, tab: true, args: true }],
  ["groupTabs", { fn: handleGroupTabs, tab: false, args: true }],
  ["ungroupTabs", { fn: handleUngroupTabs, tab: false, args: true }],
  ["waitFor", { fn: handleWaitFor, tab: true, args: true }],
  ["console", { fn: handleConsole, tab: true, args: true }],
  ["network", { fn: handleNetwork, tab: true, args: true }],
  ["getValue", { fn: handleGetValue, tab: true, args: true }],
  ["getAttribute", { fn: handleGetAttribute, tab: true, args: true }],
  ["box", { fn: handleBox, tab: true, args: true }],
  ["focus", { fn: handleFocus, tab: true, args: true }],
  ["reveal", { fn: handleReveal, tab: true, args: true }],
  ["jsClick", { fn: handleJsClick, tab: true, args: true }],
  ["listWindows", { fn: handleListWindows, tab: false, args: false }],
  ["window", { fn: handleWindow, tab: false, args: true }],
  ["emulate", { fn: handleEmulate, tab: true, args: true }],
  ["print", { fn: handlePrint, tab: true, args: true }],
  ["permission", { fn: handlePermission, tab: false, args: true }],
  ["storage", { fn: handleStorage, tab: true, args: true }],
  ["cookies", { fn: handleCookies, tab: false, args: true }],
  // Given the tab so its poll is timed by that page's clock, not this worker's.
  ["download", { fn: handleDownload, tab: true, args: true }],
  ["recordStart", { fn: handleRecordStart, tab: true, args: true }],
  ["recordStop", { fn: handleRecordStop, tab: false, args: false }],
  ["httpAuth", { fn: handleHttpAuth, tab: true, args: true }],
  // Carries bytes only: it names no element and touches no page, so it needs no tab.
  [
    "uploadChunk",
    {
      fn: (session, args) => handleUploadChunk(session, args),
      tab: false,
      args: true,
    },
  ],
  ["upload", { fn: handleUpload, tab: true, args: true }],
  ["clipboard", { fn: handleClipboard, tab: true, args: true }],
  ["release", { fn: handleRelease, tab: false, args: true }],
]);

async function dispatchCommand(session, cmd, args) {
  const entry = COMMAND_TABLE.get(cmd);
  if (!entry) {
    throw new Error("Unknown command: " + cmd);
  }
  // A session that went quiet had its tabs stood down; any command picks them back up first, so
  // the agent finds its tabs exactly as it left them, highlighted and grouped again.
  if (session.idle) {
    resumeSession(session);
  }
  // Every handler takes the session it is acting for as its first argument,
  // then the tab and the arguments it asked for. Nothing reaches session state
  // except through what it was handed.
  const params = [session];
  let tab = null;
  if (entry.tab) {
    const tabId = await commandTabId(session, args);
    tab = session.tabs.get(tabId) || null;
    params.push(tabId);
  }
  if (entry.args) {
    params.push(args);
  }
  // Scope an armed dialog response to the SINGLE command meant to trigger the dialog, on the tab
  // it was armed on: if that command runs without the dialog firing (which would consume the arm
  // in the onEvent handler), drop the arm so it can never persist and auto-answer an unrelated
  // later dialog. The arming command itself ("dialog") is excluded so it can set the policy.
  // Capture the exact policy object and clear only if it is STILL that object -- so a fresh arm
  // placed by a later command is never clobbered, only the one scoped here.
  const scopedPolicy = tab && cmd !== "dialog" ? tab.pendingDialogPolicy : null;
  // Expose the arm to the dialog handler only for the duration of this dispatch, so a dialog the
  // page fires on its own schedule (between tool calls) cannot consume it.
  if (scopedPolicy !== null) {
    tab.dialogArmActive = true;
  }
  // A page that asks for a file during this command gets the agent's answer, not a native dialog
  // Chrome would refuse to a background tab -- or show over the user's work for a foreground one.
  if (tab && OPENER_COMMANDS.has(cmd)) {
    await armFilePickers(session, tab);
  }
  // The page in this tab may use the agent's clipboard while the agent's own input reaches it,
  // and for a moment after -- a click handler that copies after an await lands just past the click.
  const opensClipboard = Boolean(tab) && CLIPBOARD_COMMANDS.has(cmd);
  if (opensClipboard) {
    tab.inputUntil = Infinity;
  }
  try {
    return await entry.fn(...params);
  } catch (error) {
    throw await explainUnreachablePage(tab, error);
  } finally {
    if (opensClipboard) {
      tab.inputUntil = Date.now() + OPENER_GRACE_MS;
    }
    if (tab) {
      tab.dialogArmActive = false;
      if (scopedPolicy !== null && tab.pendingDialogPolicy === scopedPolicy) {
        tab.pendingDialogPolicy = null;
      }
    }
  }
}

// Chrome answers "Cannot attach to this target." when the page in a tab is one no extension may
// drive: its own error and security-warning pages (an expired certificate shows "Privacy error"),
// and pages that belong to the browser or to another extension. Passed on bare, it reads as a
// fault in the bridge. Say what the page is, by the title Chrome gave it, and what to do instead.
async function explainUnreachablePage(tab, error) {
  const message = String(error && error.message ? error.message : error);
  if (
    !tab ||
    !/Cannot attach to this target|Cannot access a chrome/i.test(message)
  ) {
    return error;
  }
  const shown = await chrome.tabs.get(tab.id).catch(() => null);
  const title = shown && shown.title ? shown.title : "";
  return new Error(
    "Chrome will not let an extension control the page tab " +
      tab.id +
      " is showing" +
      (title ? ' ("' + title.slice(0, 120) + '")' : "") +
      ". That is usually a Chrome error or security warning -- an expired or invalid " +
      'certificate shows "Privacy error" -- or a page that belongs to the browser or another ' +
      "extension. Navigate the tab to an ordinary web page, or use a different site.",
    { cause: error },
  );
}

// -- Tabs a session holds -----------------------------------------------------
//
// A session holds every tab it works in, not one: the tab it was handed, the ones it opened, the
// ones its own clicks opened. They are all marked the same way -- in the session's tab group, with
// the frame and badge drawn on the page and the toolbar chip -- so the user can see at a glance
// which tabs are the assistant's, and every one of them stays the assistant's until it closes,
// the user takes it back, or the session lets it go.
//
// The tab strip's mark is a group per AGENT: each session's tabs, split further by the agent name a
// tool call gave (several agents can share one server, and the server cannot otherwise tell them
// apart). Each group gets a colour no other live group has, and the frame and badge drawn on the
// page use that same colour, so a page can be matched to its group -- and so to its agent -- at a
// glance. Titled with the agent's name, else the MCP client's, else "AI CONTROL". The group is never
// collapsed by us, so no held tab is ever hidden from the user. A tab the user had already put in a
// group of their own stays there: pulling it out would rearrange their tab strip.
const CONTROL_GROUP_TITLE = "AI CONTROL";
const CONTROL_GROUP_PREFIX = "AI · ";
const IDLE_GROUP_SUFFIX = " (idle)";
// In the order groups are given them. Pink first, the colour the page frame always had; then the
// colours that sit furthest from it and from each other, so two or three agents side by side are
// told apart at a glance. Purple is last: next to pink it is the hardest pair to tell apart.
const SESSION_COLORS = [
  "pink",
  "cyan",
  "orange",
  "blue",
  "green",
  "yellow",
  "red",
  "purple",
];

// The colours Chrome draws its tab groups in, so the frame on the page matches the group exactly.
const GROUP_COLOR_HEX = Object.freeze({
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#ff2d95",
  purple: "#a142f4",
  cyan: "#007b83",
  orange: "#fa903e",
});

function groupTitle(session, agent) {
  let base = CONTROL_GROUP_TITLE;
  if (agent) {
    base = CONTROL_GROUP_PREFIX + agent;
  } else if (session.label) {
    base = CONTROL_GROUP_PREFIX + session.label;
  }
  return session.idle ? base + IDLE_GROUP_SUFFIX : base;
}

// One group per agent per window: tab groups belong to exactly one window.
function groupKey(windowId, agent) {
  return windowId + "|" + (agent || "");
}

// The colour of an agent's group: the one it already has, or one no other live group is using.
// The first group anyone gets is pink, the colour the page frame always had.
function agentColor(session, agent) {
  const key = agent || "";
  const known = session.colors.get(key);
  if (known) {
    return known;
  }
  const used = new Set();
  for (const other of [...sessions, ...pendingLeases.values()]) {
    for (const color of other.colors.values()) {
      used.add(color);
    }
  }
  const color =
    SESSION_COLORS.find((candidate) => !used.has(candidate)) ||
    SESSION_COLORS[session.colors.size % SESSION_COLORS.length];
  session.colors.set(key, color);
  return color;
}

// The hex colour to draw a held tab's frame and badge in.
function presenceColorFor(tabId) {
  const held = holderOf(tabId);
  if (!held) {
    return GROUP_COLOR_HEX.pink;
  }
  if (held.session.idle) {
    return GROUP_COLOR_HEX.grey;
  }
  return (
    GROUP_COLOR_HEX[agentColor(held.session, held.tab.agent)] ||
    GROUP_COLOR_HEX.pink
  );
}

// Whether a group title is one this extension writes. Used only to recognise groups left behind
// by a worker that no longer remembers them, which are then ungrouped -- never closed.
function isControlGroupTitle(title) {
  return (
    typeof title === "string" &&
    (title.startsWith(CONTROL_GROUP_TITLE) ||
      title.startsWith(CONTROL_GROUP_PREFIX))
  );
}

// Group changes this worker is making itself, by tab id, until when. Chrome reports our own
// group/ungroup calls through the same tabs.onUpdated the user's drags arrive on, and a drag OUT
// of the AI group means "this tab is mine again" -- so our own moves have to be recognisable or
// the worker would read every regrouping as the user taking the tab back.
const expectedGroupChanges = new Map();
const GROUP_CHANGE_SETTLE_MS = 1500;

function expectGroupChange(tabIds) {
  const until = Date.now() + GROUP_CHANGE_SETTLE_MS;
  for (const id of tabIds) {
    expectedGroupChanges.set(id, until);
  }
}

function groupChangeExpected(tabId) {
  const until = expectedGroupChanges.get(tabId);
  if (until === undefined) {
    return false;
  }
  if (Date.now() > until) {
    expectedGroupChanges.delete(tabId);
    return false;
  }
  return true;
}

// When each recent tab was created, and which tabs are moving between windows. Chrome puts a tab
// opened from a grouped tab straight into that group, so a tab that turns up in an AI group moments
// after it was created was put there by Chrome, not by the user; and a tab dragged to another window
// leaves its group because groups are per window, not because the user took it back.
const tabCreatedAt = new Map();
const tabsMovingWindows = new Map();
const AUTO_GROUP_WINDOW_MS = 3000;

function createdRecently(tabId) {
  const at = tabCreatedAt.get(tabId);
  return at !== undefined && Date.now() - at < AUTO_GROUP_WINDOW_MS;
}

function movingWindows(tabId) {
  const at = tabsMovingWindows.get(tabId);
  return at !== undefined && Date.now() - at < AUTO_GROUP_WINDOW_MS;
}

// Markings run one at a time. Two in quick succession -- a tab the session's page opened while
// the previous one's group was still being created -- would otherwise both find no group and
// create one each, leaving the first on the user's tab strip with nothing tracking it.
let markingQueue = Promise.resolve();

function queueGroupSync(session) {
  if (session.groupSyncQueued) {
    return markingQueue;
  }
  session.groupSyncQueued = true;
  markingQueue = markingQueue.then(async () => {
    session.groupSyncQueued = false;
    await syncSessionGroups(session).catch((e) => {
      console.warn("[ChromeControlMCP] could not mark the session's tabs:", e);
    });
  });
  return markingQueue;
}

// The live or parked session whose group this is, and the agent it is for, or null.
function groupOwner(groupId) {
  if (typeof groupId !== "number" || groupId < 0) {
    return null;
  }
  for (const session of [...sessions, ...pendingLeases.values()]) {
    for (const [key, id] of session.groups) {
      if (id === groupId) {
        return { session, agent: key.slice(key.indexOf("|") + 1) };
      }
    }
  }
  return null;
}

function sessionOwningGroup(groupId) {
  const owner = groupOwner(groupId);
  return owner ? owner.session : null;
}

// Put every tab the session holds into its group in that tab's window, and give each group the
// session's title and colour. Idempotent: run it after anything that changes what the session
// holds, and it converges on the right picture.
async function syncSessionGroups(session) {
  if (!chrome.tabGroups || session.ended) {
    return; // grouping unavailable, or nothing left to mark: the page frame and badge still show
  }
  const byGroup = new Map();
  for (const [id, state] of [...session.tabs]) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab || tab.pinned) {
      continue; // closing (onRemoved drops it), or pinned -- Chrome cannot group a pinned tab
    }
    const key = groupKey(tab.windowId, state.agent);
    const ours = session.groups.get(key);
    const grouped = typeof tab.groupId === "number" && tab.groupId >= 0;
    if (grouped && tab.groupId !== ours) {
      const owner = groupOwner(tab.groupId);
      const group = owner
        ? null
        : await chrome.tabGroups.get(tab.groupId).catch(() => null);
      // A group of the user's own: leave their arrangement alone. This session's group for
      // another agent (the tab was renamed to this one), or a group this extension left behind
      // with nobody tracking it, is not the user's -- the tab moves to the right group.
      const ownGroup = owner !== null && owner.session === session;
      const orphan =
        owner === null && group !== null && isControlGroupTitle(group.title);
      if (!ownGroup && !orphan) {
        continue;
      }
    }
    if (!byGroup.has(key)) {
      byGroup.set(key, {
        windowId: tab.windowId,
        agent: state.agent,
        tabs: [],
      });
    }
    byGroup.get(key).tabs.push(tab);
  }
  for (const [key, { windowId, agent, tabs }] of byGroup) {
    let groupId = session.groups.get(key);
    if (groupId !== undefined) {
      const group = await chrome.tabGroups.get(groupId).catch(() => null);
      if (!group || group.windowId !== windowId) {
        session.groups.delete(key); // emptied and removed by Chrome, or moved away
        groupId = undefined;
      }
    }
    const loose = tabs.filter((tab) => tab.groupId !== groupId);
    const created = groupId === undefined;
    if (loose.length > 0) {
      const ids = loose.map((tab) => tab.id);
      expectGroupChange(ids);
      // In the tabs' OWN window: a group created without one lands in "the current window", which
      // MOVES the tab there -- and a window whose only tab left closes with it.
      const made = await chrome.tabs
        .group(
          created
            ? { tabIds: ids, createProperties: { windowId } }
            : { tabIds: ids, groupId },
        )
        .catch((e) => {
          console.warn("[ChromeControlMCP] could not group a held tab:", e);
          return null;
        });
      if (typeof made !== "number") {
        continue;
      }
      groupId = made;
      session.groups.set(key, groupId);
      session.lastTabListing = null; // grouping moves tabs together: every index after is unproven
    }
    const update = {
      title: groupTitle(session, agent),
      color: session.idle ? "grey" : agentColor(session, agent),
    };
    if (created) {
      update.collapsed = false; // a collapsed group would hide the tab; after that it is the user's call
    }
    await chrome.tabGroups.update(groupId, update).catch((e) => {
      console.warn(
        "[ChromeControlMCP] could not label the session's group:",
        e,
      );
    });
  }
  // A group the session holds nothing in any more: Chrome removes an emptied group itself, so only
  // the bookkeeping goes.
  for (const key of [...session.groups.keys()]) {
    if (!byGroup.has(key)) {
      session.groups.delete(key);
    }
  }
  persistLeases();
}

// Take these tabs out of the session's groups, leaving them where they are in the tab strip. Only
// tabs actually in one of the session's groups are touched: a tab in the user's own group stays.
async function ungroupFromSession(session, tabIds) {
  const ours = new Set(session.groups.values());
  const ids = [];
  for (const id of tabIds) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab && ours.has(tab.groupId)) {
      ids.push(id);
    }
  }
  if (ids.length > 0) {
    expectGroupChange(ids);
    await chrome.tabs.ungroup(ids).catch(() => {});
    session.lastTabListing = null;
  }
}

// Start holding a tab, or note that a held one was used. Returns the session's record of it.
// @p agent, when given, is the agent the tab is for, which decides its group; a held tab given a
// new agent name moves to that agent's group.
function holdTab(session, tab, origin, agent) {
  let state = session.tabs.get(tab.id);
  if (state && typeof agent === "string" && agent !== state.agent) {
    state.agent = agent;
    void refreshControlPresence(tab.id); // its frame takes the new group's colour
  }
  if (!state) {
    state = makeTabState(tab.id, origin);
    state.agent = typeof agent === "string" ? agent : "";
    session.tabs.set(tab.id, state);
    session.goneTabIds.delete(tab.id);
    // Every held tab is marked, not only the one a command is acting on: attaching is what draws
    // the frame and badge, so a tab the session holds but has not touched yet is marked too.
    attachInBackground(session, tab.id);
  }
  state.lastUsedAt = Date.now();
  if (session.sessionWindowId === null && typeof tab.windowId === "number") {
    session.sessionWindowId = tab.windowId;
  }
  queueGroupSync(session);
  persistLeases();
  return state;
}

// Make a tab the one the session's commands act on when they name none.
function setCurrentTab(session, tab, agent) {
  const held = session.tabs.get(tab.id);
  holdTab(session, tab, held ? held.origin : "adopted", agent);
  session.currentTabId = tab.id;
  session.sessionWindowId = tab.windowId;
}

function attachInBackground(session, tabId) {
  if (session.idle || !session.port) {
    return;
  }
  ensureAttached(session, tabId).catch(() => {
    // A page the debugger may not attach to (chrome://, the Web Store) is still held and still
    // grouped; it is simply not drawn on.
  });
}

// Stop holding one tab. @p closed says the tab is gone, so nothing is sent to it. The server is
// told on the next reply, so it drops the refs it bound to this tab.
async function dropTab(session, tabId, { closed = false } = {}) {
  const state = session.tabs.get(tabId);
  if (!state) {
    return;
  }
  session.tabs.delete(tabId);
  session.goneTabIds.add(tabId);
  session.lastTabListing = null;
  await detachTab(session, state, { closed });
  persistLeases();
}

// End control of one tab: retire everything known about its page, take the drawing off it, and
// detach the debugger. The tab itself is left exactly where it is.
async function detachTab(session, state, { closed = false } = {}) {
  const wasAttached = state.attached;
  // Cleared BEFORE the detach, so the onDetach listener this detach fires does not find the tab
  // still attached and release it a second time.
  state.attached = false;
  releaseTabState(session, state);
  if (closed) {
    setTabControlBadge(state.id, false);
    return;
  }
  // The page's own clipboard functions go back before the debugger does: the next document gets no
  // stand-in once the attachment ends, but the live one keeps it until it is taken off.
  await restorePageClipboard(state.id, { attached: wasAttached });
  if (wasAttached) {
    await removeControlPresence(state.id);
    await chrome.debugger.detach({ tabId: state.id }).catch(() => {
      // Already gone (tab closed / user detached); nothing to do.
    });
  } else {
    await removeControlPresenceWithoutDebugger(state.id);
  }
}

// The tab the session used most recently that is still open, or null.
async function mostRecentHeldTab(session) {
  const states = [...session.tabs.values()].sort(
    (a, b) => b.lastUsedAt - a.lastUsedAt,
  );
  for (const state of states) {
    const tab = await chrome.tabs.get(state.id).catch(() => null);
    if (tab) {
      return tab;
    }
    await dropTab(session, state.id, { closed: true });
  }
  return null;
}

// The tab a command acts on when it names none.
//
// The first command adopts the active tab of the last focused window -- the page the user was
// looking at when they handed over -- and every later command stays on the session's tab whatever
// the user does next: they may switch to another tab or window and go on working, and the session
// keeps driving its own tab in the background over the debugger protocol, never bringing it forward.
//
// If that tab closes or the user takes it back, the session moves to another tab it holds. With
// none left it does NOT fall back to some other tab: every neighbour is a tab the user may be
// using -- Chrome activates one of them on close -- and taking it over would be exactly the
// interference this worker must never commit. It says so until it is given one.
async function activeTab(session) {
  if (session.currentTabId !== null && session.tabs.has(session.currentTabId)) {
    const current = await chrome.tabs
      .get(session.currentTabId)
      .catch(() => null);
    if (current) {
      session.sessionWindowId = current.windowId; // the user may have dragged it to another window
      return current;
    }
    await dropTab(session, session.currentTabId, { closed: true });
  }
  const fallback = await mostRecentHeldTab(session);
  if (fallback) {
    setCurrentTab(session, fallback);
    return fallback;
  }
  if (session.currentTabId !== null) {
    throw new Error(
      "The session's tab has closed or been taken back by the user, and it holds no other. Open " +
        "a new one with browser_new_tab, choose one with browser_select_tab, or -- if its window " +
        "has closed as well, which leaves those two nothing to resolve against -- take a window " +
        "with browser_window new or focus. The session never takes over a tab it was not given.",
    );
  }
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tabs || !tabs.length) {
    throw new Error("No active tab.");
  }
  // Adopting the user's active tab is the one place a session takes a tab it
  // was not given, so it is also where it could take one another session is
  // already driving.
  requireUnleasedTab(session, tabs[0]);
  setCurrentTab(session, tabs[0]);
  return tabs[0];
}

// A tab this session holds, by id, as the browser has it now. A tab another session holds is
// refused naming that session; one nobody holds is refused saying how to take it.
async function heldTab(session, tabId) {
  if (!session.tabs.has(tabId)) {
    requireUnleasedTab(session, { id: tabId });
    throw new Error(
      "Tab " +
        tabId +
        " is not one of this session's tabs. Open one with browser_new_tab, or take this one " +
        "with browser_select_tab.",
    );
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    await dropTab(session, tabId, { closed: true });
    throw new Error("Tab " + tabId + " has closed.");
  }
  return tab;
}

// The tab a tab-scoped command acts on: the one it names, or the session's current tab. Naming
// a tab does not make it current -- an agent addressing its own tab must not move another agent
// that relies on the current one.
async function commandTabId(session, args) {
  const named = args ? args.tab_id : undefined;
  let tab;
  if (named !== undefined && named !== null) {
    if (!Number.isInteger(named) || named <= 0) {
      throw new Error("tab_id must be a positive integer.");
    }
    tab = await heldTab(session, named);
  } else {
    tab = await activeTab(session);
  }
  session.actedTabId = tab.id;
  const state = session.tabs.get(tab.id);
  if (state) {
    state.lastUsedAt = Date.now();
  }
  return tab.id;
}

// The window the session works in: where tab listings, tab indices, and new tabs resolve. It
// outlives the session's tab: after that tab closes, a listing or a new tab still belongs in the
// window the session was working in.
async function sessionWindow(session) {
  if (session.currentTabId !== null && session.tabs.has(session.currentTabId)) {
    const current = await chrome.tabs
      .get(session.currentTabId)
      .catch(() => null);
    if (current) {
      session.sessionWindowId = current.windowId;
      return current.windowId;
    }
  }
  if (session.sessionWindowId !== null) {
    const win = await chrome.windows
      .get(session.sessionWindowId)
      .catch(() => null);
    if (win) {
      return win.id;
    }
  }
  // A window id is all any caller wants here: which window to list, to resolve
  // an index against, or to open a tab in. Going through activeTab() would
  // ADOPT the user's active tab as this session's, and refuse when another
  // session is already driving it -- so a second session could neither list
  // tabs nor open one of its own while the first held the tab in front, and
  // the refusal advised opening a new tab, which failed the same way. Reading
  // the window costs no tab and takes nothing from anyone.
  const front = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (front && front.length) {
    return front[0].windowId;
  }
  const lastFocused = await chrome.windows.getLastFocused().catch(() => null);
  if (lastFocused && typeof lastFocused.id === "number") {
    return lastFocused.id;
  }
  throw new Error("No active tab.");
}

// -- Telling the agent's tabs from the user's ---------------------------------

// Whether a new tab opened from one of @p session's pages is that session's doing.
//
// Chrome gives a tab an opener for more than the page opening it: Ctrl+T and the new-tab button
// name the tab the user was looking at, and a middle-clicked link names the page it was in. So the
// opener alone says nothing about WHO opened it, and following it is how the user's own new tab
// used to be pulled into the AI group with the session moved onto it. The session claims a tab
// only while one of its own commands that can open one is running (or just finished), and never
// the browser's new-tab page, which no page's click can open.
function openedBySession(session, tab) {
  if (Date.now() > session.openerUntil) {
    return false;
  }
  const url = String(tab.pendingUrl || tab.url || "");
  return !/^(chrome|chrome-search|edge):\/\/(newtab|new-tab-page)/i.test(url);
}

// Which tab each window showed before the one it shows now. A page the agent drives in the
// background can still open a FOREGROUND tab -- a target=_blank link opens in front -- and that
// would change what the user is looking at; this is what lets the worker put it back.
const activeByWindow = new Map();

// What every window shows as this worker starts: a window nobody has switched tabs in since would
// otherwise have nothing on record to put back.
async function seedActiveTabs() {
  const fronts = await chrome.tabs.query({ active: true }).catch(() => []);
  for (const front of Array.isArray(fronts) ? fronts : []) {
    if (
      typeof front.windowId === "number" &&
      !activeByWindow.has(front.windowId)
    ) {
      activeByWindow.set(front.windowId, { current: front.id, previous: null });
    }
  }
}
void seedActiveTabs();

chrome.tabs.onActivated.addListener((info) => {
  if (!info || typeof info.windowId !== "number") {
    return;
  }
  const seen = activeByWindow.get(info.windowId);
  activeByWindow.set(info.windowId, {
    current: info.tabId,
    previous: seen ? seen.current : null,
  });
});

// How long a page's request to open a window, and a new tab nobody has claimed, wait to be matched
// to each other. Chrome reports them on two unconnected channels and in either order.
const POPUP_MATCH_MS = 5000;

// Tabs created recently that no session claimed, so a Page.windowOpen arriving after the tab can
// still claim it.
const unclaimedTabs = [];

function pruneByAge(list, now) {
  while (list.length > 0 && now - list[0].at > POPUP_MATCH_MS) {
    list.shift();
  }
}

// Whether a page's window.open / link target and a new tab's address are the same request. A tab
// Chrome has only just created for a link often has no address yet (measured: a target=_blank link
// on a real site arrived blank, its navigation still to come), so a blank tab matches any request
// -- the caller has already required that one of the session's own commands is running.
function popupUrlsMatch(requested, tab) {
  const created = String(tab.pendingUrl || tab.url || "");
  const blank = (url) => url === "" || url === "about:blank";
  return requested === created || blank(created);
}

// The browser's own record of which tab a link or script opened a tab from. It names the source
// for every kind of opening -- a no-opener target=_blank link included -- so it is the first way a
// popup is matched to the session whose page opened it; Page.windowOpen above is the fallback for
// a browser without it.
if (
  chrome.webNavigation &&
  chrome.webNavigation.onCreatedNavigationTarget &&
  typeof chrome.webNavigation.onCreatedNavigationTarget.addListener ===
    "function"
) {
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    const opener = holderOf(details && details.sourceTabId);
    if (!opener || !opener.session.port) {
      return;
    }
    void (async () => {
      const tab = await chrome.tabs.get(details.tabId).catch(() => null);
      if (!tab || holderOf(tab.id) || !openedBySession(opener.session, tab)) {
        return;
      }
      const index = unclaimedTabs.findIndex((entry) => entry.tab.id === tab.id);
      if (index >= 0) {
        unclaimedTabs.splice(index, 1);
      }
      claimPopup(opener.session, opener.tab, tab);
    })();
  });
}

// Where the session's own action led: it holds the tab, as one it opened, in the group of the
// agent whose page opened it, and a foreground one (a target=_blank link) becomes its current tab,
// as the page that click navigated to. Chrome put that tab in front of the user, though, and the
// assistant never changes which tab the user is looking at -- so the tab they had is put back.
function claimPopup(session, openerState, tab) {
  if (session.tabs.has(tab.id)) {
    return;
  }
  const state = holdTab(
    session,
    tab,
    "opened",
    openerState ? openerState.agent : undefined,
  );
  state.openedFrom = openerState ? openerState.id : null;
  persistLeases();
  if (tab.active) {
    setCurrentTab(session, tab);
  }
  // Whether Chrome brings it to the front is not settled yet when it is claimed: the browser can
  // report the new tab before activating it (measured on a real profile). So every claimed popup is
  // watched for a moment, not only one already in front.
  void restoreUserForeground(tab, session);
  session.openedDuringCommand.push({
    tab_id: tab.id,
    url: String(tab.pendingUrl || tab.url || ""),
  });
}

// Popups put back behind the user's tab, by popup tab id: {previous, until}. Chrome activates a new
// foreground tab on its own schedule -- before or after the worker claims it -- so the user's tab is
// put back at once if the popup is already in front, and again if the popup takes the front within
// a moment of being claimed.
const foregroundRestores = new Map();
const FOREGROUND_RESTORE_MS = 1500;

async function putUserTabBack(popupId, previous) {
  const popup = await chrome.tabs.get(popupId).catch(() => null);
  const users = await chrome.tabs.get(previous).catch(() => null);
  if (popup && users && popup.active && users.windowId === popup.windowId) {
    await chrome.tabs.update(previous, { active: true }).catch(() => {});
  }
}

async function restoreUserForeground(tab, session) {
  const seen = activeByWindow.get(tab.windowId);
  let previous =
    seen && seen.current === tab.id ? seen.previous : seen && seen.current;
  if (typeof previous !== "number") {
    // Nothing switched tabs in this window since the worker started, so ask the browser which tab
    // is in front -- while the popup is not yet, that is the user's.
    const [front] = await chrome.tabs
      .query({ active: true, windowId: tab.windowId })
      .catch(() => []);
    previous = front && front.id !== tab.id ? front.id : null;
  }
  if (typeof previous !== "number" || previous === tab.id) {
    return; // a new window, or nothing known to go back to
  }
  const now = await chrome.tabs.get(tab.id).catch(() => null);
  if (now && now.active) {
    followPopup(session, now);
    await putUserTabBack(tab.id, previous); // Chrome has already put it in front
    return;
  }
  // Not in front yet: catch it when Chrome does put it there, and only for a moment -- a user who
  // clicks the popup themselves later is choosing to look at it.
  foregroundRestores.set(tab.id, {
    previous,
    session,
    until: Date.now() + FOREGROUND_RESTORE_MS,
  });
}

// A popup opened in front is where the agent's click led, so the session moves to it -- as it
// always has -- even though the user's own tab is put back in front of their eyes.
function followPopup(session, tab) {
  if (session && session.tabs.has(tab.id) && session.currentTabId !== tab.id) {
    setCurrentTab(session, tab);
  }
}

chrome.tabs.onActivated.addListener((info) => {
  const pending = info ? foregroundRestores.get(info.tabId) : null;
  if (!pending) {
    return;
  }
  foregroundRestores.delete(info.tabId);
  if (Date.now() <= pending.until) {
    void chrome.tabs
      .get(info.tabId)
      .then((tab) => followPopup(pending.session, tab))
      .catch(() => {});
    void putUserTabBack(info.tabId, pending.previous);
  }
});

// A page the session is driving asked to open a window (CDP Page.windowOpen): a target=_blank link,
// window.open, a form with a target. Chrome does not always name the opener on the new tab --
// a link that opens without an opener (the default for target=_blank) arrives with none -- so the
// request is remembered and matched to the tab by address, whichever of the two arrives first.
function noteWindowOpen(session, tab, url) {
  const now = Date.now();
  pruneByAge(unclaimedTabs, now);
  const requested = String(url || "");
  const index = unclaimedTabs.findIndex(
    (entry) =>
      !holderOf(entry.tab.id) &&
      popupUrlsMatch(requested, entry.tab) &&
      openedBySession(session, entry.tab),
  );
  if (index >= 0) {
    const [entry] = unclaimedTabs.splice(index, 1);
    claimPopup(session, tab, entry.tab);
    return;
  }
  session.windowOpens = (session.windowOpens || []).filter(
    (entry) => now - entry.at <= POPUP_MATCH_MS,
  );
  session.windowOpens.push({ url: requested, at: now, opener: tab });
}

chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id !== "number") {
    return;
  }
  const now = Date.now();
  tabCreatedAt.set(tab.id, now);
  const opener = holderOf(tab.openerTabId);
  if (opener && opener.session.port && openedBySession(opener.session, tab)) {
    claimPopup(opener.session, opener.tab, tab);
    return;
  }
  // No opener Chrome would name: match it to a window a session's page asked to open.
  for (const session of sessions) {
    if (!session.port || !openedBySession(session, tab)) {
      continue;
    }
    const opens = (session.windowOpens || []).filter(
      (entry) => now - entry.at <= POPUP_MATCH_MS,
    );
    const index = opens.findIndex((entry) => popupUrlsMatch(entry.url, tab));
    if (index >= 0) {
      const [entry] = opens.splice(index, 1);
      session.windowOpens = opens;
      claimPopup(session, entry.opener, tab);
      return;
    }
  }
  // The user's, as far as anything here knows. Chrome may already have put it in the AI group of
  // the tab it was opened from; and a page's open request may yet arrive to claim it.
  pruneByAge(unclaimedTabs, now);
  unclaimedTabs.push({ tab, at: now });
  void expelFromControlGroup(tab.id, tab.groupId);
});

// Take a tab nobody holds out of a session's group it was put into without the user asking.
async function expelFromControlGroup(tabId, groupId) {
  if (holderOf(tabId) || !sessionOwningGroup(groupId)) {
    return;
  }
  expectGroupChange([tabId]);
  await chrome.tabs.ungroup([tabId]).catch(() => {});
}

// A tab changing group is how the user hands a tab to the assistant or takes one back:
//   - a tab the session holds dragged OUT of its group is the user's again: the session lets go of
//     it (never closing it) and stops drawing on it;
//   - a tab nobody holds dragged INTO a session's group is the user handing it over: the session
//     holds it as a borrowed tab, handed back -- never closed -- when the session is done;
//   - a tab Chrome put into the group on its own, moments after it was created from a grouped
//     tab, is neither, and is taken back out.
// Our own grouping calls, and a tab leaving its group because it was dragged to another window,
// are none of these.
async function onTabGroupChanged(tabId, groupId) {
  if (groupChangeExpected(tabId)) {
    return;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    return;
  }
  const held = holderOf(tabId);
  if (held) {
    const session = held.session;
    const ours = session.groups.get(groupKey(tab.windowId, held.tab.agent));
    if (groupId === ours || movingWindows(tabId) || ours === undefined) {
      queueGroupSync(session);
      return;
    }
    const moved = groupOwner(groupId);
    if (moved && moved.session === session) {
      // Dragged into another of this session's agent groups: it is that agent's tab now.
      holdTab(session, tab, held.tab.origin, moved.agent);
      return;
    }
    // Out of the AI group -- into no group, or into one of the user's: the user has taken it back.
    // The session lets go of it without closing it. A command that names no tab then moves to
    // another tab the session holds, or says it has none; it never follows this one back.
    await dropTab(session, tabId);
    return;
  }
  const owner = groupOwner(groupId);
  if (!owner) {
    return;
  }
  if (createdRecently(tabId) || !owner.session.port) {
    await expelFromControlGroup(tabId, groupId);
    return;
  }
  holdTab(owner.session, tab, "adopted", owner.agent);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo && typeof changeInfo.groupId === "number") {
    void onTabGroupChanged(tabId, changeInfo.groupId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabCreatedAt.delete(tabId);
  tabsMovingWindows.delete(tabId);
  expectedGroupChanges.delete(tabId);
  const held = holderOf(tabId);
  if (held) {
    void dropTab(held.session, tabId, { closed: true });
  }
});

// Chrome swaps a tab's contents for a prerendered or restored one under a NEW id. The tab the user
// sees is the same one, so the session keeps holding it -- under its new id, and detached, since the
// debugger was attached to the page that was swapped out.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const held = holderOf(removedTabId);
  if (!held) {
    return;
  }
  const { session, tab: state } = held;
  session.tabs.delete(removedTabId);
  session.goneTabIds.add(removedTabId);
  state.attached = false;
  releaseTabState(session, state);
  state.id = addedTabId;
  session.tabs.set(addedTabId, state);
  if (session.currentTabId === removedTabId) {
    session.currentTabId = addedTabId;
  }
  attachInBackground(session, addedTabId);
  queueGroupSync(session);
});

chrome.tabs.onDetached.addListener((tabId) => {
  tabsMovingWindows.set(tabId, Date.now());
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  tabsMovingWindows.set(tabId, Date.now());
  const held = holderOf(tabId);
  if (!held) {
    return;
  }
  if (held.session.currentTabId === tabId && attachInfo) {
    held.session.sessionWindowId = attachInfo.newWindowId;
  }
  // Groups are per window: the tab joins the session's group in the window it landed in.
  queueGroupSync(held.session);
});

// -- When a session lets go -------------------------------------------------------

// Whether the user is looking at this tab right now: the active tab of the focused Chrome window.
// That tab is never closed out from under them, even one the session opened.
async function userIsLookingAt(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.active) {
    return false;
  }
  const win = await chrome.windows.getLastFocused().catch(() => null);
  return Boolean(win && win.focused && win.id === tab.windowId);
}

// Let go of @p states: close the tabs the session opened (when @p closeOpened), hand back the
// rest. Handing back means the tab leaves the AI group and loses the frame and badge, and is left
// open exactly where it is. Two tabs are never closed whatever the session opened: the one the
// user is looking at, and the browser's last tab -- Chrome would quit with it.
async function releaseTabs(session, states, { closeOpened }) {
  const toClose = [];
  if (closeOpened) {
    for (const state of states) {
      if (state.origin === "opened" && !(await userIsLookingAt(state.id))) {
        toClose.push(state.id);
      }
    }
    const everyTab = await chrome.tabs.query({}).catch(() => []);
    if (toClose.length > 0 && toClose.length >= everyTab.length) {
      toClose.pop();
    }
  }
  const closing = new Set(toClose);
  const result = { closed: [], handed_back: [], kept_open: [] };
  const leaving = [];
  for (const state of states) {
    session.tabs.delete(state.id);
    session.goneTabIds.add(state.id);
    await detachTab(session, state, { closed: closing.has(state.id) });
    if (closing.has(state.id)) {
      result.closed.push(state.id);
      continue;
    }
    leaving.push(state.id);
    (state.origin === "opened" ? result.kept_open : result.handed_back).push(
      state.id,
    );
  }
  await ungroupFromSession(session, leaving);
  if (toClose.length > 0) {
    const stuck = await closeTabs(toClose);
    if (stuck.length > 0) {
      // Still open after every attempt: handed back like a borrowed tab -- out of the AI group, with
      // nothing marking it -- and reported as open, never as closed.
      await ungroupFromSession(session, stuck);
      result.closed = result.closed.filter((id) => !stuck.includes(id));
      result.kept_open.push(...stuck);
      result.not_closed = stuck;
    }
  }
  if (session.tabs.size === 0) {
    session.groups.clear();
  }
  // An agent that let go of its last tab let go of its clipboard with it.
  forgetReleasedClipboards(session);
  session.lastTabListing = null;
  persistLeases();
  return result;
}

// Let go of everything: the session's work is over (its server went away, the agent released all
// of it, or the user paused the bridge). Afterwards nothing in the browser is marked as its own.
async function standDown(session, { closeOpened }) {
  const result = await releaseTabs(session, [...session.tabs.values()], {
    closeOpened,
  });
  session.currentTabId = null;
  session.commandGeneration++;
  clearUploads(session);
  discardRecording(session);
  session.clipboards.clear();
  session.clipboardDuringCommand = null;
  return result;
}

// What an agent lets go of when it releases @p state: that tab, every tab opened from it (and from
// those), and -- when the agent named itself -- every other tab under that name. Releasing only the
// one tab left the agent's popups and its other tabs open behind it, held all day by a server that
// was still running; an agent that says it is done is done with all of them. An agent with no name
// is not told apart from other unnamed agents on the same server, so for it the tab and what it
// opened is the whole of what is certainly its own.
function releaseScope(session, state) {
  const ids = new Set([state.id]);
  if (state.agent) {
    for (const other of session.tabs.values()) {
      if (other.agent === state.agent) {
        ids.add(other.id);
      }
    }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const other of session.tabs.values()) {
      if (
        !ids.has(other.id) &&
        other.openedFrom !== null &&
        ids.has(other.openedFrom)
      ) {
        ids.add(other.id);
        grew = true;
      }
    }
  }
  return [...ids].map((id) => session.tabs.get(id));
}

// Close @p tabIds, and report the ones still open afterwards. Chrome refuses a removal while the
// user is dragging a tab ("Tabs cannot be edited right now"), and that refusal used to be logged
// and forgotten: the reply said "closed", and the tab stayed open in an AI group nobody held.
// Each attempt is checked against what is actually still open, and retried a few times.
const CLOSE_RETRY_DELAYS_MS = [250, 750, 1500];

async function closeTabs(tabIds) {
  let remaining = tabIds;
  for (let attempt = 0; ; attempt += 1) {
    await chrome.tabs.remove(remaining).catch((e) => {
      console.warn("[ChromeControlMCP] could not close a released tab:", e);
    });
    const open = [];
    for (const id of remaining) {
      if (await chrome.tabs.get(id).catch(() => null)) {
        open.push(id);
      }
    }
    remaining = open;
    if (remaining.length === 0 || attempt >= CLOSE_RETRY_DELAYS_MS.length) {
      return remaining;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, CLOSE_RETRY_DELAYS_MS[attempt]);
    });
  }
}

// browser_release: the agent saying it is done -- with its tabs (see releaseScope), or with
// everything.
async function handleRelease(session, args) {
  const closeOpened = !(args && args.keep_open === true);
  const named = args ? args.tab_id : undefined;
  if (named !== undefined && named !== null) {
    if (!Number.isInteger(named) || named <= 0) {
      throw new Error("tab_id must be a positive integer.");
    }
    const state = session.tabs.get(named);
    if (!state) {
      throw new Error(
        "Tab " +
          named +
          " is not one of this session's tabs; nothing was released.",
      );
    }
    const result = await releaseTabs(session, releaseScope(session, state), {
      closeOpened,
    });
    return Object.assign({ ok: true }, result, {
      tabs_still_held: session.tabs.size,
    });
  }
  const result = await standDown(session, { closeOpened });
  return Object.assign({ ok: true }, result, { tabs_still_held: 0 });
}

// -- Sessions whose port went away ----------------------------------------------

// Sessions whose port went away, by server id, until an offer says whether that server is still
// running: resumed if it is, released if it is not. Their tabs stay held (no other session may
// take them) but are not attached -- nothing could answer a dialog on them in the meantime.
const pendingLeases = new Map();

// How long a parked session waits for an answer before its tabs are released anyway. Only reached
// when no relay can be started at all to ask.
const PARKED_MAX_MS = 10 * 60000;

function parkSession(session) {
  for (const state of session.tabs.values()) {
    void detachTab(session, state);
  }
  if (!session.serverId || session.tabs.size === 0) {
    return;
  }
  session.parkedAt = Date.now();
  pendingLeases.set(session.serverId, session);
  persistLeases();
}

// A port that reached a server some parked session belonged to takes that session's tabs back.
function resumeParkedSession(session) {
  const parked = pendingLeases.get(session.serverId);
  if (!parked || parked === session) {
    return;
  }
  pendingLeases.delete(session.serverId);
  sessions.delete(parked);
  if (parked.reconnectTimer) {
    clearTimeout(parked.reconnectTimer);
    parked.reconnectTimer = null;
  }
  session.tabs = parked.tabs;
  session.groups = parked.groups;
  session.currentTabId = parked.currentTabId;
  session.sessionWindowId = parked.sessionWindowId;
  session.label = parked.label;
  session.colors = parked.colors;
  for (const id of parked.goneTabIds) {
    session.goneTabIds.add(id);
  }
  for (const id of session.tabs.keys()) {
    attachInBackground(session, id);
  }
  queueGroupSync(session);
  persistLeases();
}

// The live servers some relay just listed. A parked session whose server is not among them has
// ended: its tabs are released the way the agent's own release would -- the ones it opened are
// closed, the ones it borrowed are handed back.
let lastOfferedServers = new Set();
let offersSeen = false;
let legacyGroupsSwept = false;

// Settles once the holdings an earlier worker saved have been read back (loadLeases). Until then
// a group this extension made may look like nobody's, and must not be ungrouped as an orphan.
let leasesLoaded = Promise.resolve();

function noteOfferedServers(live) {
  lastOfferedServers = new Set(live);
  offersSeen = true;
  for (const [serverId, parked] of [...pendingLeases]) {
    if (!lastOfferedServers.has(serverId)) {
      pendingLeases.delete(serverId);
      sessions.delete(parked);
      void standDown(parked, { closeOpened: true }).then(() => {
        parked.ended = true;
      });
    }
  }
  if (!legacyGroupsSwept) {
    legacyGroupsSwept = true;
    void releaseLegacyControlGroups();
  }
}

// Groups this extension left behind with nothing tracking them: from a browser restart (Chrome
// restores groups under new ids), a crashed worker, or a version that did not record them. The
// tabs in them are the user's now; they are ungrouped, never closed.
async function releaseLegacyControlGroups() {
  if (!chrome.tabGroups) {
    return;
  }
  await leasesLoaded;
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!isControlGroupTitle(group.title) || sessionOwningGroup(group.id)) {
      continue;
    }
    const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
    const ids = tabs
      .map((tab) => tab.id)
      .filter((id) => typeof id === "number" && !holderOf(id));
    if (ids.length > 0) {
      expectGroupChange(ids);
      await chrome.tabs.ungroup(ids).catch(() => {});
    }
  }
}

// -- Going quiet ------------------------------------------------------------------

// How long a session may go without a command before its tabs are stood down. The tabs stay open,
// held and grouped (the group turns grey and says "idle"); the debugger detaches, which takes
// Chrome's "started debugging this browser" bar away with it, and the frame and badge come off.
// The session's next command puts all of it back.
const IDLE_RELEASE_MS = 10 * 60000;

function sweepIdleSessions() {
  const now = Date.now();
  for (const session of sessions) {
    if (
      !session.port ||
      session.idle ||
      session.tabs.size === 0 ||
      session.recording ||
      now - session.lastCommandAt < IDLE_RELEASE_MS
    ) {
      continue;
    }
    void standDownIdle(session);
  }
  for (const [serverId, parked] of [...pendingLeases]) {
    if (now - parked.parkedAt > PARKED_MAX_MS) {
      pendingLeases.delete(serverId);
      sessions.delete(parked);
      void standDown(parked, { closeOpened: true });
    }
  }
}

async function standDownIdle(session) {
  session.idle = true;
  for (const state of session.tabs.values()) {
    await detachTab(session, state);
  }
  queueGroupSync(session);
}

function resumeSession(session) {
  session.idle = false;
  for (const id of session.tabs.keys()) {
    attachInBackground(session, id);
  }
  queueGroupSync(session);
}

// -- Remembering holdings across a worker restart ----------------------------------

// Chrome retires and restarts this worker, and an extension reload replaces it. What the sessions
// hold is mirrored into session storage (cleared when the browser exits) so the next worker can
// tell a tab the assistant opened from one the user did -- and close or hand back each correctly --
// rather than leaving AI groups on the tab strip with nobody tracking them.
const LEASES_KEY = "chrome_control_mcp.leases";
let persistTimer = null;

function leaseRecord(session) {
  return {
    tabs: [...session.tabs.values()].map((state) => [
      state.id,
      state.origin,
      state.agent,
      state.openedFrom,
    ]),
    groups: [...session.groups],
    colors: [...session.colors],
    current: session.currentTabId,
    window: session.sessionWindowId,
    label: session.label,
  };
}

// A [string, value] pair list read back from storage, keeping only well-formed pairs.
function storedPairs(raw, valueOk) {
  return Array.isArray(raw)
    ? raw.filter(
        (pair) =>
          Array.isArray(pair) &&
          typeof pair[0] === "string" &&
          valueOk(pair[1]),
      )
    : [];
}

function persistLeases() {
  if (persistTimer !== null) {
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const record = {};
    for (const session of [...sessions, ...pendingLeases.values()]) {
      if (session.serverId && session.tabs.size > 0 && !session.ended) {
        record[session.serverId] = leaseRecord(session);
      }
    }
    try {
      void Promise.resolve(
        chrome.storage.session.set({ [LEASES_KEY]: record }),
      ).catch(() => {});
    } catch (_e) {
      // Not remembered across a restart; this worker still knows.
    }
  }, 250);
}

// Read back what an earlier worker held. Each server's holdings wait, parked, for the next offer to
// say whether that server is still running.
async function loadLeases() {
  let record;
  try {
    const stored = await chrome.storage.session.get(LEASES_KEY);
    record = stored ? stored[LEASES_KEY] : null;
  } catch (_e) {
    return;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return;
  }
  for (const [serverId, entry] of Object.entries(record)) {
    if (
      pendingLeases.has(serverId) ||
      heldServers().includes(serverId) ||
      !entry ||
      !Array.isArray(entry.tabs)
    ) {
      continue;
    }
    const session = makeSession();
    session.serverId = serverId;
    for (const pair of entry.tabs) {
      const [id, origin, agent, openedFrom] = Array.isArray(pair) ? pair : [];
      if (
        Number.isInteger(id) &&
        (origin === "opened" || origin === "adopted") &&
        (await chrome.tabs.get(id).catch(() => null))
      ) {
        const state = makeTabState(id, origin);
        state.agent = typeof agent === "string" ? agent : "";
        state.openedFrom = Number.isInteger(openedFrom) ? openedFrom : null;
        session.tabs.set(id, state);
      }
    }
    for (const [key, groupId] of storedPairs(entry.groups, Number.isInteger)) {
      session.groups.set(key, groupId);
    }
    for (const [agent, color] of storedPairs(entry.colors, (value) =>
      SESSION_COLORS.includes(value),
    )) {
      session.colors.set(agent, color);
    }
    session.currentTabId = Number.isInteger(entry.current)
      ? entry.current
      : null;
    session.sessionWindowId = Number.isInteger(entry.window)
      ? entry.window
      : null;
    session.label = typeof entry.label === "string" ? entry.label : "";
    session.parkedAt = Date.now();
    if (session.tabs.size > 0) {
      pendingLeases.set(serverId, session);
    }
  }
  // An offer that arrived while these were being read could not settle them; settle them now,
  // so a server that is gone has its tabs cleaned up at once rather than at the next offer.
  if (offersSeen) {
    noteOfferedServers([...lastOfferedServers]);
  }
}

// -- File pickers -----------------------------------------------------------------
//
// Chrome refuses a native file dialog to a tab that is not the active tab of its window (measured:
// the input's chooser is cancelled and the page gets a `cancel` event), and shows one over whatever
// the user is doing when it is -- and an agent could not operate it either way. So while one of the
// session's commands that can make a page ask for a file is running (and for a moment after), the
// page's request is caught instead of shown: an <input type=file> through CDP's own file-chooser
// interception, and the File System Access picker (showOpenFilePicker) through a stand-in the page
// is given while the debugger is attached. browser_upload with no ref then answers it with the
// agent's files. Outside that window nothing is caught: the user's own clicks on an upload button,
// even in a tab the assistant holds, open the ordinary dialog.
const PICKER_STATE_KEY = "__chrome_control_mcp_picker__";
const PICKER_BINDING = "__chrome_control_mcp_picker_opened__";
// How long a page's showOpenFilePicker call waits for the agent before it is answered the way a
// dismissed dialog would be (AbortError). A dialog left open forever would leave the page's button
// stuck.
const PICKER_ABANDON_MS = 5 * 60000;

// The stand-in for showOpenFilePicker. Runs in the page; closes over nothing. While disarmed it is
// the browser's own picker, untouched.
function filePickerShimScript() {
  return (
    "(function(){var K=" +
    JSON.stringify(PICKER_STATE_KEY) +
    ",B=" +
    JSON.stringify(PICKER_BINDING) +
    ";if(window[K]||typeof window.showOpenFilePicker!=='function'){return;}" +
    "var nativePicker=window.showOpenFilePicker;var state={armed:false,pending:null};" +
    "Object.defineProperty(window,K,{value:state});" +
    "window.showOpenFilePicker=function showOpenFilePicker(options){" +
    "if(!state.armed){return nativePicker.apply(this,arguments);}" +
    "var multiple=Boolean(options&&options.multiple);" +
    "return new Promise(function(resolve,reject){" +
    "if(state.pending){state.pending.reject(new DOMException('The user aborted a request.','AbortError'));}" +
    "var entry={resolve:resolve,reject:reject,multiple:multiple};state.pending=entry;" +
    "setTimeout(function(){if(state.pending===entry){state.pending=null;" +
    "reject(new DOMException('The user aborted a request.','AbortError'));}}," +
    PICKER_ABANDON_MS +
    ");try{window[B](JSON.stringify({multiple:multiple}));}catch(e){}});};})();"
  );
}

function filePickerArmScript(armed) {
  return (
    "(function(){var s=window[" +
    JSON.stringify(PICKER_STATE_KEY) +
    "];if(s){s.armed=" +
    (armed ? "true" : "false") +
    ";}})()"
  );
}

async function armFilePickers(session, tab) {
  try {
    await ensureAttached(session, tab.id);
  } catch (_e) {
    return; // a page the debugger cannot attach to has no picker this can catch
  }
  if (tab.disarmTimer) {
    clearTimeout(tab.disarmTimer);
    tab.disarmTimer = null;
  }
  if (tab.pickersArmed) {
    return;
  }
  tab.pickersArmed = true;
  await sendCdp(tab.id, "Page.setInterceptFileChooserDialog", {
    enabled: true,
  }).catch((e) => {
    console.warn(
      "[ChromeControlMCP] file chooser interception unavailable:",
      e,
    );
  });
  await sendCdp(tab.id, "Runtime.evaluate", {
    expression: filePickerArmScript(true),
  }).catch(() => {});
}

function scheduleFilePickerDisarm(session) {
  for (const tab of session.tabs.values()) {
    if (!tab.pickersArmed || tab.disarmTimer) {
      continue;
    }
    tab.disarmTimer = setTimeout(() => {
      tab.disarmTimer = null;
      void disarmFilePickers(tab);
    }, OPENER_GRACE_MS);
  }
}

async function disarmFilePickers(tab) {
  if (!tab.pickersArmed) {
    return;
  }
  tab.pickersArmed = false;
  if (!tab.attached) {
    return; // detaching ended the interception with the attachment
  }
  await sendCdp(tab.id, "Page.setInterceptFileChooserDialog", {
    enabled: false,
  }).catch(() => {});
  await sendCdp(tab.id, "Runtime.evaluate", {
    expression: filePickerArmScript(false),
  }).catch(() => {});
}

// A page asked for a file and was caught. Kept on the tab for browser_upload to answer, and
// reported on the reply of the command that caused it.
function noteFileChooser(session, tab, chooser) {
  tab.fileChooser = Object.assign({ at: Date.now() }, chooser);
  session.chooserDuringCommand = {
    tab_id: tab.id,
    kind: chooser.kind,
    multiple: chooser.multiple,
    folder: chooser.directory,
    note: chooser.directory
      ? "The page asked for a folder. Folder uploads are not supported yet."
      : "The page asked for a file and no dialog was shown. Call browser_upload with paths " +
        "(no ref needed) to give it the file" +
        (chooser.multiple ? "s." : "."),
  };
}

// -- Agent clipboards ---------------------------------------------------------------
//
// The operating system has one clipboard, and every agent and the user shared it: an agent's
// Ctrl+V pasted whatever was last copied anywhere on the machine -- the user's own copy, or another
// agent's -- and its copy replaced the user's. A page's own copy button was worse: agent tabs run
// under focus emulation, so a background page believes it is focused, and Chrome lets a focused
// page write the system clipboard. Chrome has no clipboard per tab or per extension, so each agent
// gets one here instead, and nothing an agent does reaches the system clipboard at all.
//
// One per agent, keyed like its tab group: this session plus the agent name its tab was opened
// with ("" for the session's shared group). Held in this worker's memory only -- never in
// chrome.storage, never on disk -- bounded, and cleared when the agent lets go of its last tab or
// the session is stood down (its server exited, or the user paused the bridge).
//
// Three ways in, one store:
//   - the agent's own copy, cut and paste chords, which handlePressKey answers here instead of
//     sending to Chrome as keys (which is what would read or write the system clipboard);
//   - browser_clipboard, which writes, reads, clears, copies, cuts and pastes;
//   - the page's clipboard API in a held tab, through a stand-in that asks this worker, honoured
//     only while one of the agent's own input commands on that tab runs and for 2 s after.
const CLIPBOARD_STATE_KEY = "__chrome_control_mcp_clipboard__";
const CLIPBOARD_BINDING = "__chrome_control_mcp_clipboard_call__";
// What one clipboard may hold. Text and markup are each bounded on their own; files share the
// upload ceiling, since they cross the bridge the same way.
const MAX_CLIPBOARD_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_CLIPBOARD_HTML_CHARS = 2 * 1024 * 1024;
const MAX_CLIPBOARD_FILES = 10;
const MAX_CLIPBOARD_TYPE_CHARS = 128;
// How long a page's clipboard call waits for this worker before it is refused, so a page whose
// tab was let go of mid-call is not left with a promise that never settles.
const CLIPBOARD_PAGE_CALL_MS = 10000;
// The commands during which (and for OPENER_GRACE_MS after) a page in that tab may use the
// agent's clipboard: everything that delivers the agent's input, as a user's click or key press
// would give the page activation, and the agent's own clipboard commands -- a page's paste handler
// may itself read the clipboard.
const CLIPBOARD_COMMANDS = new Set([...OPENER_COMMANDS, "clipboard"]);

function clipboardOf(session, agent) {
  return session.clipboards.get(agent || "") || null;
}

// Store @p clip as @p agent's clipboard, or refuse it whole. A clipboard cut down to fit would be
// pasted as though it were what was copied.
function setClipboard(session, agent, clip) {
  const text = typeof clip.text === "string" ? clip.text : "";
  const html = typeof clip.html === "string" ? clip.html : "";
  const files = Array.isArray(clip.files) ? clip.files : [];
  if (text.length > MAX_CLIPBOARD_TEXT_CHARS) {
    throw new Error(
      "The text is larger than a clipboard holds (" +
        MAX_CLIPBOARD_TEXT_CHARS / (1024 * 1024) +
        " MiB).",
    );
  }
  if (html.length > MAX_CLIPBOARD_HTML_CHARS) {
    throw new Error(
      "The HTML is larger than a clipboard holds (" +
        MAX_CLIPBOARD_HTML_CHARS / (1024 * 1024) +
        " MiB).",
    );
  }
  if (files.length > MAX_CLIPBOARD_FILES) {
    throw new Error(
      "A clipboard holds at most " + MAX_CLIPBOARD_FILES + " files.",
    );
  }
  let bytes = 0;
  for (const file of files) {
    bytes += file.data.length;
  }
  if (bytes > MAX_UPLOAD_BASE64) {
    throw new Error("The files are larger than a clipboard holds.");
  }
  if (!text && !html && files.length === 0) {
    throw new Error("There is nothing to put on the clipboard.");
  }
  session.clipboards.set(agent || "", {
    text,
    html,
    files,
    source: clip.source,
    at: Date.now(),
  });
}

// What a reply says about a clipboard: never its content, which only `read` returns.
function clipboardSummary(clip) {
  if (!clip) {
    return { empty: true };
  }
  return {
    empty: false,
    text_length: clip.text.length,
    html_length: clip.html.length,
    files: clip.files.map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
    })),
    source: clip.source,
  };
}

// An agent that holds no tab any more has let go of its clipboard too. Called after tabs are
// released; an agent still holding a tab keeps its clipboard, and so does every other agent.
function forgetReleasedClipboards(session) {
  const holding = new Set();
  for (const state of session.tabs.values()) {
    holding.add(state.agent || "");
  }
  for (const agent of [...session.clipboards.keys()]) {
    if (!holding.has(agent)) {
      session.clipboards.delete(agent);
    }
  }
}

// The clipboard operation a chord performs, or null for any other chord. Copy, cut and paste with
// Control or Command on every platform -- an agent rarely knows which one the browser runs on, and
// either is what it means -- plus Insert and Delete's own clipboard chords, and the two ways of
// asking for a paste without formatting.
function clipboardChord(def, modifiers) {
  const { shift, control, alt, meta } = MODIFIER_BITS;
  const primary = modifiers === control || modifiers === meta;
  const primaryShift =
    modifiers === (control | shift) || modifiers === (meta | shift);
  switch (def.code) {
    case "KeyC":
      return primary ? "copy" : null;
    case "KeyX":
      return primary ? "cut" : null;
    case "KeyV":
      if (primary) {
        return "paste";
      }
      return primaryShift || modifiers === (meta | shift | alt)
        ? "pastePlain"
        : null;
    case "Insert":
      if (modifiers === control) {
        return "copy";
      }
      return modifiers === shift ? "paste" : null;
    case "Delete":
      return modifiers === shift ? "cut" : null;
    default:
      return null;
  }
}

// Runs in the page. Where a copy or paste lands: the focused element, followed through open shadow
// roots and into the frames this document can reach. Focus inside a frame from another site is
// reported rather than guessed past -- no script here can reach into it.
function clipboardTargetFn() {
  let doc = document;
  let el = doc.activeElement;
  for (let guard = 0; guard < 32 && el; guard += 1) {
    if (el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
      continue;
    }
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let inner;
      try {
        inner = el.contentDocument;
      } catch (_e) {
        inner = null;
      }
      if (!inner) {
        return { doc, el, crossFrame: true };
      }
      doc = inner;
      el = inner.activeElement;
      continue;
    }
    break;
  }
  return { doc, el: el || doc.body || doc.documentElement, crossFrame: false };
}

// Runs in the page, and inside the page's stand-in for execCommand. What a real copy (or cut) of
// @p el in @p doc gives the clipboard. The page is asked first, exactly as a browser asks it: a copy
// event carrying an empty DataTransfer, fired where the selection is. What the page put there is
// believed when it cancelled the event -- that is how a page says "copy this instead". Otherwise the
// selection is taken: the selected part of a text field, or the document's selection as text and
// markup. A password field gives nothing, as it does to a real copy.
function clipboardCaptureFn(doc, el, cut) {
  const win = doc.defaultView;
  const isField = (node) =>
    Boolean(node) &&
    (node.tagName === "TEXTAREA" ||
      (node.tagName === "INPUT" &&
        /^(text|search|url|tel|email|password|number)?$/i.test(
          node.type || "",
        )));
  const selection = win.getSelection();
  const anchor =
    selection && selection.rangeCount > 0 ? selection.anchorNode : null;
  const anchorEl = anchor
    ? anchor.nodeType === 1
      ? anchor
      : anchor.parentElement
    : null;
  // The field whose text is selected. Usually the focused one; but the copy button every site
  // builds -- a scratch textarea, select(), execCommand('copy') -- selects a field it never focuses,
  // and the document selection then sits at that field, by itself or as a child of its parent.
  let field = isField(el) ? el : null;
  if (!field && isField(anchor)) {
    field = anchor;
  } else if (!field && anchorEl === anchor && anchor) {
    const child = anchor.childNodes[selection.anchorOffset];
    field = isField(child) ? child : null;
  }
  const target = field || anchorEl || el || doc.body;
  const transfer = new win.DataTransfer();
  const event = new win.ClipboardEvent(cut ? "cut" : "copy", {
    clipboardData: transfer,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  if (event.defaultPrevented) {
    return {
      text: transfer.getData("text/plain"),
      html: transfer.getData("text/html"),
      from: "page",
      editable: false,
    };
  }
  if (field) {
    if (String(field.type).toLowerCase() === "password") {
      return { text: "", html: "", from: "selection", password: true };
    }
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const picked =
      typeof start === "number" && typeof end === "number" && end > start
        ? field.value.slice(start, end)
        : "";
    return {
      text: picked,
      html: "",
      from: "selection",
      editable: !field.readOnly && !field.disabled,
    };
  }
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return { text: "", html: "", from: "selection", editable: false };
  }
  const box = doc.createElement("div");
  for (let i = 0; i < selection.rangeCount; i += 1) {
    box.appendChild(selection.getRangeAt(i).cloneContents());
  }
  return {
    text: selection.toString(),
    html: box.innerHTML,
    from: "selection",
    editable: Boolean(anchorEl && anchorEl.isContentEditable),
  };
}

// Runs in the page: the agent's copy or cut, from wherever focus is.
function agentCopyFn(findTarget, capture, cut, maxText, maxHtml) {
  const spot = findTarget();
  if (spot.crossFrame) {
    return { crossFrame: true };
  }
  const got = capture(spot.doc, spot.el, cut);
  if (got.text.length > maxText || got.html.length > maxHtml) {
    return { tooLarge: true };
  }
  return got;
}

// Runs in the page. A real paste of @p clip into whatever has focus: a paste event carrying it --
// where nearly every editor and every "paste an image anywhere" page reads a paste -- and then,
// for an editable region whose page did not take the paste event, a beforeinput of type
// insertFromPaste with the same data, which is where some editors read it instead. Text the page
// took from neither is inserted by the caller with a trusted Input.insertText. Markup is only ever
// offered to the page's own handlers, which sanitize it as they would a real paste; nothing here
// inserts it.
function agentPasteFn(findTarget, clip) {
  const spot = findTarget();
  if (spot.crossFrame) {
    return { handled: "none", crossFrame: true, editable: true, field: true };
  }
  const { doc, el } = spot;
  const win = doc.defaultView;
  const transfer = new win.DataTransfer();
  if (clip.text) {
    transfer.setData("text/plain", clip.text);
  }
  if (clip.html) {
    transfer.setData("text/html", clip.html);
  }
  for (const file of clip.files) {
    const binary = win.atob(file.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    transfer.items.add(new win.File([bytes], file.name, { type: file.type }));
  }
  const target = {
    tag: String(el.tagName || "")
      .toLowerCase()
      .slice(0, 40),
    id: String(el.id || "").slice(0, 120),
  };
  const paste = new win.ClipboardEvent("paste", {
    clipboardData: transfer,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  el.dispatchEvent(paste);
  if (paste.defaultPrevented) {
    return { handled: "page", via: "paste", target };
  }
  const field =
    el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" &&
      /^(text|search|url|tel|email|password|number)?$/i.test(el.type || ""));
  if (field) {
    return {
      handled: "none",
      editable: !el.readOnly && !el.disabled,
      field: true,
      target,
    };
  }
  if (!el.isContentEditable) {
    return { handled: "none", editable: false, target };
  }
  const before = new win.InputEvent("beforeinput", {
    inputType: "insertFromPaste",
    dataTransfer: transfer,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  el.dispatchEvent(before);
  if (before.defaultPrevented) {
    return { handled: "page", via: "beforeinput", target };
  }
  return { handled: "none", editable: true, field: false, target };
}

// Runs in the page, in every document of a held tab and in each frame of it the page can reach.
// The page's clipboard API, answered by this worker through the binding -- so a page's copy or
// paste button in an agent's tab uses that agent's clipboard and never the system's. Installed on
// the prototypes, so Clipboard.prototype.writeText.call(...) cannot step around it. Its restore()
// puts the browser's own functions back when the tab is handed back, and arm() reinstates these
// when it is held again.
function clipboardStandInFn(KEY, BINDING, capture, CALL_MS) {
  const build = (win) => {
    const clipProto = win.Clipboard && win.Clipboard.prototype;
    const docProto = win.Document && win.Document.prototype;
    const originals = {};
    const owners = {};
    for (const name of ["writeText", "write", "readText", "read"]) {
      if (clipProto && typeof clipProto[name] === "function") {
        originals[name] = clipProto[name];
        owners[name] = clipProto;
      }
    }
    if (docProto && typeof docProto.execCommand === "function") {
      originals.execCommand = docProto.execCommand;
      owners.execCommand = docProto;
    }
    const pending = new Map();
    let seq = 0;
    const refusal = () =>
      new win.DOMException(
        "Clipboard access is not allowed here.",
        "NotAllowedError",
      );
    const ask = (payload) =>
      new win.Promise((resolve, reject) => {
        seq += 1;
        const id = seq;
        const timer = win.setTimeout(() => {
          if (pending.delete(id)) {
            reject(refusal());
          }
        }, CALL_MS);
        pending.set(id, { resolve, reject, timer });
        try {
          win[BINDING](JSON.stringify(Object.assign({ id }, payload)));
        } catch (_e) {
          pending.delete(id);
          win.clearTimeout(timer);
          reject(refusal());
        }
      });
    const toBase64 = (blob) =>
      new win.Promise((resolve, reject) => {
        const reader = new win.FileReader();
        reader.onload = () =>
          resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    const fromBase64 = (data) => {
      const binary = win.atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    };
    const replacements = {
      writeText(text) {
        return ask({ op: "write", text: String(text) }).then(() => undefined);
      },
      write(items) {
        const payload = { op: "write", text: "", html: "", files: [] };
        const reads = [];
        for (const item of Array.from(items || [])) {
          for (const type of Array.from(item.types || [])) {
            reads.push(
              item.getType(type).then((blob) => {
                if (type === "text/plain") {
                  return blob.text().then((value) => {
                    payload.text = value;
                  });
                }
                if (type === "text/html") {
                  return blob.text().then((value) => {
                    payload.html = value;
                  });
                }
                return toBase64(blob).then((data) => {
                  payload.files.push({
                    type,
                    name: "clipboard." + (type.split("/")[1] || "bin"),
                    data,
                  });
                });
              }),
            );
          }
        }
        return win.Promise.all(reads)
          .then(() => ask(payload))
          .then(() => undefined);
      },
      readText() {
        return ask({ op: "read" }).then((clip) => (clip && clip.text) || "");
      },
      read() {
        return ask({ op: "read" }).then((clip) => {
          const items = [];
          const parts = {};
          if (clip && clip.text) {
            parts["text/plain"] = new win.Blob([clip.text], {
              type: "text/plain",
            });
          }
          if (clip && clip.html) {
            parts["text/html"] = new win.Blob([clip.html], {
              type: "text/html",
            });
          }
          if (Object.keys(parts).length > 0) {
            items.push(new win.ClipboardItem(parts));
          }
          for (const file of (clip && clip.files) || []) {
            items.push(
              new win.ClipboardItem({
                [file.type]: new win.Blob([fromBase64(file.data)], {
                  type: file.type,
                }),
              }),
            );
          }
          return items;
        });
      },
      execCommand(command, ...rest) {
        const name = String(command).toLowerCase();
        if (name !== "copy" && name !== "cut") {
          return originals.execCommand.call(this, command, ...rest);
        }
        // Synchronous, as the browser's own is: the page's copy handlers run now, and what they or
        // the selection give is sent on. Whether the agent's clipboard takes it is decided by the
        // worker, which refuses it outside the agent's own commands.
        const doc = this;
        let el = doc.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) {
          el = el.shadowRoot.activeElement;
        }
        const got = capture(doc, el || doc.body, name === "cut");
        if (!got.text && !got.html) {
          return false;
        }
        if (name === "cut" && got.editable && got.from === "selection") {
          originals.execCommand.call(doc, "delete");
        }
        ask({ op: "write", text: got.text, html: got.html }).catch(() => {});
        return true;
      },
    };
    const apply = (on) => {
      for (const name of Object.keys(originals)) {
        Object.defineProperty(owners[name], name, {
          value: on ? replacements[name] : originals[name],
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    };
    const state = {
      settle(id, ok, value) {
        const entry = pending.get(id);
        if (!entry) {
          return;
        }
        pending.delete(id);
        win.clearTimeout(entry.timer);
        if (ok) {
          entry.resolve(value);
        } else {
          entry.reject(refusal());
        }
      },
      restore() {
        apply(false);
        for (const entry of pending.values()) {
          win.clearTimeout(entry.timer);
          entry.reject(refusal());
        }
        pending.clear();
      },
      arm() {
        apply(true);
      },
    };
    Object.defineProperty(win, KEY, { value: state });
    apply(true);
  };
  const install = (win) => {
    try {
      if (win[KEY]) {
        win[KEY].arm();
      } else {
        build(win);
      }
    } catch (_e) {
      // A frame from another site, or one being torn down: nothing here can reach it.
    }
    try {
      for (let i = 0; i < win.frames.length; i += 1) {
        install(win.frames[i]);
      }
    } catch (_e) {
      // The frame list of a window going away.
    }
  };
  install(window);
}

function clipboardStandInScript() {
  return (
    "(" +
    clipboardStandInFn.toString() +
    ")(" +
    JSON.stringify(CLIPBOARD_STATE_KEY) +
    "," +
    JSON.stringify(CLIPBOARD_BINDING) +
    "," +
    clipboardCaptureFn.toString() +
    "," +
    CLIPBOARD_PAGE_CALL_MS +
    ")"
  );
}

// Runs in the page: the browser's own clipboard functions back, in this document and in every
// frame of it the page can reach.
function clipboardRestoreFn(KEY) {
  const restore = (win) => {
    try {
      if (win[KEY]) {
        win[KEY].restore();
      }
    } catch (_e) {
      // A frame from another site never had the stand-in.
    }
    try {
      for (let i = 0; i < win.frames.length; i += 1) {
        restore(win.frames[i]);
      }
    } catch (_e) {
      // The frame list of a window going away.
    }
  };
  restore(window);
}

// Put the page's own clipboard functions back. With the debugger still attached, through it;
// after it has gone, through chrome.scripting, which needs none. Best effort either way: a page
// scripts may not run on had no stand-in to take off.
async function restorePageClipboard(tabId, { attached }) {
  if (attached) {
    await sendCdp(tabId, "Runtime.evaluate", {
      expression:
        "(" +
        clipboardRestoreFn.toString() +
        ")(" +
        JSON.stringify(CLIPBOARD_STATE_KEY) +
        ")",
    }).catch(() => {});
    return;
  }
  try {
    if (
      chrome.scripting &&
      typeof chrome.scripting.executeScript === "function"
    ) {
      await Promise.resolve(
        chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "MAIN",
          func: clipboardRestoreFn,
          args: [CLIPBOARD_STATE_KEY],
        }),
      ).catch(() => {});
    }
  } catch (_e) {
    // chrome://, the Web Store: no stand-in was ever there.
  }
}

// The page's document, as a handle the copy and paste functions are called on, so what they are
// given travels as call arguments and is never spliced into code.
async function pageDocumentObjectId(tabId) {
  const res = await sendCdp(tabId, "Runtime.evaluate", {
    expression: "document",
    objectGroup: CDP_OBJECT_GROUP,
  });
  const objectId = res && res.result && res.result.objectId;
  if (!objectId) {
    throw new Error("Could not reach the page to use the clipboard.");
  }
  return objectId;
}

async function callOnPage(tabId, fnSource, args) {
  const call = await sendCdp(tabId, "Runtime.callFunctionOn", {
    objectId: await pageDocumentObjectId(tabId),
    functionDeclaration: fnSource,
    arguments: (args || []).map((v) => ({ value: v })),
    returnByValue: true,
  });
  if (!call || call.exceptionDetails || !call.result) {
    const detail =
      call && call.exceptionDetails
        ? call.exceptionDetails.exception &&
          call.exceptionDetails.exception.description
        : "";
    throw new Error(
      "The page could not be reached to use the clipboard" +
        (detail ? ": " + String(detail).slice(0, 200) : "."),
    );
  }
  return call.result.value;
}

// The agent's copy or cut, from wherever the page has focus. Nothing selected leaves the clipboard
// as it was, as a real copy does.
async function copyForAgent(session, tabId, cut) {
  const tab = tabStateOf(session, tabId);
  const got =
    (await callOnPage(
      tabId,
      "function(cut,maxText,maxHtml){return (" +
        agentCopyFn.toString() +
        ")(" +
        clipboardTargetFn.toString() +
        "," +
        clipboardCaptureFn.toString() +
        ",cut,maxText,maxHtml);}",
      [cut, MAX_CLIPBOARD_TEXT_CHARS, MAX_CLIPBOARD_HTML_CHARS],
    )) || {};
  const op = cut ? "cut" : "copy";
  if (got.crossFrame) {
    return {
      [op]: false,
      note:
        "Focus is inside a frame from another site, which cannot be copied from. Select text " +
        "in the page itself, or use browser_read for its text.",
    };
  }
  if (got.password) {
    return { [op]: false, note: "A password field's contents are not copied." };
  }
  if (got.tooLarge) {
    return {
      [op]: false,
      note: "The selection is larger than a clipboard holds; nothing was copied.",
    };
  }
  if (!got.text && !got.html) {
    return {
      [op]: false,
      note: "Nothing was selected, so nothing was copied; the clipboard is as it was.",
    };
  }
  setClipboard(session, tab.agent, {
    text: got.text,
    html: got.html,
    files: [],
    source: op,
  });
  let removed = false;
  if (cut && got.editable && got.from === "selection") {
    // The page did not handle the cut itself, so the selection goes as a trusted key would take
    // it -- through the page's own beforeinput, like any deletion.
    await dispatchKey(tabId, KEY_DEFS.backspace, 0);
    removed = true;
  }
  return Object.assign(
    { [op]: true, from: got.from, removed: cut ? removed : undefined },
    clipboardSummary(clipboardOf(session, tab.agent)),
  );
}

// Insert @p text as typed input. A text field takes it in one piece, line breaks and all. A rich
// region gets it line by line with Shift+Enter between: a plain Enter is "send" in every chat box,
// and pasting must never send anything.
async function insertPastedText(tabId, text, field) {
  if (field) {
    await sendCdp(tabId, "Input.insertText", { text });
    return;
  }
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) {
      await dispatchKey(tabId, KEY_DEFS.enter, MODIFIER_BITS.shift);
    }
    if (lines[i]) {
      await sendCdp(tabId, "Input.insertText", { text: lines[i] });
    }
  }
}

// The agent's paste, into whatever the page has focus. @p plain drops markup and files, as
// "paste without formatting" does.
async function pasteForAgent(session, tabId, plain) {
  const tab = tabStateOf(session, tabId);
  const clip = clipboardOf(session, tab.agent);
  if (!clip) {
    return {
      pasted: false,
      note:
        "This agent's clipboard is empty, so nothing was pasted. Copy something first, or put " +
        "it there with browser_clipboard write.",
    };
  }
  const offered = {
    text: clip.text,
    html: plain ? "" : clip.html,
    files: plain
      ? []
      : clip.files.map((file) => ({
          name: file.name,
          type: file.type,
          data: file.data,
        })),
  };
  const got =
    (await callOnPage(
      tabId,
      "function(clip){return (" +
        agentPasteFn.toString() +
        ")(" +
        clipboardTargetFn.toString() +
        ",clip);}",
      [offered],
    )) || {};
  const where = got.target ? { target: got.target } : {};
  if (got.handled === "page") {
    return Object.assign(
      { pasted: true, taken_by: "page", via: got.via },
      where,
    );
  }
  if (got.editable && offered.text) {
    await insertPastedText(tabId, offered.text, got.field === true);
    return Object.assign(
      {
        pasted: true,
        taken_by: "inserted",
        // A frame from another site cannot be looked into, so whether its focused element took the
        // text is not known here; the reply says only what was done.
        note: got.crossFrame
          ? "Focus is inside a frame from another site, which cannot be looked into: the text " +
            "was typed into whatever has focus there (formatting and files cannot reach it). " +
            "Check the result with browser_screenshot."
          : undefined,
      },
      where,
    );
  }
  return Object.assign(
    {
      pasted: false,
      note: got.editable
        ? "The page took nothing from the paste, and the clipboard holds no text to type in."
        : "Nothing editable has focus and the page did not take the paste. Focus a field first " +
          "(browser_click or browser_focus), or pass its ref.",
    },
    where,
  );
}

async function runClipboardOp(session, tabId, op) {
  switch (op) {
    case "copy":
      return copyForAgent(session, tabId, false);
    case "cut":
      return copyForAgent(session, tabId, true);
    case "paste":
      return pasteForAgent(session, tabId, false);
    case "pastePlain":
      return pasteForAgent(session, tabId, true);
    default:
      throw new Error("Unknown clipboard operation: " + op);
  }
}

// Select a ref'd element's contents, so copy and cut take that element rather than whatever
// happened to be selected.
async function selectForClipboard(tabId, backendNodeId) {
  const objectId = await resolveNodeObjectId(tabId, backendNodeId);
  const selected = await callOnNode(tabId, objectId, function () {
    const el = this;
    const win = el.ownerDocument.defaultView;
    if (
      el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && typeof el.select === "function")
    ) {
      el.focus();
      el.select();
      return true;
    }
    if (typeof el.focus === "function") {
      el.focus();
    }
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    const selection = win.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  });
  if (!selected) {
    throw new Error("Could not select the element; take a fresh snapshot.");
  }
}

// browser_clipboard. The clipboard is always the agent's that holds the tab.
async function handleClipboard(session, tabId, args) {
  const tab = tabStateOf(session, tabId);
  const agent = tab.agent || "";
  const action = String(args.action || "");
  if (action === "write") {
    const manifest = Array.isArray(args.files) ? args.files : [];
    try {
      const files = [];
      for (const entry of manifest) {
        const data = assembleUpload(session, entry.upload_id);
        if (data === null) {
          throw new Error(
            "Part of " +
              String(entry.name) +
              " never arrived; nothing was written.",
          );
        }
        files.push({
          name: String(entry.name || "file"),
          type:
            String(entry.mime || "application/octet-stream").slice(
              0,
              MAX_CLIPBOARD_TYPE_CHARS,
            ) || "application/octet-stream",
          size: Number(entry.size) || 0,
          data,
        });
      }
      setClipboard(session, agent, {
        text: typeof args.text === "string" ? args.text : "",
        html: typeof args.html === "string" ? args.html : "",
        files,
        source: "tool",
      });
    } finally {
      for (const entry of manifest) {
        session.uploadChunks.delete(entry.upload_id);
      }
    }
    return Object.assign(
      { ok: true, action },
      clipboardSummary(clipboardOf(session, agent)),
    );
  }
  if (action === "read") {
    const clip = clipboardOf(session, agent);
    return Object.assign(
      { ok: true, action },
      clipboardSummary(clip),
      clip ? { text: clip.text, html: clip.html } : {},
    );
  }
  if (action === "clear") {
    const had = session.clipboards.delete(agent);
    return { ok: true, action, cleared: had };
  }
  await ensureAttached(session, tabId);
  if (typeof args.backendNodeId === "number") {
    requireSnapshotTab(session, tabId);
    if (action === "paste") {
      await handleFocus(session, tabId, args);
    } else {
      await selectForClipboard(tabId, args.backendNodeId);
    }
  }
  if (action === "copy" || action === "cut") {
    return Object.assign(
      { ok: true, action },
      await runClipboardOp(session, tabId, action),
    );
  }
  if (action === "paste") {
    return Object.assign(
      { ok: true, action },
      await runClipboardOp(
        session,
        tabId,
        args.plain === true ? "pastePlain" : "paste",
      ),
    );
  }
  throw new Error(
    "browser_clipboard action must be write, read, clear, copy, cut, or paste.",
  );
}

// A page's clipboard call, through the stand-in's binding. Page-callable, so nothing it says is
// trusted beyond what it asks for: honoured only inside the agent's own command window on this
// tab, against this tab's agent's clipboard, and bounded like every other write.
async function answerPageClipboard(session, tab, params) {
  let call;
  try {
    call = JSON.parse(String(params.payload));
  } catch (_e) {
    return;
  }
  const id = call && Number.isInteger(call.id) ? call.id : null;
  if (id === null || !Number.isInteger(params.executionContextId)) {
    return;
  }
  const settle = (ok, value) =>
    sendCdp(tab.id, "Runtime.callFunctionOn", {
      executionContextId: params.executionContextId,
      functionDeclaration:
        "function(key,id,ok,value){var s=window[key];if(s){s.settle(id,ok,value);}}",
      arguments: [
        { value: CLIPBOARD_STATE_KEY },
        { value: id },
        { value: ok },
        { value: value === undefined ? null : value },
      ],
    }).catch(() => {});
  if (!(tab.inputUntil > Date.now()) || !session.tabs.has(tab.id)) {
    return settle(false);
  }
  const agent = tab.agent || "";
  if (call.op === "read") {
    const clip = clipboardOf(session, agent);
    session.clipboardDuringCommand = Object.assign(
      {},
      session.clipboardDuringCommand,
      { page_read: true },
    );
    return settle(
      true,
      clip
        ? {
            text: clip.text,
            html: clip.html,
            files: clip.files.map((file) => ({
              type: file.type,
              data: file.data,
            })),
          }
        : { text: "", html: "", files: [] },
    );
  }
  if (call.op !== "write") {
    return settle(false);
  }
  const files = [];
  for (const file of Array.isArray(call.files) ? call.files : []) {
    if (
      !file ||
      typeof file.data !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
    ) {
      return settle(false);
    }
    files.push({
      name: String(file.name || "clipboard").slice(0, 120),
      type: String(file.type || "application/octet-stream").slice(
        0,
        MAX_CLIPBOARD_TYPE_CHARS,
      ),
      size: Math.floor((file.data.length * 3) / 4),
      data: file.data,
    });
  }
  try {
    setClipboard(session, agent, {
      text: typeof call.text === "string" ? call.text : "",
      html: typeof call.html === "string" ? call.html : "",
      files,
      source: "page",
    });
  } catch (_e) {
    return settle(false);
  }
  session.clipboardDuringCommand = Object.assign(
    {},
    session.clipboardDuringCommand,
    { page_wrote: clipboardSummary(clipboardOf(session, agent)) },
  );
  return settle(true, null);
}

// The url/title nearly every reply in this file names its target by. A url the browser did not
// give us is an unidentified page, and reporting it as "" would put that page's snapshot, read,
// print, or navigation on record as a page with no address -- an observation nobody made. The
// title is genuinely optional (a loading tab has none), so only the url fails the command.
async function tabInfo(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (typeof tab.url !== "string") {
    throw new Error(
      "Could not read the tab's URL (the tab is gone, or the host permission for it is absent).",
    );
  }
  return {
    url: tab.url,
    title: typeof tab.title === "string" ? tab.title : "",
  };
}

// -- CDP attach lifecycle ----------------------------------------------------

function sendCdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

// Every objectId CDP hands back is a RETAINED handle: it pins the JS wrapper -- and the DOM node
// it names, detached or not -- in the renderer until the execution context is destroyed. The
// handles here are all short-lived (one command resolves a ref, hit-tests a point, or polls a
// selector and is done), so they are tagged with one group name and the whole group is released
// when the command ends. Without that a single wait_for polling every 250ms, or a long session of
// clicks each running an occlusion test, accumulates thousands of handles on one document.
const CDP_OBJECT_GROUP = "chrome_control_mcp";

// Drop the handles the command that just finished resolved. This is cleanup AFTER the answer is
// computed: the two ways it can fail (the session detached, the context was destroyed) have both
// already freed every handle in the group, so failing the completed command over it would report
// an error about work that succeeded. It is logged rather than swallowed.
async function releaseCdpObjects(session) {
  const state =
    session.actedTabId !== null ? session.tabs.get(session.actedTabId) : null;
  if (!state || !state.attached) {
    return;
  }
  await sendCdp(state.id, "Runtime.releaseObjectGroup", {
    objectGroup: CDP_OBJECT_GROUP,
  }).catch((e) => {
    console.warn("[ChromeControlMCP] releaseObjectGroup failed:", e);
  });
}

// The domains a controlled tab cannot run without. getFullAXTree needs DOM + Accessibility;
// Page backs getFrameTree, the javascriptDialogOpening auto-answer (without it a confirm() PAUSES
// the tab and every later command blocks to the transport deadline), and the navigation events
// that raise domEpoch -- the sole signal that retires a stale ref. Network backs the in-flight
// tracking browser_wait_for reads for network_idle. A domain that failed to enable is a safety
// mechanism silently switched off, so it takes the whole attach down rather than leaving a tab
// that looks controlled and is not. enable is idempotent.
async function enableSessionDomains(session, state) {
  const tabId = state.id;
  state.networkInstrumented = false;
  await sendCdp(tabId, "DOM.enable");
  await sendCdp(tabId, "Accessibility.enable");
  await sendCdp(tabId, "Page.enable");
  await sendCdp(tabId, "Network.enable");
  // What the page says about itself. Runtime carries console calls and uncaught exceptions; Log
  // carries what the BROWSER reports about the page -- a blocked mixed-content load, a CSP
  // violation, a failed subresource -- which never reaches the page's own console API. Both are
  // read-only: they report, they cannot act.
  await sendCdp(tabId, "Runtime.enable");
  await sendCdp(tabId, "Log.enable");
  state.networkInstrumented = true;
  state.inflightRequests.clear();
  state.lastNetworkActivityMs = Date.now();
  // The controlled window is normally NOT the OS-focused one: the user keeps working in other
  // applications while the session drives this tab, and the session never raises the window to
  // change that. Focus emulation lets the page behave as focused regardless -- focus/blur events,
  // :focus styles, document.hasFocus() -- so typing into focus-gated widgets works in the
  // background. It is an experimental CDP method, so a browser without it keeps control with
  // real focus semantics rather than refusing to attach at all.
  await sendCdp(tabId, "Emulation.setFocusEmulationEnabled", {
    enabled: true,
  }).catch((e) => {
    console.warn("[ChromeControlMCP] focus emulation unavailable:", e);
  });
  // The frame and badge are drawn into every document this tab loads from now on, as the browser
  // creates it -- not re-drawn afterwards from here. Re-drawing on Page.frameNavigated raced the new
  // document: the evaluate could land in the old one, or before the new one could take it, and the
  // page then showed no sign of control until the next command. The registration belongs to this
  // attachment, so detaching removes it and nothing is drawn on a page no longer controlled.
  await sendCdp(tabId, "Page.addScriptToEvaluateOnNewDocument", {
    source: presenceOnNewDocumentScript(tabId),
  }).catch((e) => {
    console.warn("[ChromeControlMCP] presence registration unavailable:", e);
  });
  // The File System Access picker's stand-in (see armFilePickers), in this document and every one
  // after it. Inert until a command arms it.
  await sendCdp(tabId, "Runtime.addBinding", { name: PICKER_BINDING }).catch(
    () => {},
  );
  await sendCdp(tabId, "Page.addScriptToEvaluateOnNewDocument", {
    source: filePickerShimScript(),
  }).catch(() => {});
  await sendCdp(tabId, "Runtime.evaluate", {
    expression: filePickerShimScript(),
  }).catch(() => {});
  // The page's clipboard API, answered from the agent's clipboard (see "Agent clipboards"), in
  // this document and every one after it. Unlike the picker's this is never inert: a page in a held
  // tab must not reach the system clipboard at any time, only the agent's, and only when the agent
  // is acting on it.
  await sendCdp(tabId, "Runtime.addBinding", { name: CLIPBOARD_BINDING }).catch(
    () => {},
  );
  await sendCdp(tabId, "Page.addScriptToEvaluateOnNewDocument", {
    source: clipboardStandInScript(),
  }).catch((e) => {
    console.warn("[ChromeControlMCP] clipboard stand-in unavailable:", e);
  });
  await sendCdp(tabId, "Runtime.evaluate", {
    expression: clipboardStandInScript(),
  }).catch(() => {});
}

async function ensureAttached(session, tabId) {
  const state = session.tabs.get(tabId);
  if (!state) {
    throw new Error("Tab " + tabId + " is not one of this session's tabs.");
  }
  if (!state.attached) {
    // One attach per tab at a time: a command and a background attach for the same tab share it
    // rather than racing into "Another debugger is already attached".
    if (!state.attaching) {
      state.attaching = attachTab(session, state).finally(() => {
        state.attaching = null;
      });
    }
    await state.attaching;
  }
  // Keep the control presence visible on every action (and re-created after a page wiped it);
  // cheap + idempotent. This is what makes the assistant's control persistently apparent, not
  // only during a pointer action.
  await refreshControlPresence(tabId);
}

async function attachTab(session, state) {
  const tabId = state.id;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    const m = String(error && error.message ? error.message : error);
    if (!m.includes("Another debugger") || !(await ownStaleAttachment(tabId))) {
      if (m.includes("Another debugger")) {
        throw new Error(
          "Cannot inspect the tab: DevTools (or another debugger) is attached.",
          { cause: error },
        );
      }
      throw new Error("Cannot attach to the tab: " + m, { cause: error });
    }
    // Our own attachment from a worker that no longer exists: take it over.
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.debugger.attach({ tabId }, "1.3");
  }
  // Claim the tab only once initialization has fully succeeded. Marking it attached first makes a
  // failed enable PERMANENT: every later command finds the tab already attached, skips this, and
  // never retries the domain -- so the tab runs on with its dialog auto-answer and its epoch
  // invalidation quietly absent, reporting success throughout.
  try {
    await enableSessionDomains(session, state);
  } catch (error) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    throw new Error(
      "Cannot prepare the tab for control: " +
        String(error && error.message ? error.message : error),
      { cause: error },
    );
  }
  if (!session.tabs.has(tabId) || session.ended) {
    // Let go of while the attach was in flight: do not leave the debugger on a tab nobody holds.
    await chrome.debugger.detach({ tabId }).catch(() => {});
    throw new Error("Tab " + tabId + " is no longer held.");
  }
  state.attached = true;
}

// Whether this extension already holds a debugger attachment to the tab that no live record knows
// about. Chrome keeps an extension's attachments when its worker is retired and restarted, so the
// new worker finds "another debugger" on a tab that is in fact its own.
async function ownStaleAttachment(tabId) {
  const targets = await chrome.debugger.getTargets().catch(() => []);
  return (Array.isArray(targets) ? targets : []).some(
    (target) =>
      target.tabId === tabId &&
      target.attached &&
      target.extensionId === chrome.runtime.id,
  );
}

// Everything known about one tab's page that stops being true once the debugger is off it.
//
// The attachment ends two ways -- this worker detaches on purpose, or the browser detaches for us
// when the user closes the tab or opens DevTools -- and the tab is in the same state afterwards
// either way, because what is no longer true does not depend on who ended it. This existed as two
// lists that had drifted: the onDetach path did not retire the command generation, did not clear
// the captured User-Agent, and did not drop a half-delivered upload. None of those has a visible
// symptom at the moment it goes wrong, which is why the divergence survived.
function releaseTabState(session, state) {
  // Retire whatever a polling handler (browser_wait_for, browser_download) is watching, so it
  // abandons instead of driving a tab nothing is attached to any more.
  session.commandGeneration++;
  // The DOM every outstanding ref was captured against is gone. Raising the generation is what
  // makes the server retire this tab's refs rather than hold refs that now name nodes in another
  // renderer.
  state.domEpoch++;
  state.lastSnapshotEpoch = null; // and its DOM generation no longer names a live document
  state.lastShot = null; // and any screenshot coordinates are against a dead render
  state.pendingDialogPolicy = null; // an armed dialog response does not carry across attachments
  state.dialogArmActive = false;
  state.lastDialog = null; // nor does a prior page's dialog report
  state.inflightRequests.clear(); // network-idle tracking does not carry across attachments
  state.consoleEntries = []; // what a page we no longer drive said is not this session's record
  state.consoleDropped = 0;
  state.networkEntries = [];
  state.networkDropped = 0;
  state.networkPending.clear();
  state.networkInstrumented = false; // nor does the Network domain: the next attach enables its own
  state.originalUserAgent = null; // emulation overrides end with the attachment; recapture next time
  state.httpAuthCreds = null; // armed HTTP-auth credentials do not carry across attachments
  state.lastFetchError = null; // nor does an interception failure from a page we no longer drive
  state.fileChooser = null; // a caught picker was the detached page's
  state.pickersArmed = false; // the interception ended with the attachment
  if (state.disarmTimer) {
    clearTimeout(state.disarmTimer);
    state.disarmTimer = null;
  }
  if (session.recording && session.recording.tabId === state.id) {
    discardRecording(session); // an unfinished video is not a video
  }
}

// Drop a recording without producing a file.
//
// A session whose attachment ended cannot finish what it was recording: the
// frames stop arriving, and the bytes already encoded cover only part of what
// was asked for. Writing them out as a .webm would hand back a file that looks
// complete and is not, so the encoder is released and the partial bytes go.
//
// Fire-and-forget by construction: this runs on teardown paths that cannot
// wait, including one the browser initiated. The offscreen document answers
// "nothing to discard" when there was no recording, so calling it always is
// safe.
function discardRecording(session) {
  if (!session.recording) {
    return;
  }
  const id = session.recording.id;
  session.recording = null;
  toOffscreen({ type: "record.discard", session: id }).catch(() => {
    // The document may already be gone, which is the same outcome.
  });
}

// The user opening DevTools, cancelling Chrome's "started debugging this browser" bar, or the tab
// closing, detaches us. The tab stays held -- the next command that needs it attaches again -- but
// everything known about its page is released now, exactly as a deliberate detach releases it.
chrome.debugger.onDetach.addListener((source) => {
  if (!source) {
    return;
  }
  // The listener fires for every target this extension is attached to, including tabs other
  // sessions hold. Reacting to one this session never held would retire a live command generation
  // and blank a snapshot that is still valid, so the detach is routed to its holder or ignored.
  const held = attachedHolderOf(source.tabId);
  if (held) {
    held.tab.attached = false;
    setTabControlBadge(source.tabId, false); // control ended; clear the toolbar badge
    releaseTabState(held.session, held.tab);
    // The frame drawn on the page outlives the attachment; take it off without one. So does the
    // clipboard stand-in, which has nothing to answer it now.
    void removeControlPresenceWithoutDebugger(source.tabId);
    void restorePageClipboard(source.tabId, { attached: false });
  }
});

// A JavaScript dialog (alert/confirm/prompt/beforeunload) PAUSES the page until CDP answers
// it; with the Page domain enabled we must respond or every later command on the tab wedges.
// Default by type: alert only has OK (accept just closes it), and beforeunload accepts so a
// navigation the automation is driving is not blocked; confirm/prompt DISMISS (cancel) so a
// page can never auto-confirm a destructive action -- the model opts into acceptance per
// dialog via browser_dialog. A page cannot escalate through this: it only ever gets its own
// default, or an accept the model explicitly armed (an input-gated tool).
function defaultDialogAccept(type) {
  return type === "alert" || type === "beforeunload";
}

// A paused request that could not be resumed stalls the page on that resource. Keep the newest
// such failure so browser_http_auth can surface it; discarding it leaves a hung page with nothing
// anywhere that explains why.
function recordFetchError(tab, e) {
  tab.lastFetchError = String(e && e.message ? e.message : e);
}

// The dialog kinds Chrome reports on Page.javascriptDialogOpening. A value outside this set is
// metadata we could not read, and an unreadable dialog must not be answered as an "alert" --
// that default ACCEPTS. Anything unrecognized is normalized to a type that dismisses.
const DIALOG_TYPES = new Set(["alert", "confirm", "prompt", "beforeunload"]);

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source) {
    return;
  }
  // Same routing as onDetach: the event belongs to whichever session holds that
  // attachment, and to that session's record of the tab. Resolved once here and used for the
  // whole body, including the callbacks below that run after this listener has returned.
  const held = attachedHolderOf(source.tabId);
  if (!held) {
    return;
  }
  const { session, tab } = held;
  // Screencast frames feed a recording, and nothing else: a frame arriving for
  // a session that is not recording is still acknowledged, because CDP holds
  // the next one until the last is acked.
  if (method === "Page.screencastFrame") {
    void onScreencastFrame(session, source.tabId, params);
    return;
  }
  // The page asked for a file while its pickers were being caught (see armFilePickers).
  if (method === "Page.fileChooserOpened") {
    if (params && Number.isInteger(params.backendNodeId)) {
      noteFileChooser(session, tab, {
        kind: "input",
        backendNodeId: params.backendNodeId,
        multiple: params.mode === "selectMultiple",
        directory: params.mode === "uploadFolder",
      });
    }
    return;
  }
  if (method === "Runtime.bindingCalled") {
    if (params && params.name === CLIPBOARD_BINDING) {
      void answerPageClipboard(session, tab, params);
      return;
    }
    if (params && params.name === PICKER_BINDING) {
      // Page-callable, so what it says is only a hint: a page that calls it on its own records a
      // picker that browser_upload then finds nothing waiting for, and says so.
      let multiple;
      try {
        multiple = JSON.parse(String(params.payload)).multiple === true;
      } catch (_e) {
        multiple = false;
      }
      noteFileChooser(session, tab, {
        kind: "picker",
        multiple,
        directory: false,
      });
    }
    return;
  }
  // The driven page asked to open a window; the tab it becomes is claimed for the session.
  if (method === "Page.windowOpen") {
    noteWindowOpen(session, tab, params && params.url);
    return;
  }
  // A page that rebuilt its body after loading took the frame with it; put it back once the page
  // has finished loading. Documents get the frame as they are created (enableSessionDomains), so
  // this is only for pages that remove it themselves.
  if (method === "Page.loadEventFired") {
    void refreshControlPresence(source.tabId);
    return;
  }
  // Network-activity tracking for browser_wait_for network_idle. A request starting records its
  // id; finishing/failing drops it. Set semantics are what make a REDIRECT harmless: the hop
  // re-sends requestWillBeSent under the same requestId and only one completion ever arrives, so
  // a count would keep a phantom request in flight for the life of the document. An event without
  // an id is not recorded -- an entry nothing can ever remove would wedge idle permanently.
  if (method === "Network.requestWillBeSent") {
    if (params && params.requestId) {
      tab.inflightRequests.add(params.requestId);
      const requestUrl = params.request ? String(params.request.url || "") : "";
      // Inline content is not network activity, and there is a lot of it: the media element's
      // own controls alone load dozens of data: URLs for their icons, which filled the whole ring
      // and pushed out every request the page actually made. A data: or blob: URL is bytes the
      // page already had -- no connection, no server, no status worth reporting -- so it is
      // tracked for network_idle above (it does complete, and idle must wait for it) and left out
      // of the log below.
      if (isInlineRequestUrl(requestUrl)) {
        tab.lastNetworkActivityMs = Date.now();
        return;
      }
      // A redirect re-fires this event for the SAME requestId, carrying the response that
      // redirected. Overwriting the pending entry here lost that hop entirely: a form POST that
      // 302s was logged only as the GET that followed, which defeats the one thing the tool is
      // for -- confirming that a form actually posted. Log the hop before replacing it.
      const redirect = params.redirectResponse;
      const superseded = tab.networkPending.get(params.requestId);
      if (redirect && superseded) {
        recordNetwork(tab, {
          method: superseded.method,
          url: superseded.url,
          type: superseded.type,
          status: Number(redirect.status) || 0,
          mime_type: boundedText(redirect.mimeType, 64) || null,
          failed: false,
          error: null,
          // Where it went. Without this a 302 is a status with no destination, and the entry
          // that follows looks like an unrelated request to a different URL.
          redirected_to: boundedText(requestUrl, MAX_ENTRY_URL_CHARS),
          ms: Math.max(0, Date.now() - superseded.startedMs),
        });
      }
      // Held until the response arrives, because CDP reports the method and URL here and the
      // status there. Capped: a page that starts requests it never finishes must not grow this
      // map for ever, and the oldest pending entry is the one least likely to still complete.
      if (tab.networkPending.size >= MAX_PENDING_REQUESTS) {
        const oldest = tab.networkPending.keys().next();
        if (!oldest.done) {
          tab.networkPending.delete(oldest.value);
        }
      }
      tab.networkPending.set(params.requestId, {
        method: boundedText(params.request ? params.request.method : "", 16),
        url: boundedText(
          params.request ? params.request.url : "",
          MAX_ENTRY_URL_CHARS,
        ),
        type: boundedText(params.type, 32),
        startedMs: Date.now(),
      });
    }
    tab.lastNetworkActivityMs = Date.now();
    return;
  }
  // A request is logged when its RESPONSE arrives, not when its body finishes loading. Two
  // measured reasons, both of which produced an empty log:
  //
  // The document's own request completes the navigation it caused, and the navigation clears the
  // pending map -- so waiting for loadingFinished lost the single most useful entry in the log,
  // every time.
  //
  // A fetch() whose body is never read never finishes loading at all. The response arrives, the
  // status is known, and loadingFinished does not come; the request sat in flight for the life of
  // the session. The fixture's own 404 probe is exactly that shape.
  //
  // `ms` is therefore time-to-response rather than time-to-last-byte, which is the number worth
  // having anyway: it is what the server took, not what the body cost to stream.
  if (method === "Network.responseReceived") {
    const pending =
      params && params.requestId
        ? tab.networkPending.get(params.requestId)
        : null;
    if (pending && params.response) {
      tab.networkPending.delete(params.requestId);
      recordNetwork(tab, {
        method: pending.method,
        url: pending.url,
        type: pending.type,
        status: Number(params.response.status) || 0,
        mime_type: boundedText(params.response.mimeType, 64) || null,
        failed: false,
        error: null,
        redirected_to: null,
        ms: Math.max(0, Date.now() - pending.startedMs),
      });
    }
    return;
  }
  if (
    method === "Network.loadingFinished" ||
    method === "Network.loadingFailed"
  ) {
    if (params && params.requestId) {
      tab.inflightRequests.delete(params.requestId);
      // A request still pending here never got a response: it failed outright (DNS, refused,
      // blocked). One that did get a response was logged and removed at that point, so reaching
      // this with an entry still in the map IS the failure case.
      const pending = tab.networkPending.get(params.requestId);
      if (pending) {
        tab.networkPending.delete(params.requestId);
        if (method === "Network.loadingFailed") {
          recordNetwork(tab, {
            method: pending.method,
            url: pending.url,
            type: pending.type,
            // A request that never got a response has no status; saying 0 would read as a server
            // answering 0. The error text is the answer in that case.
            status: null,
            mime_type: null,
            failed: true,
            error:
              boundedText(params.errorText, MAX_ENTRY_TEXT_CHARS) || "failed",
            redirected_to: null,
            ms: Math.max(0, Date.now() - pending.startedMs),
          });
        }
      }
    }
    tab.lastNetworkActivityMs = Date.now();
    return;
  }
  // What the page's own script logged.
  if (method === "Runtime.consoleAPICalled") {
    const args = Array.isArray(params && params.args) ? params.args : [];
    recordConsole(tab, {
      level: boundedText(params && params.type, 16) || "log",
      text: boundedText(
        args.map(consoleArgText).filter(Boolean).join(" "),
        MAX_ENTRY_TEXT_CHARS,
      ),
      source: "console",
      at: topFrameOf(params && params.stackTrace),
    });
    return;
  }
  // An uncaught exception or an unhandled promise rejection. This is the one an agent most needs:
  // a click that "did nothing" usually did throw.
  if (method === "Runtime.exceptionThrown") {
    const details = (params && params.exceptionDetails) || {};
    const thrown = details.exception || {};
    recordConsole(tab, {
      level: "error",
      // The exception's own description carries the class and message ("TypeError: x is not a
      // function"); details.text is usually just "Uncaught".
      text: boundedText(
        thrown.description || details.text || "uncaught exception",
        MAX_ENTRY_TEXT_CHARS,
      ),
      source: "exception",
      at:
        topFrameOf(details.stackTrace) ||
        (details.url
          ? boundedText(details.url, MAX_ENTRY_URL_CHARS) +
            ":" +
            ((Number(details.lineNumber) || 0) + 1)
          : null),
    });
    return;
  }
  // What the BROWSER says about the page: a blocked mixed-content load, a CSP violation, a
  // subresource that 404ed. None of this reaches the page's console API, so without it an agent
  // sees a page that simply does not work and no reason why.
  if (method === "Log.entryAdded") {
    const entry = (params && params.entry) || {};
    recordConsole(tab, {
      level: boundedText(entry.level, 16) || "info",
      text: boundedText(entry.text, MAX_ENTRY_TEXT_CHARS),
      source: boundedText(entry.source, 32) || "browser",
      at: entry.url
        ? boundedText(entry.url, MAX_ENTRY_URL_CHARS) +
          ":" +
          ((Number(entry.lineNumber) || 0) + 1)
        : null,
    });
    return;
  }
  // HTTP-auth interception (browser_http_auth). While Fetch is enabled we MUST answer every
  // paused request or the page wedges: an auth challenge gets the armed credentials (or the
  // browser default when disarmed), and every other paused request is continued untouched.
  if (method === "Fetch.authRequired") {
    // Only hand the armed credentials to a challenge from the SAME origin they were
    // armed for. A bare urlPattern:"*" makes Fetch pause every request, so without
    // this an armed 401 answer would also be sent to a cross-origin subresource or a
    // redirected challenger and silently leak the password. Every other challenger
    // gets the browser default (native dialog / cancel).
    const challengeOrigin =
      params && params.authChallenge ? params.authChallenge.origin : null;
    const originMatches =
      tab.httpAuthCreds &&
      originsMatch(challengeOrigin, tab.httpAuthCreds.origin);
    const response = originMatches
      ? {
          response: "ProvideCredentials",
          username: tab.httpAuthCreds.username,
          password: tab.httpAuthCreds.password,
        }
      : { response: "Default" };
    sendCdp(source.tabId, "Fetch.continueWithAuth", {
      requestId: params.requestId,
      authChallengeResponse: response,
    }).catch((e) => recordFetchError(tab, e));
    return;
  }
  if (method === "Fetch.requestPaused") {
    sendCdp(source.tabId, "Fetch.continueRequest", {
      requestId: params.requestId,
    }).catch((e) => recordFetchError(tab, e));
    return;
  }
  // A navigation ends the page an armed response was meant for; drop it so an accept armed
  // for page A cannot auto-confirm page B's first dialog. Cover both a real document swap
  // (top-frame Page.frameNavigated) and a client-side/SPA route change
  // (Page.navigatedWithinDocument). A beforeunload for the navigation itself fires BEFORE the
  // commit, so an arm meant for it is still honored.
  const topFrameNav =
    method === "Page.frameNavigated" &&
    params &&
    params.frame &&
    !params.frame.parentId;
  if (topFrameNav || method === "Page.navigatedWithinDocument") {
    tab.domEpoch++; // the document/route changed: any prior ref_index is stale
    tab.pendingDialogPolicy = null;
    if (topFrameNav) {
      // A new document: any in-flight request from the old page is moot -- reset so a request
      // that never reported completion cannot keep network_idle from ever resolving.
      tab.inflightRequests.clear();
      // A request the old document started and that never answered will never answer now, so its
      // pending entry would sit in the map for the life of the session and be counted as in
      // flight for ever. Anything that DID answer was already logged when its response arrived,
      // including the document request that caused this navigation. The completed log is kept:
      // what the last page loaded is still true, and every entry names its own URL.
      tab.networkPending.clear();
      tab.lastNetworkActivityMs = Date.now();
      // Armed HTTP-auth credentials were meant for the page being left; disarm them so a
      // navigation (or an attacker-driven redirect) cannot carry them into a new document.
      tab.httpAuthCreds = null;
      // A file input the old document asked to fill is gone with it.
      tab.fileChooser = null;
      // The new document draws its own frame as it is created (enableSessionDomains). Re-drawing
      // from here raced it, landing in the old document or before the new one could take it.
      return;
    }
    // An in-document route change keeps the document, but a framework re-rendering the page may
    // have taken the frame with it.
    void refreshControlPresence(source.tabId);
    return;
  }
  if (method !== "Page.javascriptDialogOpening") {
    return;
  }
  const rawType = params && typeof params.type === "string" ? params.type : "";
  const type = DIALOG_TYPES.has(rawType) ? rawType : "unknown";
  const message =
    params && typeof params.message === "string" ? params.message : "";
  const frameUrl = params && typeof params.url === "string" ? params.url : "";
  let accept = defaultDialogAccept(type);
  let promptText;
  // An arm belongs to the document it was armed against, and to the command it was armed for.
  // Page.javascriptDialogOpening reports the frame that opened the dialog, and a page can embed a
  // third-party iframe -- or simply wait for the gap between tool calls -- to fire a confirm()
  // that would otherwise consume an accept armed for the top document's next action. A dialog
  // that matches neither gets the type default and leaves the arm in place for its own dialog.
  if (
    tab.pendingDialogPolicy &&
    tab.dialogArmActive &&
    dialogSourceMatches(frameUrl, tab.pendingDialogPolicy.origin)
  ) {
    accept = tab.pendingDialogPolicy.accept;
    promptText = tab.pendingDialogPolicy.text;
    tab.pendingDialogPolicy = null; // one-shot: never carry an armed response to a later dialog
  }
  const answer = { accept };
  if (accept && typeof promptText === "string") {
    answer.promptText = promptText;
  }
  // The record follows the ANSWER, never the intent. Page.handleJavaScriptDialog can reject (the
  // dialog was already gone, the session detached mid-answer), and the page then stays PAUSED --
  // every later command on the tab blocks to the transport deadline. Reporting that dialog as
  // handled would hide the one fact that explains it, and the one-shot arm is already spent.
  sendCdp(source.tabId, "Page.handleJavaScriptDialog", answer).then(
    () => {
      tab.lastDialog = { type, message, accepted: accept, url: frameUrl };
    },
    (e) => {
      tab.lastDialog = {
        type,
        message,
        accepted: null,
        url: frameUrl,
        answer_failed: String(e && e.message ? e.message : e),
      };
    },
  );
});

// The session's record of a tab a command is acting on. Every tab-scoped command reaches its
// handler through commandTabId, which only ever yields a held tab, so a miss here is a tab let go
// of while the command ran -- refused rather than acted on as nobody's.
function tabStateOf(session, tabId) {
  const state = session.tabs.get(tabId);
  if (!state) {
    throw new Error(
      "Tab " + tabId + " is no longer one of this session's tabs.",
    );
  }
  return state;
}

// Refs are valid only on the tab their snapshot was taken from AND only against the DOM
// generation it was captured at. The server binds every ref to its tab and sends the command to
// that tab, so what is checked here is the generation: refuse a ref action when the page moved
// under it (a navigation the page itself drove, a detach), or when this tab was never snapshotted.
function requireSnapshotTab(session, tabId) {
  const tab = tabStateOf(session, tabId);
  if (tab.lastSnapshotEpoch === null) {
    throw new Error(
      "There is no snapshot of tab " +
        tabId +
        " to act on; call browser_snapshot on it before acting on an element.",
    );
  }
  if (tab.domEpoch !== tab.lastSnapshotEpoch) {
    throw new Error(
      "The page changed since the last snapshot; call browser_snapshot again before " +
        "acting on an element.",
    );
  }
}

// -- snapshot: accessibility roles/names joined with DOM-snapshot geometry ----

function axValue(v) {
  return v && v.value !== undefined && v.value !== null ? String(v.value) : "";
}

// Null-prototype, because the keys are property NAMES arriving from the accessibility tree
// and the values are read back by name a few lines later. On a plain object literal, a
// property named "__proto__" would set this map's prototype instead of becoming an own key,
// and every later lookup for a state the page never set would resolve through an object the
// page chose. Chrome populates these names from its own AXPropertyName enum rather than from
// page strings, so this is defence in depth rather than a live hole -- but a null prototype
// costs nothing and removes the question.
function indexProps(properties) {
  const map = Object.create(null);
  for (const p of properties || []) {
    if (p && p.name && p.value) {
      map[p.name] = p.value.value;
    }
  }
  return map;
}

// One DOMSnapshot gives every node's backendNodeId + layout bounds in a single call,
// so geometry is a map lookup instead of an N-round-trip DOM.getBoxModel per node.
// captureSnapshot returns ONE document per same-process frame (main at [0], same-origin
// iframes at [1..]); getFullAXTree stitches those same-process subframes into one tree,
// so their nodes need geometry too. Merge EVERY document -- backendNodeId is unique
// tab-wide, so a single map keyed by it has no cross-document collisions.
// Insert the rounded layout box of every node in one document into `map`, keyed by backend node id.
// Split out of buildBoundsMap so the per-document guards and the per-node loop stay individually
// under the complexity limit; behavior is identical to the previous single nested loop.
function addNodeBounds(map, backendIds, nodeIndex, bounds) {
  for (let i = 0; i < nodeIndex.length; i++) {
    const backend = backendIds[nodeIndex[i]];
    const b = bounds[i];
    if (backend === undefined || !b) {
      continue;
    }
    map.set(backend, {
      x: Math.round(b[0]),
      y: Math.round(b[1]),
      width: Math.round(b[2]),
      height: Math.round(b[3]),
    });
  }
}

// Whether a node carries one of the pointer handler attributes above. Attributes arrive as a
// flat [nameIndex, valueIndex, ...] run of string-table indices.
function hasPointerHandlerAttr(attributes, strings) {
  for (let i = 0; i + 1 < (attributes || []).length; i += 2) {
    if (
      POINTER_HANDLER_ATTRS.has(String(strings[attributes[i]]).toLowerCase())
    ) {
      return true;
    }
  }
  return false;
}

// The computed cursor of every laid-out node in one document, keyed by its node index. Styles
// arrive parallel to layout.nodeIndex, one array per node in the order captureSnapshot was asked
// for them -- "cursor" is the only one asked for, so it is always element 0.
function cursorsOfDocument(doc, strings) {
  const cursors = new Map();
  const layout = (doc && doc.layout) || {};
  const nodeIndex = layout.nodeIndex || [];
  const styles = layout.styles || [];
  for (let i = 0; i < nodeIndex.length; i++) {
    const style = styles[i];
    if (style && style.length > 0 && strings[style[0]] != null) {
      cursors.set(nodeIndex[i], String(strings[style[0]]));
    }
  }
  return cursors;
}

// Why one node in a document counts as wired to the pointer, or null if nothing says it is.
//
// cursor is an INHERITED property: a card with cursor:pointer hands it to every descendant, and
// promoting on the computed value alone turns one clickable card into a ref for the card, its
// heading, its paragraph and its image. Measured, not assumed -- a child inside a pointer card
// reports "pointer" itself. Comparing against the parent is what keeps the outermost element,
// which is the one a click belongs on.
function wiredReasonFor(index, nodes, cursors, strings, clickable) {
  if (clickable.has(index)) {
    return "click";
  }
  if (hasPointerHandlerAttr((nodes.attributes || [])[index], strings)) {
    return "hover";
  }
  const parent = (nodes.parentIndex || [])[index];
  if (cursors.get(index) === "pointer" && cursors.get(parent) !== "pointer") {
    return "pointer";
  }
  return null;
}

// What Chrome already knows about which elements answer the pointer, read out of the SAME
// DOMSnapshot the geometry comes from -- no extra round trip, no evaluation in the page.
//
// This exists because a real page builds its controls out of divs. To the accessibility tree a
// div with a click handler is "generic" with no name, which the capture drops and the renderer
// would drop again -- so the model was shown scenery where the page had a button, and the only
// way to reach it was browser_click_at with a pixel read off a screenshot.
function buildActionableMap(snapshot) {
  const map = new Map();
  const strings = (snapshot && snapshot.strings) || [];
  for (const doc of (snapshot && snapshot.documents) || []) {
    const nodes = (doc && doc.nodes) || {};
    const backendIds = nodes.backendNodeId || [];
    // isClickable is RareBooleanData: the node indices that are true, and nothing for the rest.
    const clickable = new Set(
      (nodes.isClickable && nodes.isClickable.index) || [],
    );
    const cursors = cursorsOfDocument(doc, strings);
    for (let i = 0; i < backendIds.length; i++) {
      const backend = backendIds[i];
      if (backend === undefined || map.has(backend)) {
        continue;
      }
      const reason = wiredReasonFor(i, nodes, cursors, strings, clickable);
      if (reason) {
        map.set(backend, reason);
      }
    }
  }
  return map;
}

function buildBoundsMap(snapshot) {
  const map = new Map();
  const documents = (snapshot && snapshot.documents) || [];
  for (const doc of documents) {
    if (!doc || !doc.nodes || !doc.layout) {
      continue;
    }
    const layout = doc.layout;
    addNodeBounds(
      map,
      doc.nodes.backendNodeId || [],
      layout.nodeIndex || [],
      layout.bounds || [],
    );
  }
  return map;
}

function isEditableRole(role) {
  return role === "textbox" || role === "searchbox";
}

// An ARIA state that is present but false is not the same fact as one that is absent, so
// these helpers only ever ADD a field. A caller reading a missing field learns "the page did
// not say", which is the honest answer, rather than a fabricated false.
const axTruthy = (v) => v === true || v === "true" || v === "mixed";

// ARIA `checked` is TRI-state. "mixed" is a partially-checked control (the "select all" whose
// children are split), which is neither checked nor unchecked: collapsing it either way states
// something about the control that is not true, so it is reported as its own field and the
// boolean is left absent -- the outline then makes no claim it cannot support.
function axApplyCheckedState(props, rec) {
  if (props.checked === "mixed") {
    rec.mixed = true;
  } else if (props.checked !== undefined) {
    rec.checked = props.checked === true || props.checked === "true";
  }
}

// The states that are simply "present and true" become one row each. Written as data rather
// than as a branch per state so that adding an ARIA state is a table entry, and so the shape
// of the check is visible side by side instead of spread over fifteen conditionals.
const AX_STATE_FLAGS = [
  { prop: "disabled", field: "disabled", when: (v) => v === true },
  { prop: "readonly", field: "readonly", when: (v) => v === true },
  { prop: "required", field: "required", when: (v) => v === true },
  { prop: "busy", field: "busy", when: (v) => v === true },
  { prop: "selected", field: "selected", when: axTruthy },
  { prop: "pressed", field: "pressed", when: axTruthy },
  // "invalid" carries a reason string ("spelling", "grammar"), so anything that is not
  // absent and not an explicit false counts as invalid.
  {
    prop: "invalid",
    field: "invalid",
    when: (v) => v !== undefined && v !== false && v !== "false",
  },
];

// ARIA state, so the model can read expanded/selected/pressed/validity without a round-trip.
function axApplyStateFlags(props, role, rec) {
  for (const flag of AX_STATE_FLAGS) {
    if (flag.when(props[flag.prop])) {
      rec[flag.field] = true;
    }
  }
  if (
    isEditableRole(role) ||
    (props.editable !== undefined && props.editable !== false)
  ) {
    rec.editable = true;
  }
  axApplyCheckedState(props, rec);
  // expanded is reported as a real boolean rather than only when true, because a collapsed
  // control and a control with no expanded state are different facts to a caller.
  if (props.expanded !== undefined && props.expanded !== "undefined") {
    rec.expanded = axTruthy(props.expanded);
  }
}

// The live value of inputs, sliders and spinbuttons.
function axApplyValueFields(node, props, rec) {
  const currentValue = node.value && node.value.value;
  if (
    currentValue !== undefined &&
    currentValue !== null &&
    currentValue !== ""
  ) {
    // A silently sliced value reads as the whole value; mark the cut like every other capped
    // field in this file so a longer entry is not mistaken for the control's full contents.
    const raw = String(currentValue);
    rec.value = raw.slice(0, AX_VALUE_MAX_CHARS);
    if (raw.length > AX_VALUE_MAX_CHARS) {
      rec.value_truncated = true;
    }
  }
  if (
    typeof props.valuemin === "number" &&
    typeof props.valuemax === "number"
  ) {
    rec.valuemin = props.valuemin;
    rec.valuemax = props.valuemax;
  }
}

function axApplyGeometry(node, boundsByBackend, rec) {
  if (typeof node.backendDOMNodeId !== "number") {
    return;
  }
  rec.backendNodeId = node.backendDOMNodeId;
  const b = boundsByBackend.get(node.backendDOMNodeId);
  if (b) {
    rec.bounds = b;
  }
}

// A box worth aiming at. A node with no layout entry, or one laid out to nothing, is not
// something a click or a hover could be pointed at however it was wired -- and admitting those
// would spend the node budget on elements no tool can use.
function hasUsableBox(boundsByBackend, backend) {
  const box = backend === null ? null : boundsByBackend.get(backend);
  return Boolean(box) && box.width > 0 && box.height > 0;
}

function axNodeToCapture(node, depth, boundsByBackend, wiredByBackend) {
  if (node.ignored) {
    return null;
  }
  const role = axValue(node.role).toLowerCase();
  const name = axValue(node.name);
  const props = indexProps(node.properties);
  const focusable = props.focusable === true;
  const backend =
    typeof node.backendDOMNodeId === "number" ? node.backendDOMNodeId : null;
  const byRole =
    INTERACTABLE_ROLES.has(role) || (focusable && !STRUCTURAL_ROLES.has(role));
  // What the page wired to the pointer, for the elements whose role and focusability say
  // nothing. Only ones with a box, and only when the role has not already earned the ref.
  const wired =
    byRole || !hasUsableBox(boundsByBackend, backend)
      ? null
      : wiredByBackend.get(backend) || null;
  const interactable = byRole || wired !== null;
  // Structural, unnamed, non-interactable filler is dropped by the C++ renderer anyway
  // (roleIsStructuralNoise); not emitting it here keeps the node budget for content the
  // model can actually see or act on.
  if (!interactable && !name && STRUCTURAL_ROLES.has(role)) {
    return null;
  }
  const rec = {
    role,
    name,
    depth,
    interactable,
    visible: props.hidden !== true,
  };
  if (wired !== null) {
    // Why this one carries a ref when its role says "generic". The renderer whitelists the
    // three values; it is never shown as free text.
    rec.wired = wired;
  }
  axApplyGeometry(node, boundsByBackend, rec);
  axApplyStateFlags(props, role, rec);
  axApplyValueFields(node, props, rec);
  return rec;
}

// Walk the AX tree in document (pre-order) order, tracking depth, emitting the capture
// nodes the C++ renderSnapshot consumes.
// The roots of the AX tree are the nodes no other node lists as a child.
function axRootsOf(axNodes) {
  const childOf = new Set();
  for (const n of axNodes) {
    for (const c of n.childIds || []) {
      childOf.add(c);
    }
  }
  return axNodes.filter((n) => !childOf.has(n.nodeId));
}

// Push a node's resolvable children onto the DFS stack. pop() is LIFO, so children go on in REVERSE
// to come off in document order -- the same reason the roots are seeded in reverse. Pushed forward,
// the LAST child is walked first and its subtree can spend the whole node budget, truncating an
// earlier sibling out of the outline while `truncated` gives no hint which part is missing.
function pushChildren(stack, node, byId, depth) {
  const kids = (node.childIds || [])
    .map((cid) => byId.get(cid))
    .filter(Boolean);
  for (let i = kids.length - 1; i >= 0; i--) {
    stack.push({ node: kids[i], depth: depth + 1 });
  }
}

// Depth-first walk of the seeded roots, emitting capture records in document order. The emitted cap
// (MAX_CAPTURE_NODES) does not bound the WALK on its own -- axNodeToCapture drops unnamed structural
// filler, so a tree of a million <div>s is traversed in full while `out` stays tiny, a
// page-controlled way to hold the single command channel busy past the transport deadline. The
// visit cap bounds that; either bound biting leaves the stack non-empty, reporting the outline as
// partial rather than whole.
function walkAxTree(roots, byId, boundsByBackend, wiredByBackend) {
  const out = [];
  const seen = new Set();
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i--) {
    stack.push({ node: roots[i], depth: 0 });
  }
  let visited = 0;
  const maxVisits = 20 * MAX_CAPTURE_NODES;
  while (
    stack.length &&
    out.length < MAX_CAPTURE_NODES &&
    visited < maxVisits
  ) {
    visited++;
    const { node, depth } = stack.pop();
    if (!node || seen.has(node.nodeId)) {
      continue;
    }
    seen.add(node.nodeId);
    const rec = axNodeToCapture(node, depth, boundsByBackend, wiredByBackend);
    if (rec) {
      out.push(rec);
    }
    pushChildren(stack, node, byId, depth);
  }
  // A non-empty stack means we hit a cap and dropped the rest of the tree; the caller must tell the
  // model the outline is partial rather than present it as whole.
  return { nodes: out, truncated: stack.length > 0 };
}

function buildNodes(axTree, boundsByBackend, wiredByBackend) {
  const axNodes = (axTree && axTree.nodes) || [];
  const byId = new Map(axNodes.map((n) => [n.nodeId, n]));
  return walkAxTree(
    axRootsOf(axNodes),
    byId,
    boundsByBackend,
    wiredByBackend || new Map(),
  );
}

// Count every frame in the tree Chrome reports for the tab.
function countFrames(frameTree) {
  if (!frameTree) {
    return 0;
  }
  let total = 1;
  for (const child of frameTree.childFrames || []) {
    total += countFrames(child);
  }
  return total;
}

// DOMSnapshot's documentURL keeps the "#fragment" (it mirrors document.URL), but
// Page.getFrameTree's frame.url drops it (the fragment is a separate frame.urlFragment we
// never read). Compare both sides fragment-insensitively, or a page at ".../docs#intro"
// with no iframes would see its own main frame falsely listed as an omitted cross-origin one.
function stripFragment(url) {
  return String(url).split("#")[0];
}

// The document URLs the single capture DID reach (main frame + same-process subframes),
// fragment-stripped. DOMSnapshot stores documentURL as an index into the shared string table.
function sameProcessUrls(snapshot) {
  const urls = new Set();
  const strings = (snapshot && snapshot.strings) || [];
  for (const doc of (snapshot && snapshot.documents) || []) {
    if (
      doc &&
      typeof doc.documentURL === "number" &&
      strings[doc.documentURL] != null
    ) {
      urls.add(stripFragment(strings[doc.documentURL]));
    }
  }
  return urls;
}

function collectFrameUrls(frameTree, out) {
  if (!frameTree || !frameTree.frame) {
    return;
  }
  if (frameTree.frame.url) {
    out.push(frameTree.frame.url);
  }
  for (const child of frameTree.childFrames || []) {
    collectFrameUrls(child, out);
  }
}

// Deduplicate http(s) frame URLs into a capped list, reporting whether the cap cut it. Only
// http(s), so the model gets frames it can actually navigate to. Scanning continues past the cap
// instead of breaking, so truncated reflects frames genuinely left out rather than every
// duplicate or non-http entry that happened to trail the list.
function capFrameUrls(urls, covered) {
  const omitted = [];
  const seen = new Set();
  let truncated = false;
  for (const url of urls) {
    const key = stripFragment(url);
    if (
      !/^https?:\/\//i.test(url) ||
      (covered && covered.has(key)) ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    if (omitted.length >= MAX_OMITTED_FRAMES) {
      truncated = true;
      continue;
    }
    omitted.push(url); // the original (already fragmentless) URL, navigable as-is
  }
  return { frames: omitted, truncated };
}

// The http(s) frames present in the tab but NOT covered by the same-process capture, i.e.
// the cross-origin (out-of-process) iframes whose content is missing.
function collectOmittedFrames(snapshot, frameTree) {
  const covered = sameProcessUrls(snapshot);
  const all = [];
  collectFrameUrls(frameTree, all);
  return capFrameUrls(all, covered);
}

// <audio>/<video> elements are frequently absent or unnamed in the AX tree (no native
// controls), so the model gets no ref to drive browser_media. Surface them directly from
// the DOM (by tag) as ref'd capture nodes, deduped against what the AX pass already emitted.
// Each element costs its own serial DOM.describeNode round trip and the list is page-controlled,
// so it is capped twice: at a fixed ceiling (a page can trivially carry 50,000 <video> tags, and
// 50,000 round trips outlive the bridge's I/O deadline and tear the connection down) and at
// whatever is left of the snapshot's node budget. A cap that bit is reported, never hidden.
const MAX_MEDIA_NODES = 100;
// The same ceiling, for the same reason, on the file inputs collected below: each costs a serial
// round trip and the count is the page's to choose. Lower, because a page with more than a few
// dozen file inputs is not a page anyone is uploading to by name.
const MAX_FILE_INPUT_NODES = 50;

async function collectMediaNodes(tabId, existing) {
  const have = new Set(
    existing
      .filter((n) => typeof n.backendNodeId === "number")
      .map((n) => n.backendNodeId),
  );
  const out = [];
  // A scan that FAILED and a page that genuinely has no media produce the same empty list, and
  // the model reads the empty one as an absence of <audio>/<video>. The scan reads therefore
  // propagate: an unusable media pass fails the snapshot, so the caller re-takes it, rather than
  // stating an absence nothing observed.
  const doc = await sendCdp(tabId, "DOM.getDocument", { depth: 0 });
  const root = doc && doc.root && doc.root.nodeId;
  if (!root) {
    throw new Error(
      "The page exposed no document node to scan for media elements.",
    );
  }
  const found = await sendCdp(tabId, "DOM.querySelectorAll", {
    nodeId: root,
    selector: "audio,video",
  });
  const all = (found && found.nodeIds) || [];
  const budget = Math.max(
    0,
    Math.min(MAX_MEDIA_NODES, MAX_CAPTURE_NODES - existing.length),
  );
  let truncated = all.length > budget;
  for (const nodeId of all.slice(0, budget)) {
    // One element that went away between the query and the describe is a node this capture could
    // not cover -- not a failed scan. It counts as partiality, which the snapshot already reports,
    // instead of silently shortening the list.
    const d = await sendCdp(tabId, "DOM.describeNode", { nodeId }).catch(
      () => null,
    );
    const node = d && d.node;
    if (!node) {
      truncated = true;
      continue;
    }
    if (
      typeof node.backendNodeId !== "number" ||
      have.has(node.backendNodeId)
    ) {
      continue;
    }
    const attrs = {};
    const a = node.attributes || [];
    for (let i = 0; i + 1 < a.length; i += 2) {
      attrs[a[i]] = a[i + 1];
    }
    const role =
      (node.nodeName || "").toLowerCase() === "video" ? "video" : "audio";
    const name = attrs["aria-label"] || attrs["title"] || role;
    out.push({
      role,
      name,
      depth: 0,
      interactable: true,
      visible: true,
      backendNodeId: node.backendNodeId,
    });
    have.add(node.backendNodeId);
  }
  return { nodes: out, truncated };
}

// Every file input on the page, whether or not the page shows it.
//
// This is the one control the web hides on purpose: `<input type="file">` is set to display:none
// and a styled button, label, or menu item is put in front of it. A hidden input has no box and
// no accessibility node, so the ordinary pass cannot see it, and browser_upload -- the tool whose
// whole job is to give that element a file -- would have nothing to name on any real page. So
// they are collected directly from the DOM and merged in, marked `hidden_input` when the page is
// not showing them, and the outline flags them so a model knows what it is looking at. They are
// named only: nothing computes a click point from a node with no box.
async function collectFileInputs(tabId, existing) {
  const have = new Set(
    existing
      .filter((n) => typeof n.backendNodeId === "number")
      .map((n) => n.backendNodeId),
  );
  const out = [];
  const doc = await sendCdp(tabId, "DOM.getDocument", { depth: 0 });
  const root = doc && doc.root && doc.root.nodeId;
  if (!root) {
    throw new Error(
      "The page exposed no document node to scan for file inputs.",
    );
  }
  const found = await sendCdp(tabId, "DOM.querySelectorAll", {
    nodeId: root,
    selector: 'input[type="file"]',
  });
  const all = (found && found.nodeIds) || [];
  const budget = Math.max(
    0,
    Math.min(MAX_FILE_INPUT_NODES, MAX_CAPTURE_NODES - existing.length),
  );
  let truncated = all.length > budget;
  for (const nodeId of all.slice(0, budget)) {
    const described = await sendCdp(tabId, "DOM.describeNode", {
      nodeId,
    }).catch(() => null);
    const node = described && described.node;
    if (!node) {
      truncated = true;
      continue;
    }
    if (
      typeof node.backendNodeId !== "number" ||
      have.has(node.backendNodeId)
    ) {
      continue; // already named by the accessibility pass: the page shows this one
    }
    const attrs = {};
    const pairs = node.attributes || [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      attrs[pairs[i]] = pairs[i + 1];
    }
    // Named by whatever the page gives, in the order a person would recognise it.
    const name =
      attrs["aria-label"] ||
      attrs["title"] ||
      attrs["name"] ||
      attrs["id"] ||
      "file input";
    out.push({
      role: "filechooser",
      name,
      depth: 0,
      interactable: true,
      visible: true,
      hidden_input: true,
      accepts: attrs["accept"] || "",
      multiple: Object.prototype.hasOwnProperty.call(attrs, "multiple"),
      backendNodeId: node.backendNodeId,
    });
    have.add(node.backendNodeId);
  }
  return { nodes: out, truncated };
}

async function captureSnapshot(session, tabId) {
  const tab = tabStateOf(session, tabId);
  await ensureAttached(session, tabId);
  // The capture is five sequential CDP reads. A top-frame navigation part way through does not
  // throw -- it silently leaves geometry and AX nodes from document A joined to the url/title
  // (and stamped with the epoch) of document B, and backendNodeIds restart across a cross-process
  // navigation, so a ref minted from A can resolve to an unrelated element in B. The bridge
  // treats a snapshot reply as a NEW baseline rather than a check, so it would adopt that mixed
  // capture as the ref_index of record: the comparison has to happen here.
  const startEpoch = tab.domEpoch;
  const snapshot = await sendCdp(tabId, "DOMSnapshot.captureSnapshot", {
    // cursor is what tells a styled div apart from scenery; it rides along with the geometry
    // read rather than costing a call of its own.
    computedStyles: ["cursor"],
  });
  const boundsByBackend = buildBoundsMap(snapshot);
  const wiredByBackend = buildActionableMap(snapshot);
  const axTree = await sendCdp(tabId, "Accessibility.getFullAXTree", {});
  const built = buildNodes(axTree, boundsByBackend, wiredByBackend);
  const media = await collectMediaNodes(tabId, built.nodes);
  const withMedia = built.nodes.concat(media.nodes);
  // After the accessibility pass, so an input the page actually shows is named once, by the pass
  // that knows its label and its box; only the ones nothing else could see are added here.
  const fileInputs = await collectFileInputs(tabId, withMedia);
  const nodes = withMedia.concat(fileInputs.nodes);
  const truncated = built.truncated || media.truncated || fileInputs.truncated;
  const info = await tabInfo(tabId);
  // getFullAXTree + DOMSnapshot cover the main frame and its SAME-process subframes.
  // Cross-origin (out-of-process) iframes live in separate targets this single pass does
  // not reach, so their content is absent. Detect that (more frames exist than
  // same-process documents) and flag it, so the model is told the capture is partial
  // instead of concluding those elements do not exist.
  let iframesOmitted;
  let omittedFrames = [];
  let omittedFramesTruncated = false;
  try {
    const tree = await sendCdp(tabId, "Page.getFrameTree", {});
    const cut = collectOmittedFrames(snapshot, tree && tree.frameTree);
    omittedFrames = cut.frames;
    omittedFramesTruncated = cut.truncated;
    const totalFrames = countFrames(tree && tree.frameTree);
    const sameProcessDocs = ((snapshot && snapshot.documents) || []).length;
    // Flag omission from either signal: the named http(s) frames, or a frame-count excess
    // (covers non-http frames the URL list intentionally skips).
    iframesOmitted = omittedFrames.length > 0 || totalFrames > sameProcessDocs;
  } catch (_error) {
    // If the frame tree is unavailable, do not claim completeness we cannot verify.
    iframesOmitted = true;
  }
  if (tab.domEpoch !== startEpoch) {
    throw new Error(
      "The page navigated while the snapshot was being taken; take another snapshot.",
    );
  }
  // Stamp the snapshot ONLY after the capture fully succeeded: a throw in any await above
  // (DOMSnapshot/getFullAXTree/tabInfo) or the generation check just made leaves the stamp
  // untouched, so requireSnapshotTab keeps failing closed on refs the model never received.
  tab.lastSnapshotEpoch = tab.domEpoch; // refs are valid only against the generation captured
  return {
    url: info.url,
    title: info.title,
    nodes,
    truncated,
    iframesOmitted,
    omittedFrames,
    omittedFramesTruncated,
  };
}

// -- read --------------------------------------------------------------------

// The read format the caller asked for. An unrecognized value is not a request for text: mapping
// "markdown" or "HTML" onto text silently answers a different question than the one asked.
function readFormat(args) {
  if (!args || args.format === undefined || args.format === null) {
    return "text";
  }
  if (args.format !== "text" && args.format !== "html") {
    throw new Error('browser_read format must be "text" or "html".');
  }
  return args.format;
}

// The subframes the read did NOT cover. innerText/outerHTML are properties of the MAIN document,
// so an iframe's content is absent from both -- and for embedded apps (docs viewers, chat
// widgets, payment frames) that is where the content lives. Reporting the omission is what keeps
// a partial read from being read as "the page has nothing on it". http(s) frames are named so the
// model can navigate to one; a frame tree we could not read claims no completeness at all.
async function readOmittedFrames(tabId) {
  let tree;
  try {
    tree = await sendCdp(tabId, "Page.getFrameTree", {});
  } catch (_e) {
    return {
      iframesOmitted: true,
      omittedFrames: [],
      omittedFramesTruncated: false,
    };
  }
  const urls = [];
  // Count the frames structurally rather than inferring from the URL list: a frame with no
  // reportable url (about:blank, srcdoc) still holds content this read did not cover.
  let subframes = 0;
  for (const child of (tree && tree.frameTree && tree.frameTree.childFrames) ||
    []) {
    subframes += countFrames(child);
    collectFrameUrls(child, urls);
  }
  // No same-process document covers a read, so every subframe URL is omitted from it.
  const cut = capFrameUrls(urls, null);
  return {
    iframesOmitted: subframes > 0,
    omittedFrames: cut.frames,
    omittedFramesTruncated: cut.truncated,
  };
}

async function handleRead(session, tabId, args) {
  const format = readFormat(args);
  await ensureAttached(session, tabId);
  const read =
    format === "html"
      ? "document.documentElement ? document.documentElement.outerHTML : ''"
      : "document.body ? document.body.innerText : " +
        "(document.documentElement ? document.documentElement.innerText : '')";
  const res = await sendCdp(tabId, "Runtime.evaluate", {
    expression: presenceFreeReadScript(read),
    returnByValue: true,
  });
  // An evaluation that threw (a page can redefine HTMLElement.prototype.innerText, or the read
  // can land while document.body is null) has established nothing about the page. Reporting it as
  // empty content with ok tells the model the page has no text, which is a claim about the page
  // rather than about the failure.
  if (
    !res ||
    res.exceptionDetails ||
    !res.result ||
    typeof res.result.value !== "string"
  ) {
    throw new Error(
      "Could not read the page content; take a fresh snapshot and try again.",
    );
  }
  let content = res.result.value;
  let truncated = false;
  if (content.length > MAX_READ_CHARS) {
    content = content.slice(0, MAX_READ_CHARS);
    truncated = true;
  }
  const info = await tabInfo(tabId);
  const frames = await readOmittedFrames(tabId);
  return {
    format,
    content,
    truncated,
    url: info.url,
    title: info.title,
    iframesOmitted: frames.iframesOmitted,
    omittedFrames: frames.omittedFrames,
  };
}

// -- screenshot (vision): a PNG of the active tab over CDP --------------------
//
// Page.captureScreenshot rasterizes at the browser level (no getUserMedia / display
// prompt, no OS screen capture), so it sees only the tab -- never other windows or the
// desktop. full_page uses captureBeyondViewport with a clip sized to the document, capped
// at the Skia edge limit. The base64 PNG rides back in the reply payload; the bridge caps
// its size and returns it as an MCP image content block.
// The live tab's render fingerprint in one evaluate: devicePixelRatio (the display's scale times
// the browser zoom, so below 1 on a zoomed-out page), the visual viewport's pinch scale and its
// offset inside the layout viewport, the scroll offset, the document URL, and the layout viewport
// size. dpr bounds the screenshot clip in the DEVICE pixels Skia rasters, and the whole tuple
// binds a screenshot to the exact render a later coordinate click must match. The viewport size
// is part of it because browser_emulate can relay the whole page out at a new width/height
// without moving href, dpr, or scroll; the pinch is part of it because a trackpad pinch moves
// every pixel on screen without moving any of those.
// `ok` is false when the page could not be read: callers must fail closed on it rather than
// trust the placeholder values, so that two failed reads (shot + click) can never compare
// equal and wave a blind coordinate click through.
async function viewportState(tabId) {
  const res = await sendCdp(tabId, "Runtime.evaluate", {
    expression:
      "({dpr: window.devicePixelRatio, sx: window.scrollX, sy: window.scrollY, href: location.href," +
      " iw: window.innerWidth, ih: window.innerHeight, vs: visualViewport.scale," +
      " vl: visualViewport.offsetLeft, vt: visualViewport.offsetTop})",
    returnByValue: true,
  }).catch(() => null);
  const v = res && res.result && res.result.value ? res.result.value : null;
  // A scroll offset or pinch the page did not report is not zero: taken as zero, it would move
  // every hit test and coordinate conversion onto whatever sits at the unscrolled, unpinched spot.
  if (
    !v ||
    typeof v.href !== "string" ||
    !Number.isFinite(v.dpr) ||
    v.dpr <= 0 ||
    !Number.isFinite(v.iw) ||
    !Number.isFinite(v.ih) ||
    v.iw <= 0 ||
    v.ih <= 0 ||
    !Number.isFinite(v.sx) ||
    !Number.isFinite(v.sy) ||
    !Number.isFinite(v.vs) ||
    v.vs <= 0 ||
    !Number.isFinite(v.vl) ||
    !Number.isFinite(v.vt)
  ) {
    return {
      ok: false,
      dpr: 1,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      scrollX: 0,
      scrollY: 0,
      href: "",
      width: 0,
      height: 0,
    };
  }
  return {
    ok: true,
    dpr: v.dpr,
    scale: v.vs,
    offsetX: v.vl,
    offsetY: v.vt,
    scrollX: v.sx,
    scrollY: v.sy,
    href: v.href,
    width: Math.round(v.iw),
    height: Math.round(v.ih),
  };
}

// Does the live render still match the one a screenshot was taken against? Every field here
// moves pixels under a coordinate the model measured off that image: a scroll, zoom, or pinch, a
// navigation, a same-URL reload or SPA route change (which href alone cannot see -- hence the
// DOM generation), and a viewport resize.
function shotMatchesRender(tab, shot, now) {
  return (
    now.ok &&
    now.dpr === shot.dpr &&
    now.scale === shot.scale &&
    now.offsetX === shot.offsetX &&
    now.offsetY === shot.offsetY &&
    now.href === shot.href &&
    now.scrollX === shot.scrollX &&
    now.scrollY === shot.scrollY &&
    now.width === shot.width &&
    now.height === shot.height &&
    tab.domEpoch === shot.epoch
  );
}

// Run a command with a bound on the wait. Resolves to {value} when it answers, {timedOut:true}
// when it does not; a command that fails outright still rejects, because that is an answer. The
// abandoned command keeps a catch of its own: it can still reject later (a detach mid-capture),
// and an unhandled rejection in the worker would take down a session whose call was already
// answered.
function raceDeadline(promise, milliseconds) {
  let timer = null;
  const settledLate = promise.catch(() => undefined);
  return Promise.race([
    promise.then((value) => ({ value })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), milliseconds);
    }),
  ]).finally(() => {
    clearTimeout(timer);
    void settledLate;
  });
}

// Is this tab the one Chrome is actually drawing? Only the active tab of a window that is not
// minimized composites, and only a compositing tab answers a plain capture. Unknowable state
// (the tab or window is gone from under us) counts as not on screen: the forced path works
// either way, where the plain one can wait forever.
async function tabIsOnScreen(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.active) {
    return false;
  }
  const home = await chrome.windows.get(tab.windowId).catch(() => null);
  return Boolean(home) && home.state !== "minimized";
}

// Capture the tab, forcing the frames Chrome needs when it is not drawing the tab itself. An
// on-screen tab is captured directly and falls back if that does not answer -- a window can be
// fully covered by another, which stops its frames as surely as a background tab does, and
// nothing in the extension can see that from here.
async function captureScreenshotWithFrames(tabId, params) {
  if (await tabIsOnScreen(tabId)) {
    const direct = await raceDeadline(
      sendCdp(tabId, "Page.captureScreenshot", params),
      ON_SCREEN_CAPTURE_DEADLINE_MS,
    );
    if (!direct.timedOut) {
      return direct.value;
    }
  }
  await sendCdp(tabId, "Page.startScreencast", FRAME_FORCING_SCREENCAST);
  let forced;
  try {
    forced = await raceDeadline(
      sendCdp(tabId, "Page.captureScreenshot", params),
      FORCED_CAPTURE_DEADLINE_MS,
    );
  } finally {
    // The cast must not outlive the capture: it is the tab's own frames being relayed, and a cast
    // left running keeps compositing a tab nobody is looking at.
    await sendCdp(tabId, "Page.stopScreencast", {}).catch(() => undefined);
  }
  if (forced.timedOut) {
    throw new Error(
      "The screenshot timed out: the tab produced no frame within " +
        FORCED_CAPTURE_DEADLINE_MS / 1000 +
        " s. A tab whose window is minimized cannot be captured; restore the window, or use " +
        "browser_read for the page's text.",
    );
  }
  return forced.value;
}

async function handleScreenshot(session, tabId, args) {
  const tab = tabStateOf(session, tabId);
  await ensureAttached(session, tabId);
  const fullPage = Boolean(args && args.full_page === true);
  const includeControlOverlay = Boolean(
    args && args.include_control_overlay === true,
  );
  const params = { format: "png", captureBeyondViewport: fullPage };
  const metrics = fullPage
    ? await sendCdp(tabId, "Page.getLayoutMetrics", {}).catch(() => null)
    : null;
  const state = await viewportState(tabId);
  const clipped = { applied: false };
  if (fullPage) {
    // The document's size in CSS px. cssContentSize is TRUNCATED to whole pixels (Chrome reports
    // 1876 for a 1876.8px document), which cuts the last device row off a page whose height is
    // fractional; the device-pixel contentSize over the page's dpr is the exact size (measured
    // equal to the root element's getBoundingClientRect at 1.25x, 2x at 110%, 1.5x at 67%, and 1x
    // at 33%). Without the metrics there is no document-sized clip, and the capture would silently
    // fall back to captureBeyondViewport with no bounds -- a different image than the full page
    // that was asked for, returned as though it were it.
    const device = metrics && metrics.contentSize;
    const zoom =
      metrics && metrics.cssVisualViewport && metrics.cssVisualViewport.zoom;
    if (
      !state.ok ||
      !device ||
      !(device.width > 0) ||
      !(device.height > 0) ||
      !(zoom > 0)
    ) {
      throw new Error(
        "Cannot capture the full page: the browser did not report the document's layout metrics.",
      );
    }
    // Capturing beyond the viewport relays the page out at its full size and back, and a pinch
    // does not survive it: Chrome returns the page at 1x with the pinch's vertical offset folded
    // into the scroll and its horizontal offset gone (measured: 1.7x at (123.6, 82.2) came back
    // 1x, scrolled 82px further). Nothing puts the pinch's offset back, so on a tab the user has
    // pinched this would undo their zoom and move their page. A desktop pinch never goes below
    // 1x; the thousandth is float noise.
    if (Math.abs(state.scale - 1) > 0.001) {
      throw new Error(
        "The page is pinch-zoomed (" +
          state.scale.toFixed(2) +
          "x), and a full-page screenshot would reset that zoom and move the page. Take a " +
          "viewport screenshot (full_page: false) instead.",
      );
    }
    const contentWidth = device.width / state.dpr;
    const contentHeight = device.height / state.dpr;
    // Chrome reads the clip in DIPs -- CSS px times the browser zoom -- not CSS px: a clip of the
    // document's CSS size captured twice the document at 50% zoom and cut it short at 110%. It
    // also truncates the clip to whole DIPs before scaling it (a 1876.8 clip captured 1876), so
    // round UP: the image holds the whole document and less than one DIP of the page's background
    // past its end. The thousandth absorbs the float noise of a dpr like 2.200000047683716, which
    // would otherwise round an exact size up a whole pixel.
    const wholeDips = (css) => Math.ceil(css * zoom - 0.001);
    // Bound the clip so the DEVICE raster (DIPs x the display's scale) stays within Skia's 16384
    // cap; a plain clamp would let a tall page overflow the surface and fail the capture on any
    // scaled display (Windows scaling, Retina).
    const displayScale = state.dpr / zoom;
    const maxDipEdge = Math.max(1, Math.floor(MAX_SHOT_EDGE_PX / displayScale));
    params.clip = {
      x: 0,
      y: 0,
      width: Math.min(wholeDips(contentWidth), maxDipEdge),
      height: Math.min(wholeDips(contentHeight), maxDipEdge),
      scale: 1,
    };
    // A document taller (or wider) than Skia's raster cap is CLIPPED, and the image then shows
    // the top slice of a long page. Say so: the model otherwise reasons about "the full page"
    // from a fraction of it. The sizes are the document's and the capture's, in CSS px.
    clipped.applied =
      wholeDips(contentWidth) > maxDipEdge ||
      wholeDips(contentHeight) > maxDipEdge;
    clipped.content_width = Math.round(contentWidth);
    clipped.content_height = Math.round(contentHeight);
    clipped.captured_width = Math.round(params.clip.width / zoom);
    clipped.captured_height = Math.round(params.clip.height / zoom);
  }
  // Model-facing screenshots hide control presence by default so it never obscures page media.
  // Documentation captures can opt in to the exact frame, badge, and cursor the user sees.
  let hidden = true;
  if (!includeControlOverlay) {
    hidden = await setPresenceVisible(tabId, false);
  }
  let res;
  try {
    res = await captureScreenshotWithFrames(tabId, params);
  } finally {
    if (!includeControlOverlay) {
      await setPresenceVisible(tabId, true);
    }
  }
  const data = res && typeof res.data === "string" ? res.data : "";
  if (!data) {
    throw new Error("Screenshot capture returned no image data.");
  }
  if (data.length > MAX_SHOT_BASE64) {
    throw new Error(
      fullPage
        ? "The captured image is too large to return; capture the viewport instead of the full page."
        : "The captured image is too large to return; reduce the window or the page's zoom.",
    );
  }
  // Bind this image to the exact render so a later browser_click_at can convert with the
  // same dpr and refuse if the tab, dpr, scroll, or document moved. Only bind when the
  // fingerprint was read successfully; otherwise leave no binding so a coordinate click
  // fails closed ("no current screenshot") rather than trusting placeholder values.
  tab.lastShot = state.ok
    ? {
        tabId,
        fullPage,
        dpr: state.dpr,
        scale: state.scale,
        offsetX: state.offsetX,
        offsetY: state.offsetY,
        scrollX: state.scrollX,
        scrollY: state.scrollY,
        href: state.href,
        width: state.width,
        height: state.height,
        epoch: tab.domEpoch,
      }
    : null;
  const info = await tabInfo(tabId);
  // Dimensions are read authoritatively from the PNG header on the bridge side, so they
  // reflect the real device pixels regardless of dpr/clip. What the header cannot show is that a
  // full-page capture was CUT to the raster cap -- the image looks whole -- so the document's own
  // size rides along whenever the clamp bit.
  const payload = {
    data,
    mimeType: "image/png",
    url: info.url,
    title: info.title,
    // What the image HOLDS, not what was asked for: a hide that did not take leaves the frame,
    // badge, and cursor in the capture, and saying otherwise would describe an image nobody took.
    control_overlay_included: includeControlOverlay || !hidden,
  };
  if (clipped.applied) {
    payload.clipped = true;
    payload.content_width = clipped.content_width;
    payload.content_height = clipped.content_height;
    payload.captured_width = clipped.captured_width;
    payload.captured_height = clipped.captured_height;
  }
  return payload;
}

// -- input: browser-level injection (the user's OS cursor is never touched) ---
//
// Every action here is driven by the assistant through the code-verified bridge and
// gated by the app's confirmation policy before it arrives; a page can neither initiate
// input nor supply the target (backendNodeId comes from our own validated snapshot,
// text/keys from the model). Actions are dispatched over CDP Input, so they land in the
// page at the browser level and the user's real mouse/keyboard are untouched.

// Center of a CDP content-box quad [x1,y1,x2,y2,x3,y3,x4,y4], in the CSS-pixel viewport
// space Input.dispatchMouseEvent expects.
function quadCenter(quad) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return { x: avg(xs), y: avg(ys) };
}

// A millisecond count a caller gave: absent means the default, and anything that is not a number
// in range is refused rather than quietly rewritten -- 0 and "soon" would both become the default.
function boundedMs(raw, fallback, max, what) {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0 || ms > max) {
    throw new Error(`${what} must be between 0 and ${max} milliseconds.`);
  }
  return ms;
}

function boundedCount(raw, fallback, min, max, what) {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const count = Number(raw);
  if (!Number.isInteger(count) || count < min || count > max) {
    throw new Error(
      `${what} must be a whole number between ${min} and ${max}.`,
    );
  }
  return count;
}

// The point at fractions (u, v) across the quad [x0,y0, x1,y1, x2,y2, x3,y3] -- corners clockwise
// from the top left -- so a sample lands inside a rotated or skewed box too.
function quadPoint(quad, u, v) {
  const topX = quad[0] + (quad[2] - quad[0]) * u;
  const topY = quad[1] + (quad[3] - quad[1]) * u;
  const bottomX = quad[6] + (quad[4] - quad[6]) * u;
  const bottomY = quad[7] + (quad[5] - quad[7]) * u;
  return { x: topX + (bottomX - topX) * v, y: topY + (bottomY - topY) * v };
}

async function resolveActionPoint(tabId, backendNodeId) {
  return quadCenter(await resolveActionQuad(tabId, backendNodeId));
}

// Bringing an element into view moves the page, and the move is not always finished when the
// command that asked for it returns. A box read while the page is still settling describes where
// the element WAS: the point taken from it stays fixed in the viewport while the element slides
// out from under it, and the action then lands on whatever has moved into that spot. Measured on
// the macOS runner, a scroll aimed at the fixture's scroll region was dispatched at a point that
// hit DIV#shadow-host -- a different section of the page, with nothing scrollable under it.
//
// The page's own offsets say when it has stopped. Two consecutive reads that agree is the answer
// in the common case where the scroll was instant, and costs two round trips; a page still moving
// is given a short budget to come to rest and is not waited on beyond it, because an action at a
// slightly stale point is still better than no action at all.
const SCROLL_SETTLE_POLLS = 8;
const SCROLL_SETTLE_STEP_MS = 24;

async function settleScroll(tabId) {
  let previous = null;
  for (let poll = 0; poll < SCROLL_SETTLE_POLLS; poll += 1) {
    const read = await sendCdp(tabId, "Runtime.evaluate", {
      expression:
        "(function(){var v=window.visualViewport;" +
        "return [window.scrollX, window.scrollY, v.offsetLeft, v.offsetTop];})()",
      returnByValue: true,
    }).catch(() => null);
    const now = read && read.result ? read.result.value : null;
    // A page that will not answer where it is cannot be waited for; the caller's own guards
    // (the on-screen check, and the hit test before a scroll) still apply.
    if (!Array.isArray(now)) {
      return;
    }
    if (previous && now.every((value, index) => value === previous[index])) {
      return;
    }
    previous = now;
    await pageDelay(tabId, SCROLL_SETTLE_STEP_MS).catch(() => {});
  }
}

// How long to keep watching for a wheel to take effect when nothing has moved yet and the chain
// under the point still had somewhere to go. Long enough for a heavily zoomed page's animated
// scroll to begin, short enough that a wheel which genuinely missed its scroller does not hold the
// reply for noticeably longer than it already waits.
const SCROLL_START_GRACE_MS = 600;

// Wait for a scroll to start, and then for it to finish; answer with the offsets last read.
//
// settleScroll alone cannot serve here: it waits for the offsets to stop changing, and before a
// scroll has begun they already have -- its first two reads agree and it returns at once, having
// measured nothing. So the start is waited for first, and only then the rest.
async function awaitScrollStart(tabId, x, y, before) {
  const giveUp = Date.now() + SCROLL_START_GRACE_MS;
  let latest = before;
  while (Date.now() < giveUp) {
    await pageDelay(tabId, SCROLL_SETTLE_STEP_MS).catch(() => {});
    latest = await scrollOffsets(tabId, x, y).catch(() => latest);
    if (scrollMovedFn(before, latest)) {
      await settleScroll(tabId);
      return await scrollOffsets(tabId, x, y).catch(() => latest);
    }
  }
  return latest; // the grace expired with nothing moving: the wheel never landed
}

// Scroll the element into view and return its content quad in visual-viewport CSS px.
async function resolveActionQuad(tabId, backendNodeId) {
  if (typeof backendNodeId !== "number") {
    throw new Error(
      "This action needs a valid element ref from the latest snapshot.",
    );
  }
  await sendCdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(
    () => {},
  );
  await settleScroll(tabId);
  let model;
  try {
    model = await sendCdp(tabId, "DOM.getBoxModel", { backendNodeId });
  } catch (error) {
    throw new Error(
      "The element is not laid out (hidden or gone); take a fresh snapshot.",
      { cause: error },
    );
  }
  const quad = model && model.model && model.model.content;
  if (!quad || quad.length < 8) {
    throw new Error("The element has no visible box; take a fresh snapshot.");
  }
  // Scrolling it into view can fail (a scroll container that cannot reach it, a fixed element
  // pushed off screen), and its quad then sits outside what is on screen. Dispatching there
  // reports a click at a point no one can see, so it is refused.
  const view = await viewportState(tabId);
  const centre = quadCenter(quad);
  if (
    !view.ok ||
    centre.x < 0 ||
    centre.y < 0 ||
    centre.x > view.width ||
    centre.y > view.height
  ) {
    throw new Error(
      "The element could not be brought on screen (its centre is at " +
        Math.round(centre.x) +
        ", " +
        Math.round(centre.y) +
        "); scroll it into view first.",
    );
  }
  return quad;
}

// Build the control-presence overlay (frame + badge + prominent pulsing cursor) and position the
// cursor at (x,y). The whole markup is CONSTANT; only x/y are interpolated, coerced to finite
// integers -- nothing page- or model-controlled is ever injected as code. Every element is
// pointer-events:none (cosmetic; never intercepts input or hit-testing) and idempotent (reuses
// an existing node), so it is cheap to call on every action and after a navigation.
// Every element is also aria-hidden: this overlay is the assistant's own furniture, not something
// the site rendered, and an accessibility node for it would reach the model as an element of the
// PAGE -- the badge as an "AI CONTROL" static text it could reason from or act on. aria-hidden
// marks the whole subtree ignored, and an ignored node is what axNodeToCapture drops.
//
// @p look is {rgb: "r,g,b", hex: "#rrggbb", label}: the tab's group colour and the name on its
// badge, so the page can be matched to its group -- and its agent -- at a glance. Every part of it
// comes from presenceLook below: the colour from a fixed table, the label from the agent or client
// name the server already stripped to printable text, and it reaches the page only as a JSON
// string literal assigned to textContent, never as markup or code.
function controlPresenceScript(x, y, look) {
  const { rgb, hex, label } = look || presenceLook(null);
  // The arrow's tip is at (2,1) in the 24-unit viewBox, rendered at 24px: scale exactly 1, so the
  // tip is at (2,1) in page pixels and the offset that puts it on the action point is exact
  // rather than the rounding the old 32px render needed.
  const px = (Number.isFinite(x) ? Math.round(x) : 0) - 2;
  const py = (Number.isFinite(y) ? Math.round(y) : 0) - 1;
  return (
    "(function(){" +
    "function mk(id,tag){var e=document.getElementById(id);if(!e){e=document.createElement(tag);" +
    "e.id=id;(document.body||document.documentElement).appendChild(e);}" +
    "e.setAttribute('aria-hidden','true');e.setAttribute('role','presentation');return e;}" +
    // Keyframes for the cursor halo pulse (injected once).
    "var st=document.getElementById('" +
    CONTROL_STYLE_ID +
    "');" +
    "if(!st){st=document.createElement('style');st.id='" +
    CONTROL_STYLE_ID +
    "';" +
    "st.textContent='@keyframes chromeControlMcpPulse{0%{transform:scale(.6);opacity:.85}" +
    "70%{transform:scale(1.6);opacity:0}100%{transform:scale(1.6);opacity:0}}';" +
    "(document.head||document.documentElement).appendChild(st);}" +
    // Viewport frame: thin neon border, hollow + pointer-events:none so it never covers content
    // or intercepts a hit-test.
    "var f=mk('" +
    CONTROL_FRAME_ID +
    "','div');" +
    "f.style.cssText='position:fixed;inset:0;z-index:2147483644;pointer-events:none;" +
    `border:3px solid rgba(${rgb},.9);box-shadow:inset 0 0 14px rgba(${rgb},.45);` +
    "border-radius:3px';" +
    // Badge pill, top-right.
    "var b=mk('" +
    CONTROL_BADGE_ID +
    "','div');" +
    "b.style.cssText='position:fixed;top:10px;right:12px;z-index:2147483646;pointer-events:none;" +
    "font:600 11px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#fff;" +
    `background:#12001a;border:1px solid ${hex};border-radius:11px;padding:2px 9px;` +
    `letter-spacing:.07em;box-shadow:0 0 8px rgba(${rgb},.8)';` +
    "b.textContent=" +
    JSON.stringify(label) +
    ";" +
    // Cursor container with a pulsing halo behind a bold neon pointer.
    "var c=mk('" +
    AGENT_CURSOR_ID +
    "','div');" +
    "c.style.cssText='position:fixed;left:0;top:0;z-index:2147483647;width:24px;height:24px;" +
    "pointer-events:none;will-change:transform;" +
    "transition:transform .12s cubic-bezier(.22,1,.36,1);" +
    `filter:drop-shadow(0 0 2px ${hex}) drop-shadow(0 0 5px rgba(${rgb},.95)) ` +
    `drop-shadow(0 0 10px rgba(${rgb},.65))';` +
    // Built node by node, never through innerHTML. A page that enforces Trusted Types -- YouTube,
    // Gmail, Google Docs, Chrome's own error pages -- refuses an innerHTML assignment, which threw
    // here: the cursor was never drawn, and the page's console carried an exception this extension
    // caused, which browser_console then reported to the agent as the page's own.
    "var NS='http://www.w3.org/2000/svg';" +
    "var h=c.firstChild;if(!h||h.nodeName!=='DIV'){" +
    "while(c.firstChild){c.removeChild(c.firstChild);}" +
    "h=document.createElement('div');c.appendChild(h);" +
    "var s=document.createElementNS(NS,'svg');" +
    "[['width','24'],['height','24'],['viewBox','0 0 24 24']].forEach(function(a){s.setAttribute(a[0],a[1]);});" +
    "s.style.position='relative';" +
    "var p=document.createElementNS(NS,'path');" +
    "[['d','M2 1 L2 19 L7 14 L10.5 21 L13.6 19.6 L10.1 13 L17 13 Z'],['fill','#ffffff']," +
    "['stroke','#12001a'],['stroke-width','1.3'],['stroke-linejoin','round']]" +
    ".forEach(function(a){p.setAttribute(a[0],a[1]);});" +
    "s.appendChild(p);c.appendChild(s);}" +
    // The halo is re-coloured on every draw, so a tab moved to another agent's group follows it.
    "h.style.cssText='position:absolute;left:-7px;top:-7px;width:26px;height:26px;" +
    `border-radius:50%;background:radial-gradient(circle,rgba(${rgb},.55),rgba(${rgb},0) 70%);` +
    "animation:chromeControlMcpPulse 1.6s ease-out infinite';" +
    // The point is in the visual viewport's coordinates and position:fixed in the layout
    // viewport's; they differ by the pinch's offset.
    "var v=window.visualViewport;" +
    "c.style.transform='translate('+(" +
    px +
    "+v.offsetLeft)+'px,'+(" +
    py +
    "+v.offsetTop)+'px)';})();"
  );
}

// How a held tab's frame and badge look: its group's colour and its agent's (or client's) name.
function presenceLook(tabId) {
  const held = tabId === null ? null : holderOf(tabId);
  const hex = tabId === null ? GROUP_COLOR_HEX.pink : presenceColorFor(tabId);
  let label = CONTROL_GROUP_TITLE;
  if (held && held.tab.agent) {
    label = CONTROL_GROUP_PREFIX + held.tab.agent;
  } else if (held && held.session.label) {
    label = CONTROL_GROUP_PREFIX + held.session.label;
  }
  const rgb = [1, 3, 5]
    .map((at) => parseInt(hex.slice(at, at + 2), 16))
    .join(",");
  return { rgb, hex, label };
}

// Where a held tab's cursor is, so a redraw puts it back where it was.
function cursorOf(tabId) {
  const held = holderOf(tabId);
  return held ? held.tab.cursor : PARKED_CURSOR;
}

// The presence, drawn into a document as the browser creates it: at once when there is already
// something to draw into, otherwise as soon as the document has a body. Registered per attachment
// (enableSessionDomains), so every page the tab loads while controlled shows it from the start.
function presenceOnNewDocumentScript(tabId) {
  const cursor = cursorOf(tabId);
  return (
    "(function(){var draw=function(){" +
    controlPresenceScript(cursor.x, cursor.y, presenceLook(tabId)) +
    "};if(document.readyState==='loading'){" +
    "document.addEventListener('DOMContentLoaded',draw,{once:true});}else{draw();}})();"
  );
}

// Move a cursor that is ALREADY there, and say so if it is not.
//
// controlPresenceScript rebuilds the whole overlay: three getElementById lookups, a stylesheet
// check, two cssText assignments and an innerHTML that reparses an SVG. That is the right thing
// once. A drag calls this on every step -- up to 60 of them -- and each one shipped ~2 KB of
// script to be parsed and re-executed against the page for the sake of two numbers. On a loaded
// runner a drag has come within the bridge's 30 s reply budget and failed the whole suite with
// "browser did not reply"; this is the per-step cost that was in it.
//
// Only x and y are interpolated, and both are coerced to finite integers, exactly as the full
// script does -- nothing page- or model-controlled is ever injected as code.
function cursorNudgeScript(x, y) {
  // The same tip offset the full build uses; the two MUST agree or the cursor jumps by a couple
  // of pixels depending on which path drew it.
  const px = (Number.isFinite(x) ? Math.round(x) : 0) - 2;
  const py = (Number.isFinite(y) ? Math.round(y) : 0) - 1;
  return (
    "(function(){var c=document.getElementById('" +
    AGENT_CURSOR_ID +
    "');if(!c){return false;}var v=window.visualViewport;" +
    "c.style.transform='translate('+(" +
    px +
    "+v.offsetLeft)+'px,'+(" +
    py +
    "+v.offsetTop)+'px)';return true;})()"
  );
}

// Toggle the presence overlay's visibility without removing it (used to hide it for the duration
// of a screenshot capture so it never appears in the image / over page media).
function presenceVisibilityScript(visible) {
  const disp = visible ? "" : "none";
  return (
    "(function(){['" +
    CONTROL_FRAME_ID +
    "','" +
    CONTROL_BADGE_ID +
    "','" +
    AGENT_CURSOR_ID +
    "'].forEach(function(id){var e=document.getElementById(id);if(e){e.style.display='" +
    disp +
    "';}});})();"
  );
}

async function moveAgentCursor(tabId, x, y) {
  const held = holderOf(tabId);
  if (held) {
    held.tab.cursor = { x, y };
  }
  // The overlay is usually already on this document, so try the cheap move first and build it
  // only when the nudge reports there is nothing to move (a fresh document, or a page that wiped
  // it). Cosmetic either way: a cursor that cannot be drawn must never fail the action it is
  // decorating, which is why both paths swallow their errors.
  const nudged = await sendCdp(tabId, "Runtime.evaluate", {
    expression: cursorNudgeScript(x, y),
    returnByValue: true,
  }).catch(() => null);
  if (nudged && nudged.result && nudged.result.value === true) {
    return;
  }
  await sendCdp(tabId, "Runtime.evaluate", {
    expression: controlPresenceScript(x, y, presenceLook(tabId)),
  }).catch(() => {});
}

// Ensure the control presence (frame + badge + parked cursor) is on the page and mark the tab in
// the toolbar with an "AI" badge. Called on attach, on every command, and when a page finishes
// loading; idempotent and cheap.
async function refreshControlPresence(tabId) {
  const cursor = cursorOf(tabId);
  await sendCdp(tabId, "Runtime.evaluate", {
    expression: controlPresenceScript(cursor.x, cursor.y, presenceLook(tabId)),
  }).catch(() => {});
  setTabControlBadge(tabId, true);
}

// The script that takes the presence off a page, whichever way it gets there.
const REMOVE_PRESENCE_SCRIPT =
  "(function(){['" +
  PRESENCE_IDS.join("','") +
  "'].forEach(function(id){var e=document.getElementById(id);if(e){e.remove();}});})();";

// Remove the on-page overlay and clear the toolbar badge when control of the tab ends.
async function removeControlPresence(tabId) {
  await sendCdp(tabId, "Runtime.evaluate", {
    expression: REMOVE_PRESENCE_SCRIPT,
  }).catch(() => {});
  setTabControlBadge(tabId, false);
}

// The same for a tab the debugger is already off -- the user cancelled Chrome's debugging bar, or
// opened DevTools -- where the frame would otherwise stay drawn on a page nothing controls any
// more, until it reloaded. Needs the scripting permission; without it, the badge still clears.
async function removeControlPresenceWithoutDebugger(tabId) {
  setTabControlBadge(tabId, false);
  try {
    if (
      chrome.scripting &&
      typeof chrome.scripting.executeScript === "function"
    ) {
      await Promise.resolve(
        chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          func: (ids) => {
            for (const id of ids) {
              const node = document.getElementById(id);
              if (node) {
                node.remove();
              }
            }
          },
          args: [PRESENCE_IDS],
        }),
      ).catch(() => {});
    }
  } catch (_e) {
    // A page scripts may not run on (chrome://, the Web Store) had no frame drawn on it either.
  }
}

async function setPresenceVisible(tabId, visible) {
  const res = await sendCdp(tabId, "Runtime.evaluate", {
    expression: presenceVisibilityScript(visible),
  }).catch(() => null);
  return Boolean(res && !res.exceptionDetails);
}

// Wrap a page-content read so the presence overlay is not part of the answer. innerText is
// RENDERED text and outerHTML is the live tree, so an overlay left in place makes the badge's
// literal "AI CONTROL" and the frame/cursor markup part of what the model is told the PAGE
// contains -- and browser_wait_for {text:"AI CONTROL"} is then satisfied by our own furniture on
// any attached tab. The nodes are detached and restored INSIDE one evaluate: the whole sequence is
// a single task, so no frame is ever painted without the presence and control is never visually
// unmarked -- and the restore rides in a finally, so a read that throws still puts it back.
// `readExpr` is a constant from this file; nothing page- or model-controlled is interpolated here.
// The restore runs BACKWARDS: the overlay nodes are siblings, so the node one of them was recorded
// in front of is usually the next overlay node, which is still detached while the list is walked
// forwards -- and insertBefore throws when its reference is not a child of the parent. Reverse
// order puts each node back only after the sibling it names is already home, and a reference that
// moved anyway is dropped so the node lands under its own parent instead of failing the read (it
// is position:fixed furniture; where it sits among its siblings is not a fact about the page).
function presenceFreeReadScript(readExpr) {
  return (
    "(function(){var slots=[];['" +
    PRESENCE_IDS.join("','") +
    "'].forEach(function(id){" +
    "var e=document.getElementById(id);" +
    "if(e&&e.parentNode){slots.push([e,e.parentNode,e.nextSibling]);e.parentNode.removeChild(e);}" +
    "});try{return " +
    readExpr +
    ";}" +
    "finally{for(var i=slots.length-1;i>=0;i--){var s=slots[i];" +
    "s[1].insertBefore(s[0],s[2]&&s[2].parentNode===s[1]?s[2]:null);}}})()"
  );
}

// Per-tab toolbar badge: only the controlled tab shows the pink "AI" chip, so the user can tell
// which tab (and page) the assistant is driving from the tab strip / toolbar.
function setTabControlBadge(tabId, on) {
  // Called with no callback, the MV3 chrome.action methods return PROMISES. A synchronous catch
  // never sees their rejection -- and "No tab with id N" is the routine one, since control ends
  // precisely when a tab is closing -- so without settling each promise the intended silent no-op
  // becomes an unhandled rejection in the worker.
  const ignore = () => {};
  const settle = (p) => {
    Promise.resolve(p).catch(ignore);
  };
  try {
    if (on) {
      settle(chrome.action.setBadgeText({ tabId, text: "AI" }));
      settle(
        chrome.action.setBadgeBackgroundColor({
          tabId,
          color: presenceColorFor(tabId), // the tab's group colour, as on the page
        }),
      );
      settle(
        chrome.action.setTitle({
          tabId,
          title: "Chrome Control MCP assistant is controlling this tab",
        }),
      );
    } else {
      settle(chrome.action.setBadgeText({ tabId, text: "" }));
      settle(chrome.action.setTitle({ tabId, title: "" }));
    }
  } catch (_e) {
    // chrome.action is unavailable in some contexts; the on-page overlay still signals control.
  }
}

async function dispatchMouse(tabId, type, x, y, extra) {
  await sendCdp(
    tabId,
    "Input.dispatchMouseEvent",
    Object.assign({ type, x, y }, extra || {}),
  );
}

const MOUSE_BUTTONS = { left: 1, right: 2, middle: 4 };

// Parse "Control+Shift" -> the CDP modifier bitmask (reuses MODIFIER_BITS).
// A modifier the map does not know is REFUSED, not dropped. Silently ignoring it would send a
// plain click while reporting the modified one the model asked for -- and "ctrl+click" versus
// "click" is the difference between opening a background tab and navigating the page away.
function parseModifiers(spec) {
  if (!spec) {
    return 0;
  }
  let mods = 0;
  for (const part of String(spec).split("+")) {
    const name = part.trim().toLowerCase();
    if (name === "") {
      continue;
    }
    const bit = MODIFIER_BITS[name];
    if (!bit) {
      throw new Error(
        "Unknown modifier '" +
          name +
          "'; use one or more of: " +
          Object.keys(MODIFIER_BITS).join(", ") +
          ".",
      );
    }
    mods |= bit;
  }
  return mods;
}

// A pointer button the model did not name is REFUSED rather than coerced to left: a right-click
// silently downgraded to a left-click opens no context menu and reports success for an action
// that never happened.
function mouseButton(spec) {
  if (spec === undefined || spec === null || spec === "") {
    return "left";
  }
  const name = String(spec).toLowerCase();
  if (name !== "left" && name !== "right" && name !== "middle") {
    throw new Error(
      "Unknown button '" + spec + "'; use left, right, or middle.",
    );
  }
  return name;
}

// Likewise for the click count: 4 is not a triple-click and must not be reported as one.
function clickCountOf(spec) {
  if (spec === undefined || spec === null || spec === "") {
    return 1;
  }
  const n = Number(spec);
  if (n !== 1 && n !== 2 && n !== 3) {
    throw new Error("click_count must be 1, 2, or 3.");
  }
  return n;
}

// A click at a CSS-pixel viewport point with button/count/modifiers. For clickCount > 1 the
// press/release pair repeats with an incrementing clickCount, which is how Chrome derives
// dblclick (2) and tripleclick (3). The agent cursor is moved there first.
async function clickAt(tabId, x, y, opts) {
  opts = opts || {};
  // Through the same refusing helpers its callers use, rather than a third private copy of the
  // rule that quietly answered an unnamed button with a left click.
  const button = mouseButton(opts.button);
  const mask = MOUSE_BUTTONS[button] || 1;
  const clickCount = clickCountOf(opts.clickCount);
  const modifiers = opts.modifiers || 0;
  await moveAgentCursor(tabId, x, y);
  await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
  for (let c = 1; c <= clickCount; c++) {
    await dispatchMouse(tabId, "mousePressed", x, y, {
      button,
      buttons: mask,
      clickCount: c,
      modifiers,
    });
    await dispatchMouse(tabId, "mouseReleased", x, y, {
      button,
      buttons: 0,
      clickCount: c,
      modifiers,
    });
  }
}

// Hit-test the point a ref click will land on: is the topmost element there the target (or a
// descendant of it), or is something else painted over it? Returns {occluded, by, unknown}.
// This is a GATE, not a warning: handleClick refuses on occluded, because DOM.getNodeForLocation
// honours pointer-events, so a node it names over the target is a node the user's own click
// would hit instead. A hit-test that could not be taken returns occluded with unknown:true --
// it proves nothing, and "not occluded" would assert exactly what was never established.
// DOM.getNodeForLocation consumes ROOT-DOCUMENT coordinates (Chromium's InspectorDOMAgent builds
// a document_point from x/y), while DOM.getBoxModel and Input.dispatchMouseEvent use the VISUAL
// viewport's coordinates: the part of the page on screen, which a pinch moves inside the layout
// viewport. Convert through the visual viewport's offset in the layout viewport and the layout
// viewport's scroll, or every click after a scroll or a pinch hit-tests a different element
// above/left of the target and is falsely refused as occluded.
function documentHitPoint(x, y, state) {
  if (
    !state ||
    state.ok !== true ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(state.scrollX) ||
    !Number.isFinite(state.scrollY) ||
    !Number.isFinite(state.offsetX) ||
    !Number.isFinite(state.offsetY)
  ) {
    return null;
  }
  return {
    x: Math.round(x + state.offsetX + state.scrollX),
    y: Math.round(y + state.offsetY + state.scrollY),
  };
}

async function occlusionAt(tabId, x, y, targetBackendId) {
  try {
    const point = documentHitPoint(x, y, await viewportState(tabId));
    if (!point) {
      return {
        occluded: true,
        unknown: true,
        by: { tag: "", backendNodeId: null },
      };
    }
    const hit = await sendCdp(tabId, "DOM.getNodeForLocation", {
      x: point.x,
      y: point.y,
      includeUserAgentShadowDOM: false,
    });
    const hitBackend = hit && hit.backendNodeId;
    if (typeof hitBackend !== "number") {
      // The reply named no node: nothing was established, and "not occluded" would assert exactly
      // what the hit test failed to show.
      return {
        occluded: true,
        unknown: true,
        by: { tag: "", backendNodeId: null },
      };
    }
    if (hitBackend === targetBackendId) {
      return { occluded: false };
    }
    // The hit node may be a descendant of the target (e.g. clicking a button lands on its inner
    // <span>); that is not occlusion. Ask the target whether it contains the hit node.
    const targetObj = await resolveNodeObjectId(tabId, targetBackendId).catch(
      () => null,
    );
    const hitResolved = await sendCdp(tabId, "DOM.resolveNode", {
      backendNodeId: hitBackend,
      objectGroup: CDP_OBJECT_GROUP,
    }).catch(() => null);
    const hitObj =
      hitResolved && hitResolved.object && hitResolved.object.objectId;
    if (targetObj && hitObj) {
      const call = await sendCdp(tabId, "Runtime.callFunctionOn", {
        objectId: targetObj,
        functionDeclaration:
          "function(other){return this===other||this.contains(other);}",
        arguments: [{ objectId: hitObj }],
        returnByValue: true,
      });
      if (call && call.result && call.result.value === true) {
        return { occluded: false };
      }
    }
    const d = await sendCdp(tabId, "DOM.describeNode", {
      backendNodeId: hitBackend,
    }).catch(() => null);
    const node = d && d.node;
    const tag = node ? String(node.nodeName || "").toLowerCase() : "";
    // The document's own root on top of a point inside the element: nothing in the page is drawn
    // there over it, so either the page's scrollbar is (an overlay scrollbar shows over content
    // while the page scrolls, and a pinch-zoomed page's scrollbars sit over its edges) or the
    // element takes no pointer events there.
    let root = false;
    if (hitObj) {
      const isRoot = await sendCdp(tabId, "Runtime.callFunctionOn", {
        objectId: hitObj,
        functionDeclaration:
          "function(){return this===document.documentElement||this===document.scrollingElement;}",
        returnByValue: true,
      }).catch(() => null);
      root = Boolean(isRoot && isRoot.result && isRoot.result.value === true);
    }
    return { occluded: true, by: { tag, backendNodeId: hitBackend, root } };
  } catch (_e) {
    // The hit-test is the only evidence that the click will land on the intended element.
    // Reporting "not occluded" because the test itself failed asserts exactly what could not
    // be established, so an unusable hit-test blocks the click instead of waving it through.
    return {
      occluded: true,
      unknown: true,
      by: { tag: "", backendNodeId: null },
    };
  }
}

// Where in its box a ref click aims: the centre first, then points around it. Something drawn
// over the centre -- a macOS overlay scrollbar, which appears over the page's right edge whenever
// the page scrolls (the element's own scroll into view included), a sticky header over its top
// -- covers only part of the element, and a user clicks the part they can see.
const CLICK_SAMPLES = [
  [0.5, 0.5],
  [0.25, 0.5],
  [0.5, 0.25],
  [0.5, 0.75],
  [0.75, 0.5],
  [0.25, 0.25],
  [0.25, 0.75],
  [0.75, 0.25],
  [0.75, 0.75],
];

// A macOS overlay scrollbar shows over the page's edge while the page scrolls -- the element's own
// scroll into view included -- and fades about 0.75 s after it stops (measured). An element that
// only the scrollbar covers is given that long to come clear, re-tested every poll.
const SCROLLBAR_FADE_MS = 1000;
const SCROLLBAR_POLL_MS = 100;

// The first sample point of the element's box where the element itself (or a descendant) is the
// topmost thing, or -- when none is -- the centre's occlusion, which says what covers it.
async function reachablePoint(tabId, backendNodeId) {
  const deadline = Date.now() + SCROLLBAR_FADE_MS;
  let first = true;
  for (;;) {
    // Resolved again each pass: the overlay scrollbar this waits out is over the page's edge
    // because the page is MOVING, and a box measured before it settled names a point the element
    // has since left.
    const quad = await resolveActionQuad(tabId, backendNodeId);
    // The whole box the first time; after that the centre alone, which is what clearing costs a
    // round trip to prove -- nine samples a pass would spend a background tab's whole budget.
    const samples = first ? CLICK_SAMPLES : [CLICK_SAMPLES[0]];
    first = false;
    let centre = null;
    let onlyRoot = true;
    for (const [u, v] of samples) {
      const point = quadPoint(quad, u, v);
      const occ = await occlusionAt(tabId, point.x, point.y, backendNodeId);
      if (!occ.occluded) {
        return { point };
      }
      centre = centre || occ;
      onlyRoot = onlyRoot && Boolean(occ.by && occ.by.root);
      if (occ.unknown) {
        return { occlusion: occ }; // no hit test could be taken: no other point is proven either
      }
    }
    if (!onlyRoot || Date.now() >= deadline) {
      return { occlusion: centre, onlyRoot };
    }
    await pageDelay(tabId, SCROLLBAR_POLL_MS);
  }
}

async function handleClick(session, tabId, args) {
  await ensureAttached(session, tabId);
  requireSnapshotTab(session, tabId);
  const button = mouseButton(args.button);
  const clickCount = clickCountOf(args.click_count);
  const modifiers = parseModifiers(args.modifiers);
  const {
    point,
    occlusion: occ,
    onlyRoot,
  } = await reachablePoint(tabId, args.backendNodeId);
  if (occ) {
    // DOM.getNodeForLocation honours pointer-events, so a node it returns over the target is a
    // node a real user click would hit instead. Dispatching anyway would drive a cookie banner
    // or modal the model cannot see and report ok:true for an action on the wrong element.
    if (occ.unknown) {
      throw new Error(
        "Could not verify what is at the element's click point; re-snapshot and try again.",
      );
    }
    if (onlyRoot) {
      throw new Error(
        "No point of the element takes a click: the page's scrollbar is over it, or the element " +
          "does not take pointer events. Scroll it away from the page's edge, or use " +
          "browser_js_click.",
      );
    }
    throw new Error(
      "The element is covered by <" +
        (occ.by && occ.by.tag ? occ.by.tag : "another element") +
        ">; dismiss the overlay or use browser_js_click.",
    );
  }
  await clickAt(tabId, point.x, point.y, { button, clickCount, modifiers });
  return {
    ok: true,
    x: Math.round(point.x),
    y: Math.round(point.y),
    button,
    click_count: clickCount,
  };
}

// Move-only pointer over a target so :hover/mouseenter UI (menus, tooltips) reveals; the model
// then re-snapshots to read what appeared. Optional dwell lets hover-intent JS settle.
async function handleHover(session, tabId, args) {
  await ensureAttached(session, tabId);
  // Not every hoverable thing gets a ref. An <a> with no href, or a <div> with only an
  // onmouseenter handler, has no accessibility role that says "interactable", so the snapshot
  // shows it without one. browser_click_at already answers that for clicks by taking a pixel of
  // the last screenshot; hover had no such path, which left those elements reachable by click
  // and not by hover. The coordinate is converted exactly as browser_click_at converts it, and
  // is refused unless the screenshot it came from still matches the live render.
  const byPoint =
    args.x !== undefined &&
    args.x !== null &&
    args.y !== undefined &&
    args.y !== null;
  if (byPoint && typeof args.backendNodeId === "number") {
    throw new Error("browser_hover takes EITHER a ref or x/y, not both.");
  }
  let point;
  if (byPoint) {
    point = await screenshotPoint(
      session,
      tabId,
      Number(args.x),
      Number(args.y),
      "browser_hover",
    );
  } else {
    requireSnapshotTab(session, tabId);
    point = await resolveActionPoint(tabId, args.backendNodeId);
  }
  await moveAgentCursor(tabId, point.x, point.y);
  await dispatchMouse(tabId, "mouseMoved", point.x, point.y, {
    modifiers: parseModifiers(args.modifiers),
  });
  const dwell = boundedMs(
    args.duration_ms,
    0,
    5000,
    "browser_hover duration_ms",
  );
  if (dwell > 0) {
    await pageDelay(tabId, dwell);
  }
  return { ok: true, x: Math.round(point.x), y: Math.round(point.y) };
}

// Drag from a source (ref or x,y) to a target (ref or x,y) with interpolated moves so drag
// thresholds trigger. hold_ms pauses after press (long-press pickup for sortables/kanban).
async function handleDrag(session, tabId, args) {
  await ensureAttached(session, tabId);
  // Both endpoints take a ref, and this was the one ref-taking handler that never checked the
  // snapshot. Either ref alone is enough to land the drag on a tab or a document the model
  // never saw, so the gate is keyed on either being present -- matching the bridge, which
  // refuses a stale-snapshot command carrying ref OR to_ref.
  if (
    typeof args.backendNodeId === "number" ||
    typeof args.to_backendNodeId === "number"
  ) {
    requireSnapshotTab(session, tabId);
  }
  // A point given as x/y is a pixel of the most recent screenshot -- the only place a model reads
  // raw coordinates from -- converted exactly as browser_click_at converts it. Taken as CSS
  // pixels, it lands at the pixel's position times the display scale, zoom, and pinch: off
  // target everywhere but an unzoomed 100% display.
  const fromRef = typeof args.backendNodeId === "number";
  const toRef = typeof args.to_backendNodeId === "number";
  const pixel = (x, y) => [x, y].every((v) => v !== undefined && v !== null);
  if (
    (!fromRef && !pixel(args.from_x, args.from_y)) ||
    (!toRef && !pixel(args.to_x, args.to_y))
  ) {
    throw new Error(
      "browser_drag needs a from (ref or from_x/from_y) and a to (to_ref or to_x/to_y).",
    );
  }
  // An endpoint named twice is a contradiction: honouring the ref and dropping the coordinates
  // would perform a drag from somewhere the caller also named, without saying which it used.
  if (
    (fromRef && pixel(args.from_x, args.from_y)) ||
    (toRef && pixel(args.to_x, args.to_y))
  ) {
    throw new Error(
      "browser_drag takes each end EITHER as a ref or as x/y, not both.",
    );
  }
  const fromPixel = fromRef
    ? null
    : await screenshotPoint(
        session,
        tabId,
        Number(args.from_x),
        Number(args.from_y),
        "browser_drag",
      );
  const toPixel = toRef
    ? null
    : await screenshotPoint(
        session,
        tabId,
        Number(args.to_x),
        Number(args.to_y),
        "browser_drag",
      );
  const from =
    fromPixel || (await resolveActionPoint(tabId, args.backendNodeId));
  const to =
    toPixel || (await resolveActionPoint(tabId, args.to_backendNodeId));
  // Resolving a ref scrolls its element into view, and a scroll moves the page under a pixel
  // read before it. A drag that mixes the two is proven only if the render held still.
  if ((fromPixel || toPixel) && (fromRef || toRef)) {
    await currentShot(session, tabId, "browser_drag");
  }
  const steps = boundedCount(args.steps, 12, 2, 60, "browser_drag steps");
  const hold = boundedMs(args.hold_ms, 0, 5000, "browser_drag hold_ms");
  await moveAgentCursor(tabId, from.x, from.y);
  await dispatchMouse(tabId, "mouseMoved", from.x, from.y, {});
  await dispatchMouse(tabId, "mousePressed", from.x, from.y, {
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  // The button is DOWN from here. Anything that throws mid-drag would otherwise leave the page
  // holding a pressed button forever -- every later hover reads as a drag and the next click
  // completes a drag the model never asked for -- so the release always runs.
  // Release where the pointer actually got to, not at the intended destination: a drag that
  // failed halfway must not drop its payload on the target as though it had arrived.
  let atX = from.x;
  let atY = from.y;
  try {
    if (hold > 0) {
      await pageDelay(tabId, hold);
    }
    // Sent in order, awaited together. A mouse move is a CONTINUOUS event: Chrome coalesces it
    // and answers at a frame, and a tab the user is not looking at is drawn rarely -- awaiting
    // each move in turn cost 8.9 s for one drag there, against 0.23 s in a foreground tab. The
    // debugger delivers commands in the order they are sent, so the page still sees the path in
    // order, coalesced exactly as it coalesces a real mouse.
    const moves = [];
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      const sent = [
        moveAgentCursor(tabId, x, y),
        dispatchMouse(tabId, "mouseMoved", x, y, {
          button: "left",
          buttons: 1,
        }),
      ];
      // Every one of these is in flight before any of them is awaited. A promise that rejects
      // while the loop below is still waiting on an earlier step has no handler attached yet, and
      // V8 reports that as an unhandledrejection at the next microtask checkpoint -- in a service
      // worker, one the runtime may tear down over. The drag would then stop answering and the
      // bridge would report it as "browser did not reply", naming the transport for a fault that
      // was here. Attaching a no-op catch marks each one handled NOW; the originals are still
      // awaited in order below, so a real failure still stops the drag where it stopped.
      for (const pending of sent) {
        pending.catch(() => {});
      }
      moves.push({ x, y, sent });
    }
    // Awaited in the order they were sent, so atX/atY name the last step that actually landed: a
    // drag that failed halfway then releases where the pointer got to, not at the destination.
    for (const move of moves) {
      await Promise.all(move.sent);
      atX = move.x;
      atY = move.y;
    }
  } finally {
    await dispatchMouse(tabId, "mouseReleased", atX, atY, {
      button: "left",
      buttons: 0,
      clickCount: 1,
    }).catch(() => {});
  }
  return {
    ok: true,
    from: { x: Math.round(from.x), y: Math.round(from.y) },
    to: { x: Math.round(to.x), y: Math.round(to.y) },
  };
}

// The viewport point under pixel (sx, sy) of the most recent viewport screenshot, in the CSS
// pixels Input.dispatchMouseEvent and DOM.getBoxModel share. The screenshot is the VISUAL
// viewport -- the part of the page on screen, which a pinch magnifies -- in device pixels, so one
// CSS pixel spans dpr x pinch-scale image pixels and the image's origin is the visual viewport's.
// The transform is the one captured WITH the screenshot (not a re-read), so the two can never
// disagree. Fails CLOSED if the render moved since: a zoom or pinch would mis-scale the
// conversion, a scroll would make the pixel point elsewhere, a navigation (or a same-URL reload,
// which only the DOM generation shows) would put it on a different document, and a viewport
// resize would relay the page out under it. A pixel names a point only in the image it was read
// from.
async function screenshotPoint(session, tabId, sx, sy, tool) {
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx < 0 || sy < 0) {
    throw new Error(tool + " needs non-negative x and y in screenshot pixels.");
  }
  const shot = await currentShot(session, tabId, tool);
  const perCssPixel = shot.dpr * shot.scale;
  // Inside the image it was read from. A pixel past its edge is off the page on screen, and
  // dispatching there would report a click at coordinates nothing was ever drawn at.
  const width = shot.width * shot.dpr;
  const height = shot.height * shot.dpr;
  if (sx > width || sy > height) {
    throw new Error(
      tool +
        " was given (" +
        Math.round(sx) +
        ", " +
        Math.round(sy) +
        "), outside the " +
        Math.round(width) +
        "x" +
        Math.round(height) +
        " screenshot it must be read from.",
    );
  }
  return { x: sx / perCssPixel, y: sy / perCssPixel };
}

// The most recent screenshot, if it is a viewport screenshot of this tab and the page still shows
// what it captured; otherwise the refusal that says which.
async function currentShot(session, tabId, tool) {
  const tab = tabStateOf(session, tabId);
  const shot = tab.lastShot;
  if (!shot || shot.tabId !== tabId) {
    throw new Error(
      "No current screenshot for the active tab; call browser_screenshot before " +
        tool +
        " so the coordinates match what you see.",
    );
  }
  if (shot.fullPage) {
    throw new Error(
      "The last screenshot was full-page (document coordinates); take a viewport " +
        "screenshot (full_page:false) before " +
        tool +
        " so x/y map to the visible page.",
    );
  }
  const now = await viewportState(tabId);
  if (!shotMatchesRender(tab, shot, now)) {
    tab.lastShot = null;
    throw new Error(
      "The page moved (scrolled, zoomed, pinched, resized, reloaded, or navigated) since the " +
        "screenshot; take a fresh browser_screenshot before " +
        tool +
        ".",
    );
  }
  return shot;
}

async function handleClickAt(session, tabId, args) {
  await ensureAttached(session, tabId);
  const sx = Number(args.x);
  const sy = Number(args.y);
  const point = await screenshotPoint(
    session,
    tabId,
    sx,
    sy,
    "browser_click_at",
  );
  const button = mouseButton(args.button);
  const clickCount = clickCountOf(args.click_count);
  await clickAt(tabId, point.x, point.y, {
    button,
    clickCount,
    modifiers: parseModifiers(args.modifiers),
  });
  return {
    ok: true,
    x: Math.round(sx),
    y: Math.round(sy),
    button,
    click_count: clickCount,
  };
}

// Is the ref'd node (or something inside it) what the page has focused RIGHT NOW? Asked on the
// ref-resolved node through a CONSTANT function body, so no page content is ever evaluated.
async function nodeHasFocus(tabId, backendNodeId) {
  const objectId = await resolveNodeObjectId(tabId, backendNodeId);
  const focusFn = function () {
    // Walk the focus chain from the outermost activeElement inward, testing at EVERY level.
    // Descending first and testing only the innermost gets delegatesFocus exactly backwards:
    // for <my-input> with attachShadow({delegatesFocus:true}), DOM.focus on the host succeeds
    // and document.activeElement IS the host, but the real focus sits on an input inside the
    // shadow root -- and Node.contains does NOT cross a shadow boundary, so host.contains(inner)
    // is false and the node we just focused would read as "focus moved away". Testing each
    // level also covers the mirror case, where the ref names a node inside the shadow root.
    let node = document.activeElement;
    while (node) {
      if (node === this || this.contains(node)) {
        return true;
      }
      if (node.shadowRoot && node.shadowRoot.activeElement) {
        node = node.shadowRoot.activeElement;
        continue;
      }
      return false;
    }
    return false;
  };
  return (await callOnNode(tabId, objectId, focusFn, [])) === true;
}

async function handleType(session, tabId, args) {
  await ensureAttached(session, tabId);
  requireSnapshotTab(session, tabId);
  const text = typeof args.text === "string" ? args.text : "";
  // A validated ref is required: typing into the page-focused element would let page
  // content (element.focus()/autofocus) redirect the model's text into a field the
  // bridge never chose. Focus the snapshot-resolved node, and abort (never silently type
  // into the wrong place) if that node cannot be focused.
  if (typeof args.backendNodeId !== "number") {
    throw new Error(
      "This action needs a valid element ref from the latest snapshot.",
    );
  }
  const point = await resolveActionPoint(tabId, args.backendNodeId);
  await moveAgentCursor(tabId, point.x, point.y);
  try {
    await sendCdp(tabId, "DOM.focus", { backendNodeId: args.backendNodeId });
  } catch (error) {
    throw new Error(
      "Could not focus the target element (it may not be focusable); take a " +
        "fresh snapshot and target an input.",
      { cause: error },
    );
  }
  // Input.insertText lands wherever focus IS, and the focus/focusin handler the DOM.focus above
  // just ran can move it (a page can call another field's focus() synchronously). The ref only
  // pins the target if the focus it asked for actually stuck, so it is re-read on the node
  // itself before a single character is inserted.
  if (!(await nodeHasFocus(tabId, args.backendNodeId))) {
    throw new Error(
      "The page moved focus off the target element; take a fresh snapshot and " +
        "type into the element that is focused.",
    );
  }
  await sendCdp(tabId, "Input.insertText", { text });
  if (args.submit === true) {
    await dispatchKey(tabId, KEY_DEFS.enter, 0);
  }
  return { ok: true, typed: text.length, submitted: args.submit === true };
}

// One CONSTANT function body covers single (value/label/index) and multi (values) selection;
// all match criteria arrive as CDP argument VALUES, never interpolated into code. It runs in the
// PAGE, serialized by source, so it closes over nothing here -- everything it needs is a
// parameter. Kept at module scope for that reason: nesting it would imply a closure it cannot have.
const selectOptionFn = function (mode, value, label, index, values) {
  // Option text as a human reads it. A page that writes &nbsp; between words -- which plenty do
  // for alignment -- puts U+00A0 in option.text, while the snapshot the caller copied the label
  // out of shows an ordinary space. Comparing those with === means "Los Angeles" never matches
  // the option literally called "Los Angeles". Collapse whitespace on BOTH sides, so a label
  // read off the snapshot selects the option it names.
  const sameLabel = (a, b) => {
    if (typeof a !== "string" || typeof b !== "string") {
      return false;
    }
    const flat = (t) => t.replace(/\s+/g, " ").trim();
    return flat(a) === flat(b);
  };
  const el = this;
  if (!el || el.tagName !== "SELECT") {
    return { ok: false, error: "the ref is not a <select> element" };
  }
  if (mode === "values") {
    if (!el.multiple) {
      return {
        ok: false,
        error: "the <select> is not a multiple-select; use value/label/index",
      };
    }
    // A keyed object literal inherits Object.prototype, so want["toString"] / want["constructor"]
    // / want["valueOf"] read back truthy for options that were never requested -- and option
    // values and labels are page-controlled data, so a page could have any of them selected by
    // any call. Match against the requested list itself: only what was asked for can hit.
    const want = [];
    const hit = [];
    let k;
    for (k = 0; k < values.length; k++) {
      want[k] = String(values[k]);
      hit[k] = false;
    }
    // Resolve every requested value BEFORE touching the control: a value naming an option this
    // <select> does not have was not honored, and half-applying the request would leave a
    // selection the caller never asked for while reporting a clean success.
    const take = [];
    let j;
    for (j = 0; j < el.options.length; j++) {
      const o = el.options[j];
      let at = -1;
      for (let w = 0; w < want.length; w++) {
        if (want[w] === o.value || sameLabel(want[w], o.text)) {
          at = w;
          break;
        }
      }
      if (at >= 0) {
        hit[at] = true;
      }
      take[j] = at >= 0;
    }
    let missing = "";
    for (k = 0; k < want.length; k++) {
      if (!hit[k]) {
        missing = missing ? missing + ", " + want[k] : want[k];
      }
    }
    if (missing) {
      return { ok: false, error: "no option matched: " + missing };
    }
    const picked = [];
    for (j = 0; j < el.options.length; j++) {
      el.options[j].selected = take[j];
      if (take[j]) {
        picked.push({ value: el.options[j].value, label: el.options[j].text });
      }
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, multiple: true, selected: picked };
  }
  let chosen = -1;
  for (let i = 0; i < el.options.length; i++) {
    const opt = el.options[i];
    if (mode === "value" && opt.value === value) {
      chosen = i;
      break;
    }
    if (
      mode === "label" &&
      (sameLabel(opt.label, label) || sameLabel(opt.text, label))
    ) {
      chosen = i;
      break;
    }
    if (mode === "index" && i === index) {
      chosen = i;
      break;
    }
  }
  if (chosen < 0) {
    return { ok: false, error: "no option matched" };
  }
  el.selectedIndex = chosen;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    ok: true,
    selectedIndex: chosen,
    value: el.value,
    label: el.options[chosen].text,
  };
};

// The CDP argument values for selectOptionFn: the match mode plus one slot per criterion.
// Exactly one criterion, as the tool documents. Picking one by precedence would silently
// resolve a contradictory call (value:"a" with index:3) to whichever branch happens to win, and
// act on an option the caller did not unambiguously name.
// One row per criterion: present() tests whether the caller named it, row() is the CDP
// argument tuple when it is the chosen one. Table-driven so selectCallArgs stays a flat
// "exactly one must match" check instead of a chain of parallel ternaries (CCN gate).
const SELECT_CRITERIA = [
  {
    present: (a) => typeof a.value === "string" && a.value.length > 0,
    row: (a) => ["value", a.value, "", -1, []],
  },
  {
    present: (a) => typeof a.label === "string" && a.label.length > 0,
    row: (a) => ["label", "", a.label, -1, []],
  },
  {
    present: (a) => Number.isInteger(a.index),
    row: (a) => ["index", "", "", a.index, []],
  },
  {
    present: (a) => Array.isArray(a.values) && a.values.length > 0,
    row: (a) => ["values", "", "", -1, a.values.map(String)],
  },
];

function selectCallArgs(args) {
  const matched = SELECT_CRITERIA.filter((c) => c.present(args));
  if (matched.length === 0) {
    throw new Error(
      "browser_select needs one of value, label, index, or values.",
    );
  }
  if (matched.length > 1) {
    throw new Error(
      "browser_select takes exactly one of value, label, index, or values.",
    );
  }
  return matched[0].row(args);
}

// Select an <option> in a <select> by value, visible label, or index. The matching runs
// inside the page via Runtime.callFunctionOn on the ref-resolved node -- the function body
// is a CONSTANT string and value/label/index are passed as CDP argument VALUES (never
// interpolated into code), so there is no page-content injection surface.
async function handleSelect(session, tabId, args) {
  await ensureAttached(session, tabId);
  requireSnapshotTab(session, tabId);
  if (typeof args.backendNodeId !== "number") {
    throw new Error(
      "This action needs a valid <select> element ref from the latest snapshot.",
    );
  }
  const callArgs = selectCallArgs(args);
  const point = await resolveActionPoint(tabId, args.backendNodeId);
  await moveAgentCursor(tabId, point.x, point.y);
  const objectId = await resolveNodeObjectId(tabId, args.backendNodeId);
  const result = await callOnNode(tabId, objectId, selectOptionFn, callArgs);
  if (!result || !result.ok) {
    throw new Error((result && result.error) || "browser_select failed");
  }
  if (result.multiple) {
    return { ok: true, multiple: true, selected: result.selected };
  }
  return {
    ok: true,
    selectedIndex: result.selectedIndex,
    value: result.value,
    label: result.label,
  };
}

// Resolve a snapshot ref to a JS object handle for a constant callFunctionOn. Shared by the
// value/media setters, which act via a fixed function body (no page content is ever eval'd).
async function resolveNodeObjectId(tabId, backendNodeId) {
  if (typeof backendNodeId !== "number") {
    throw new Error(
      "This action needs a valid element ref from the latest snapshot.",
    );
  }
  const resolved = await sendCdp(tabId, "DOM.resolveNode", {
    backendNodeId,
    objectGroup: CDP_OBJECT_GROUP,
  });
  const objectId = resolved && resolved.object && resolved.object.objectId;
  if (!objectId) {
    throw new Error("Could not resolve the element; take a fresh snapshot.");
  }
  return objectId;
}

// awaitPromise lets a caller whose function body returns a promise (media playback) have CDP
// resolve it before the result comes back, so the outcome is the real one and not "a promise was
// created". It stays opt-in: the other callers are synchronous and must not pay for it.
async function callOnNode(tabId, objectId, fn, args, awaitPromise) {
  const call = await sendCdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn.toString(),
    arguments: (args || []).map((v) => ({ value: v })),
    returnByValue: true,
    awaitPromise: awaitPromise === true,
  });
  return call && call.result && call.result.value;
}

// Set a control's value or checked state and fire input/change. Works for range sliders,
// date/time/color/number inputs, checkboxes/radios, contenteditable, and hidden or custom
// controls (no visible box needed -- it acts on the ref'd node via a CONSTANT function; the
// value/checked come in as CDP argument values, never interpolated as code).
async function handleSetValue(session, tabId, args) {
  await ensureAttached(session, tabId);
  requireSnapshotTab(session, tabId);
  const hasChecked = typeof args.checked === "boolean";
  const hasValue = typeof args.value === "string";
  if (!hasChecked && !hasValue) {
    throw new Error("browser_set_value needs a value or checked.");
  }
  // Preferring one over the other would silently drop half of a contradictory request.
  if (hasChecked && hasValue) {
    throw new Error(
      "browser_set_value takes either value or checked, not both.",
    );
  }
  const objectId = await resolveNodeObjectId(tabId, args.backendNodeId);
  const point = await resolveActionPoint(tabId, args.backendNodeId).catch(
    () => null,
  );
  if (point) {
    await moveAgentCursor(tabId, point.x, point.y);
  }
  const setFn = function (mode, value, checked) {
    const el = this;
    if (!el) {
      return { ok: false, error: "no element" };
    }
    const type = (el.type || "").toLowerCase();
    if (mode === "checked") {
      // A checked request aimed at anything else is a mis-identified control (a text input, a
      // <select>, a custom element with a value property). Falling through to the value branch
      // would assign it the empty string this path carries -- wiping the control -- and report
      // success for a checkbox action that never happened.
      if (type !== "checkbox" && type !== "radio") {
        return {
          ok: false,
          error: "checked only applies to a checkbox or radio",
        };
      }
      el.checked = checked;
    } else if ("value" in el) {
      el.value = value;
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else {
      return { ok: false, error: "element has no settable value" };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      ok: true,
      value: "value" in el ? el.value : el.textContent || "",
      checked: Boolean(el.checked),
    };
  };
  const mode = hasChecked ? "checked" : "value";
  const r = await callOnNode(tabId, objectId, setFn, [
    mode,
    hasValue ? args.value : "",
    hasChecked ? args.checked : false,
  ]);
  if (!r || !r.ok) {
    throw new Error((r && r.error) || "browser_set_value failed");
  }
  return { ok: true, value: r.value, checked: r.checked };
}

// Control an <audio>/<video> element: play/pause/mute/unmute/seek/volume/rate. Returns the
// resulting media state. Constant function body; the numeric argument arrives as a value.
async function handleMedia(session, tabId, args) {
  await ensureAttached(session, tabId);
  requireSnapshotTab(session, tabId);
  const action = String(args.action || "").toLowerCase();
  const num =
    args.value !== undefined && args.value !== null && String(args.value) !== ""
      ? Number(args.value)
      : NaN;
  // A seek/volume/rate without a usable number is a request this cannot carry out. Doing nothing
  // and answering ok:true reports an action that never happened, and the caller is left believing
  // the media moved to a position it never went to. Checked before the page is touched at all.
  if (
    (action === "seek" || action === "volume" || action === "rate") &&
    isNaN(num)
  ) {
    throw new Error("browser_media " + action + " needs a numeric value.");
  }
  // Clamping is a silent substitution: volume 5 becomes 1 and is reported as done. The valid
  // range is the caller's to respect.
  if (action === "volume" && (num < 0 || num > 1)) {
    throw new Error("browser_media volume must be between 0 and 1.");
  }
  const objectId = await resolveNodeObjectId(tabId, args.backendNodeId);
  const mediaFn = async function (requestedAction, numericValue) {
    const el = this;
    if (!el || (el.tagName !== "VIDEO" && el.tagName !== "AUDIO")) {
      return {
        ok: false,
        error: "the ref is not an <audio> or <video> element",
      };
    }
    try {
      // play() is asynchronous and REJECTS when the browser refuses it (autoplay policy, no user
      // gesture). Sampling el.paused right after the call reads the state before the refusal has
      // landed, so a blocked play reports paused:false -- playing -- for silence.
      if (requestedAction === "play") {
        await el.play();
      } else if (requestedAction === "pause") {
        el.pause();
      } else if (requestedAction === "mute") {
        el.muted = true;
      } else if (requestedAction === "unmute") {
        el.muted = false;
      } else if (requestedAction === "seek") {
        el.currentTime = numericValue;
      } else if (requestedAction === "volume") {
        el.volume = numericValue;
      } else if (requestedAction === "rate") {
        el.playbackRate = numericValue;
      } else {
        return {
          ok: false,
          error: "unknown media action: " + requestedAction,
        };
      }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
    return {
      ok: true,
      paused: el.paused,
      muted: el.muted,
      currentTime: el.currentTime,
      duration: isFinite(el.duration) ? el.duration : null,
      volume: el.volume,
      rate: el.playbackRate,
    };
  };
  const r = await callOnNode(
    tabId,
    objectId,
    mediaFn,
    [action, isNaN(num) ? 0 : num],
    true,
  );
  if (!r || !r.ok) {
    throw new Error((r && r.error) || "browser_media failed");
  }
  return r;
}

// -- inspection + robustness (mostly read-only) ------------------------------

// How much longer than the wait itself a page may take to answer it before the evaluate is
// terminated: a page under load runs its own timers late.
const PAGE_DELAY_GRACE_MS = 5000;
// How many polls in a row may go untimed (the page could not run a timer) before a wait gives up
// rather than spinning through its deadline.
const MAX_UNTIMED_POLLS = 5;

// A wait timed by the PAGE, not by this worker. Chrome coalesces a background service worker's
// timers hard: measured on a tab the user was not looking at, a 100 ms timer answered in 6.3 s, a
// 150 ms drag hold took 10.2 s, and browser_wait_for overran its own 1.5 s timeout to 10.3 s --
// while the same page's own timers kept time there to the millisecond (50 ms -> 86, 100 -> 101,
// 250 -> 281, 1000 -> 1003). Every wait about the page is therefore timed by the page.
async function pageDelay(tabId, ms) {
  const wait = Math.max(0, Math.round(Number(ms) || 0));
  await sendCdp(tabId, "Runtime.evaluate", {
    expression: `new Promise(function(done){setTimeout(done, ${wait});})`,
    awaitPromise: true,
    // Its own deadline, so a page that blocks its main thread cannot hold the command open for
    // ever: the evaluate is terminated and the wait fails instead of never answering. Generous
    // against the wait itself, since a busy page also delays its own timers.
    timeout: wait + PAGE_DELAY_GRACE_MS,
  });
}

// Does `selector` currently match an element in the tab? Injection-safe: the selector rides as
// a CDP DOM.querySelector PARAMETER, never interpolated into evaluated code. Throws on an
// invalid selector so a mistyped condition fails fast instead of polling until timeout.
async function selectorPresent(tabId, selector) {
  // Deep match that PIERCES open shadow DOM (plain DOM.querySelector stops at a shadow
  // boundary, so web-component content -- common on real sites -- would never be found). The
  // selector rides as a callFunctionOn ARGUMENT value, never interpolated into code. An invalid
  // selector throws inside querySelector; we surface that as an error so a mistyped wait fails
  // fast instead of silently polling until timeout.
  const docObj = await sendCdp(tabId, "Runtime.evaluate", {
    expression: "document",
    returnByValue: false,
    objectGroup: CDP_OBJECT_GROUP,
  });
  const objectId = docObj && docObj.result && docObj.result.objectId;
  // No handle means the page could not be read at all (an execution context destroyed mid
  // navigation), which establishes nothing about the selector. Answering "not present" turns that
  // failed read into a fact -- and under `absent` that fact reads as the wait being satisfied.
  if (!objectId) {
    throw transientReadError(
      "Could not read the page to test the selector; it may be navigating.",
    );
  }
  const matchFn = function (sel) {
    function walk(root) {
      if (root.querySelector(sel)) {
        return true;
      }
      const all = root.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const sr = all[i].shadowRoot;
        if (sr && walk(sr)) {
          return true;
        }
      }
      return false;
    }
    return walk(this); // `this` is the document (the callFunctionOn objectId)
  };
  const call = await sendCdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: matchFn.toString(),
    arguments: [{ value: selector }],
    returnByValue: true,
  });
  if (call && call.exceptionDetails) {
    throw new Error("Invalid selector for browser_wait_for: " + selector);
  }
  return Boolean(call && call.result && call.result.value === true);
}

// The page's visible text. A read that FAILED is not empty text: with `absent` set, "" satisfies
// the wait, so swallowing an "execution context was destroyed" would report a spinner as gone
// having never seen the page. The failure is the answer, and the caller can re-issue the wait.
async function bodyText(tabId) {
  const res = await sendCdp(tabId, "Runtime.evaluate", {
    expression: presenceFreeReadScript(
      "document.body ? document.body.innerText : ''",
    ),
    returnByValue: true,
  });
  if (
    !res ||
    res.exceptionDetails ||
    !res.result ||
    typeof res.result.value !== "string"
  ) {
    throw transientReadError(
      "Could not read the page text; it may be navigating.",
    );
  }
  return res.result.value;
}

// A read that could not be taken because the page was mid-navigation. It is NOT an answer --
// under `absent` an unreadable page must never count as "the thing is gone" -- but it is also
// not a reason to abandon the wait: an execution context torn down by an ordinary navigation is
// exactly what a wait is usually sitting through. Marked so the poll loop can tell it apart
// from a caller error (a mistyped selector) that should fail immediately.
function transientReadError(message) {
  const error = new Error(message);
  error.transient = true;
  return error;
}

// A wait duration the caller stated, bounded by `cap`. `Number(x) || fallback` rewrites an
// explicit 0 -- "check once, do not wait" -- into the default, answering a different question
// than the one asked; and a negative or non-numeric duration is not a wait this can honor at all.
function waitDurationMs(raw, name, fallback, cap) {
  if (raw === undefined || raw === null) {
    return Math.min(cap, fallback);
  }
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(
      "browser_wait_for " +
        name +
        " must be a non-negative number of milliseconds.",
    );
  }
  return Math.min(cap, ms);
}

// Poll until a page condition holds or the timeout elapses. Read-only: it reads text/URL or
// checks element presence, never mutating the page. Exactly one of text / url_contains /
// selector; `absent` inverts the wait (gone instead of present). Text/selector conditions run
// injection-safely (text compared here, selector passed as a CDP param).
async function handleWaitFor(session, tabId, args) {
  const tab = tabStateOf(session, tabId);
  await ensureAttached(session, tabId);
  // The generation this wait belongs to. Re-checked every poll so a superseded wait stops
  // driving the page instead of finishing into a connection that is already gone.
  const gen = session.commandGeneration;
  // This used to be capped at 25 s to stay inside the bridge's 30 s deadline: a wait that
  // outlasted it left the caller reading a transport reset while this loop kept polling and
  // finally posted its reply into a relay that was already gone. That deadline is a SILENCE
  // budget now -- the progress beat this command sends every few seconds restarts it -- so the
  // cap is the same 120 s ceiling browser_download uses, comfortably inside the 180 s ceiling on
  // a whole exchange. The timeout a caller sees is still this handler's own "not satisfied".
  const timeout = waitDurationMs(args.timeout_ms, "timeout_ms", 8000, 120000);
  const absent = args.absent === true;
  const text =
    typeof args.text === "string" && args.text.length > 0 ? args.text : null;
  const urlSub =
    typeof args.url_contains === "string" && args.url_contains.length > 0
      ? args.url_contains
      : null;
  const selector =
    typeof args.selector === "string" && args.selector.length > 0
      ? args.selector
      : null;
  const netIdle = args.network_idle === true;
  if (
    (text ? 1 : 0) +
      (urlSub ? 1 : 0) +
      (selector ? 1 : 0) +
      (netIdle ? 1 : 0) !==
    1
  ) {
    throw new Error(
      "browser_wait_for needs exactly one of text, url_contains, selector, or network_idle.",
    );
  }
  // network_idle: no in-flight requests for a quiet window (idle_ms). Not subject to `absent`.
  const idleMs = waitDurationMs(args.idle_ms, "idle_ms", 500, 30000);
  const holds = async () => {
    if (netIdle) {
      // The predicate is read entirely off the Network domain's events. Without the domain
      // enabled no event ever fires, so the set stays empty and the timestamp stays at attach
      // time: the first poll would report a quiet page on the strength of no observation at all.
      if (!tab.networkInstrumented) {
        throw new Error(
          "network_idle is unavailable: the Network domain is not instrumenting this tab.",
        );
      }
      return (
        tab.inflightRequests.size === 0 &&
        Date.now() - tab.lastNetworkActivityMs >= idleMs
      );
    }
    let hit;
    try {
      if (text) {
        hit = (await bodyText(tabId)).includes(text);
      } else if (urlSub) {
        hit = (await tabInfo(tabId)).url.includes(urlSub);
      } else {
        hit = await selectorPresent(tabId, selector);
      }
    } catch (e) {
      // A page that could not be read this poll establishes NOTHING, so the condition does not
      // hold -- in either polarity. Returning false rather than !hit is the point: under
      // `absent`, treating an unreadable page as "the element is gone" would satisfy the wait on
      // the strength of a failed observation. The loop simply tries again, and if the page never
      // becomes readable the wait ends as an honest timed-out/not-satisfied. A caller error --
      // an invalid selector -- is not transient and still fails immediately.
      if (e && e.transient === true) {
        return false;
      }
      throw e;
    }
    return absent ? !hit : hit;
  };
  const started = Date.now();
  let untimed = 0;
  for (;;) {
    if (gen !== session.commandGeneration) {
      throw new Error(
        "The wait was superseded by a newer command (or the tab session ended).",
      );
    }
    if (await holds()) {
      return { ok: true, satisfied: true, waited_ms: Date.now() - started };
    }
    if (Date.now() - started >= timeout) {
      return {
        ok: true,
        satisfied: false,
        timed_out: true,
        waited_ms: Date.now() - started,
      };
    }
    // A navigation destroys the context this delay is timed in, and the next check runs at once.
    // A page that cannot time anything would turn this into a spin, so only a few in a row are
    // tolerated -- past that the wait fails with the page's own error.
    try {
      await pageDelay(tabId, 250);
      untimed = 0;
    } catch (error) {
      untimed += 1;
      if (untimed > MAX_UNTIMED_POLLS) {
        throw error;
      }
    }
  }
}

// Read the live state of a control by ref (value, checked, selected options, contenteditable
// text, disabled). Read-only; constant function body. Everything read here is page-controlled
// data of unbounded size, so each string and the option list are capped -- and a cap that BIT is
// reported, because a silently truncated value reads as the whole value to the model.
async function handleGetValue(session, tabId, args) {
  await ensureAttached(session, tabId);
  requireSnapshotTab(session, tabId);
  const objectId = await resolveNodeObjectId(tabId, args.backendNodeId);
  const getFn = function () {
    const el = this;
    if (!el) {
      return { ok: false, error: "no element" };
    }
    const cap = function (s, n) {
      return s.length > n ? s.slice(0, n) : s;
    };
    const out = { ok: true, tag: String(el.tagName || "").toLowerCase() };
    if ("value" in el) {
      const v = String(el.value);
      out.value = cap(v, 5000);
      if (v.length > 5000) {
        out.value_truncated = true;
      }
    }
    if (typeof el.checked === "boolean") {
      out.checked = el.checked;
    }
    if (el.tagName === "SELECT") {
      out.multiple = Boolean(el.multiple);
      const picked = el.selectedOptions || [];
      out.selected = Array.prototype.slice
        .call(picked, 0, 200)
        .map(function (o) {
          return {
            value: cap(String(o.value), 2048),
            label: cap(String(o.text), 2048),
          };
        });
      out.selected_capped = picked.length > 200;
    }
    if (el.isContentEditable) {
      const t = String(el.textContent || "");
      out.text = cap(t, 5000);
      if (t.length > 5000) {
        out.text_truncated = true;
      }
    }
    out.disabled = Boolean(el.disabled);
    return out;
  };
  const r = await callOnNode(tabId, objectId, getFn, []);
  if (!r || !r.ok) {
    throw new Error((r && r.error) || "browser_get_value failed");
  }
  return r;
}

// Read one attribute (name given) or all attributes of a ref. Read-only; values and the attribute
// LIST are page-derived and unbounded (hundreds of data-* attributes, a 2 MB data: URI in src), so
// both are capped -- and a cap that bit is reported, because a href cut at exactly 2048 chars
// reads back as a complete URL the model may then navigate to.
async function handleGetAttribute(session, tabId, args) {
  await ensureAttached(session, tabId);
  requireSnapshotTab(session, tabId);
  const objectId = await resolveNodeObjectId(tabId, args.backendNodeId);
  const name = typeof args.name === "string" ? args.name : "";
  const attrFn = function (attributeName) {
    const el = this;
    if (!el || !el.getAttribute) {
      return { ok: false, error: "element has no attributes" };
    }
    const cap = function (v) {
      return String(v).slice(0, 2048);
    };
    const bit = function (v) {
      return String(v).length > 2048;
    };
    if (attributeName) {
      const one = el.getAttribute(attributeName);
      if (one === null) {
        return { ok: true, name: attributeName, value: null };
      }
      const out = { ok: true, name: attributeName, value: cap(one) };
      if (bit(one)) {
        out.value_truncated = true;
      }
      return out;
    }
    const all = {};
    const cut = [];
    const total = el.attributes.length;
    const shown = total > 200 ? 200 : total;
    for (let i = 0; i < shown; i++) {
      const a = el.attributes[i];
      // defineProperty, not all[a.name] = v: an attribute named __proto__ is a legal attribute,
      // and plain assignment of a string to it sets nothing at all. The attribute would then be
      // missing from a listing whose count still claims it -- the page choosing which of its own
      // attributes the model gets to see.
      Object.defineProperty(all, a.name, {
        value: cap(a.value),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      if (bit(a.value)) {
        cut.push(a.name);
      }
    }
    return {
      ok: true,
      attributes: all,
      count: total,
      capped: total > shown,
      truncated_attributes: cut,
    };
  };
  const r = await callOnNode(tabId, objectId, attrFn, [name]);
  if (!r || !r.ok) {
    throw new Error((r && r.error) || "browser_get_attribute failed");
  }
  return r;
}

// The element's content quad, or null when the page genuinely has no box for it (display:none,
// an unrendered subtree). DOM.getBoxModel also fails for reasons that are NOT facts about the
// layout -- a ref that no longer names a node, a dead session, a transport error -- and those
// must surface as the errors they are: reporting laid_out:false for them tells the model the
// element exists but is hidden, when what actually happened is that nothing could be read.
async function boxModelQuad(tabId, backendNodeId) {
  let model;
  try {
    model = await sendCdp(tabId, "DOM.getBoxModel", { backendNodeId });
  } catch (error) {
    const m = String(error && error.message ? error.message : error);
    if (/could not compute box model/i.test(m)) {
      return null;
    }
    throw new Error(
      "The element's box could not be read (" + m + "); take a fresh snapshot.",
      { cause: error },
    );
  }
  const quad = model && model.model && model.model.content;
  return quad && quad.length >= 8 ? quad : null;
}

// The axis-aligned CSS-pixel rectangle a CDP content quad covers.
function quadRect(quad) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min.apply(null, xs),
    top = Math.min.apply(null, ys);
  const right = Math.max.apply(null, xs),
    bottom = Math.max.apply(null, ys);
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

// Report a ref's geometry, whether it is inside the viewport, and whether an overlay covers its
// center (occlusion). Read-only; scrolls-into-view are not performed here so the box reflects
// where the element actually sits right now.
async function handleBox(session, tabId, args) {
  await ensureAttached(session, tabId);
  requireSnapshotTab(session, tabId);
  if (typeof args.backendNodeId !== "number") {
    throw new Error(
      "This action needs a valid element ref from the latest snapshot.",
    );
  }
  const quad = await boxModelQuad(tabId, args.backendNodeId);
  if (!quad) {
    return { ok: true, laid_out: false };
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min.apply(null, xs),
    top = Math.min.apply(null, ys);
  const right = Math.max.apply(null, xs),
    bottom = Math.max.apply(null, ys);
  const center = quadCenter(quad);
  // Geometry is in CSS px, but browser_click_at takes SCREENSHOT px (device px = CSS px x dpr).
  // They coincide only at dpr 1; on a 125%/150% desktop, a Retina Mac, or a zoomed page, feeding
  // the CSS center to click_at lands the click short of the target. screenshot_center (below)
  // carries the conversion so a caller never has to do it.
  const out = {
    ok: true,
    laid_out: true,
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
    center: { x: Math.round(center.x), y: Math.round(center.y) },
  };
  const vp = await viewportState(tabId);
  const metrics = await sendCdp(tabId, "Page.getLayoutMetrics", {}).catch(
    () => null,
  );
  const view = metrics && metrics.cssVisualViewport;
  if (view) {
    const vw = view.clientWidth || 0,
      vh = view.clientHeight || 0;
    out.in_viewport = left >= 0 && top >= 0 && right <= vw && bottom <= vh;
  } else {
    // Only the CSS metrics answer this: the other members are device pixels, and comparing a CSS
    // box against them would call every element on a 2x display in view.
    out.viewport_unknown = true;
  }
  // viewportState's contract: a failed read returns placeholders behind ok:false, so the dpr is
  // only a real measurement when ok. Emitting the placeholder 1 would state a scale factor the
  // page never reported, which a caller converting device pixels would act on.
  if (vp.ok) {
    out.dpr = vp.dpr;
    // Where the center falls in a viewport browser_screenshot taken at this scroll position and
    // pinch: the quad is in visual-viewport CSS px, and the image spans dpr x pinch-scale device
    // pixels per CSS pixel from the visual viewport's origin.
    out.screenshot_center = {
      x: Math.round(center.x * vp.dpr * vp.scale),
      y: Math.round(center.y * vp.dpr * vp.scale),
    };
  } else {
    out.dpr_unknown = true;
  }
  const occ = await occlusionAt(tabId, center.x, center.y, args.backendNodeId);
  out.occluded = occ.occluded;
  if (occ.unknown) {
    out.occlusion_unknown = true;
  }
  if (occ.occluded) {
    out.occluded_by = occ.by;
  }
  return out;
}

// Focus a ref (fires the page's focus events, like a real tab-into). Pointer-adjacent and
// non-destructive; used to prepare an element for browser_press_key without a click.
async function handleFocus(session, tabId, args) {
  await ensureAttached(session, tabId);
  requireSnapshotTab(session, tabId);
  if (typeof args.backendNodeId !== "number") {
    throw new Error(
      "This action needs a valid element ref from the latest snapshot.",
    );
  }
  try {
    await sendCdp(tabId, "DOM.focus", { backendNodeId: args.backendNodeId });
  } catch (error) {
    throw new Error(
      "Could not focus the element (it may not be focusable); take a fresh snapshot.",
      { cause: error },
    );
  }
  // DOM.focus resolving is not the element HAVING focus: the focus/focusin handler it just ran
  // can move focus elsewhere synchronously. Reporting ok on the call alone is what would send the
  // next browser_press_key into a control the model never chose, so the post-condition is read
  // back on the node itself.
  if (!(await nodeHasFocus(tabId, args.backendNodeId))) {
    throw new Error(
      "The page moved focus off the element (or it cannot hold focus); take a " +
        "fresh snapshot and target the element that is focused.",
    );
  }
  return { ok: true, focused: true };
}

// Scroll a ref into view (bring an off-screen element on-screen before a screenshot or
// coordinate click). Viewport-only change, like browser_scroll.
async function handleReveal(session, tabId, args) {
  await ensureAttached(session, tabId);
  requireSnapshotTab(session, tabId);
  if (typeof args.backendNodeId !== "number") {
    throw new Error(
      "This action needs a valid element ref from the latest snapshot.",
    );
  }
  try {
    await sendCdp(tabId, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId: args.backendNodeId,
    });
  } catch (error) {
    throw new Error(
      "The element is not laid out (hidden or gone); take a fresh snapshot.",
      { cause: error },
    );
  }
  const point = await resolveActionPoint(tabId, args.backendNodeId).catch(
    () => null,
  );
  if (point) {
    await moveAgentCursor(tabId, point.x, point.y);
  }
  // This tool exists to GUARANTEE the element is on screen before a screenshot or a coordinate
  // click, so the reply carries where it actually landed. A bare ok would be the caller's own
  // request echoed back, with nothing to check the next coordinate against.
  const quad = await boxModelQuad(tabId, args.backendNodeId);
  if (!quad) {
    return { ok: true, laid_out: false };
  }
  return { ok: true, laid_out: true, box: quadRect(quad) };
}

// -- file upload ------------------------------------------------------------
//
// CDP's own file API (DOM.setFileInputFiles) answers "Not allowed" to a chrome.debugger session,
// so a file is handed to the page the way the page itself would build one: the bytes arrive here
// over the bridge, and a function running IN the page makes a File out of them and assigns it
// through a DataTransfer. That is ordinary web platform behaviour and needs no privileged API.
// The input then holds a real File -- name, size, type, and contents -- and the page's own change
// handler runs, so a site that reads files[0] or submits the form sees exactly what the user's
// own choice would have given it.
//
// The bytes arrive in pieces because they must: Chrome caps one native-messaging message from a
// host at 1 MiB, so the app sends a file as a series of uploadChunk commands and then one upload
// command naming the element and the files to assign. Chunks are held here only between those
// calls, are bounded in size and number, and are dropped whenever the session ends.
//
// This tool can put any file the user can read onto any page the session is on. That is the point
// of it and also its risk: it is a mutating tool, absent from the read-only profile, and the app
// refuses a path outside CHROME_CONTROL_MCP_UPLOAD_ROOTS when that is set.
// Bounds on what may be held here at once. The app enforces the same ceiling before it sends
// anything; this is the side that must not be talked into holding more than it should.
const MAX_UPLOAD_BASE64 = 24 * 1024 * 1024;
const MAX_UPLOAD_CHUNKS = 64;
const MAX_UPLOADS_IN_FLIGHT = 8;

// Drop every buffered chunk. Called when the session ends, the bridge drops, or CDP detaches: a
// half-delivered file belongs to a session that no longer exists, and keeping it would carry the
// user's bytes into the next one.
function clearUploads(session) {
  session.uploadChunks.clear();
}

// One piece of a file. Pieces may arrive in any order; sequence numbers put them back together,
// and a piece that would push this upload past its bounds is refused rather than truncated --
// a truncated file uploaded as though whole is worse than no upload at all.
async function handleUploadChunk(session, args) {
  const id = typeof args.upload_id === "string" ? args.upload_id : "";
  const seq = Number(args.seq);
  const total = Number(args.total);
  const data = typeof args.data === "string" ? args.data : "";
  if (!id || !Number.isInteger(seq) || !Number.isInteger(total) || total < 1) {
    throw new Error("An upload chunk needs upload_id, seq, and total.");
  }
  if (total > MAX_UPLOAD_CHUNKS) {
    throw new Error("The upload has too many pieces.");
  }
  if (seq < 0 || seq >= total) {
    throw new Error("The upload chunk is out of range.");
  }
  let entry = session.uploadChunks.get(id);
  if (!entry) {
    if (session.uploadChunks.size >= MAX_UPLOADS_IN_FLIGHT) {
      throw new Error("Too many uploads are in flight.");
    }
    entry = { total, pieces: new Map(), bytes: 0 };
    session.uploadChunks.set(id, entry);
  }
  if (entry.total !== total) {
    throw new Error("The upload's pieces disagree about how many there are.");
  }
  const previous = entry.pieces.get(seq);
  const nextBytes =
    entry.bytes - (previous ? previous.length : 0) + data.length;
  if (nextBytes > MAX_UPLOAD_BASE64) {
    throw new Error("The upload is larger than this bridge carries.");
  }
  entry.pieces.set(seq, data);
  entry.bytes = nextBytes;
  return { ok: true, received: entry.pieces.size, total: entry.total };
}

// Put an upload back together, or say it cannot be. Returns null when a piece never arrived,
// which the caller reports rather than assigning a file with a hole in it.
function assembleUpload(session, id) {
  const entry = session.uploadChunks.get(id);
  if (!entry) {
    return null;
  }
  const ordered = [];
  for (let seq = 0; seq < entry.total; seq += 1) {
    const piece = entry.pieces.get(seq);
    if (typeof piece !== "string") {
      return null;
    }
    ordered.push(piece);
  }
  return ordered.join("");
}

// The file input behind a control, or why there is none. Returns {input} or {error}.
//
// The input a page shows is almost never the one it uses. The pattern is universal: the real
// `<input type="file">` is hidden and a styled button, label, or menu item is put in front of it.
// A hidden input has no box and no accessibility node, so a ref may well name the visible control
// instead -- and a tool that insisted on the input itself could not be used on any ordinary page.
// So the search runs outward from whatever was named: the element itself, the input a label
// points at, one inside it, the input of an enclosing label, and finally the single file input of
// the nearest ancestor that has exactly one.
//
// Exactly one, at every step: a scope holding several is ambiguous, and taking the first in
// document order would attach the caller's file to an input they never named. Ambiguity is
// reported, never guessed at.
//
// It runs in the PAGE (its source is inlined into the call), so it closes over nothing, uses no
// worker state, and touches only the element it is given and that element's own document.
function resolveFileInputFrom(start) {
  if (!start) {
    return { error: "no element" };
  }
  const isFileInput = (node) =>
    Boolean(node) &&
    node.tagName === "INPUT" &&
    (node.type || "").toLowerCase() === "file";
  if (isFileInput(start)) {
    return { input: start };
  }
  if (isFileInput(start.control)) {
    return { input: start.control }; // a <label> whose control is the input
  }
  if (start.htmlFor && start.ownerDocument) {
    const byId = start.ownerDocument.getElementById(start.htmlFor);
    if (isFileInput(byId)) {
      return { input: byId };
    }
  }
  if (typeof start.querySelector === "function") {
    const inside = start.querySelector('input[type="file"]');
    if (inside) {
      return { input: inside };
    }
  }
  if (typeof start.closest === "function") {
    const label = start.closest("label");
    if (label && isFileInput(label.control)) {
      return { input: label.control };
    }
  }
  let scope = start.parentElement;
  while (scope) {
    const found =
      typeof scope.querySelectorAll === "function"
        ? scope.querySelectorAll('input[type="file"]')
        : [];
    if (found.length > 1) {
      return {
        error:
          "that control has several file inputs near it; name the input itself",
      };
    }
    if (found.length === 1) {
      return { input: found[0] };
    }
    scope = scope.parentElement;
  }
  // `none` separates "there is no input here at all" -- which the caller may still answer by
  // dropping the files on the element, as on a drop zone -- from the ambiguity above, which it
  // must not guess its way past.
  return {
    error:
      "that element is not a file input and does not open one; upload needs " +
      "<input type=file> or the control that opens it",
    none: true,
  };
}

// Assign the delivered files to a file input, as the user's own choice would. GATED like every
// other tool that changes the page.
async function handleUpload(session, tabId, args) {
  await ensureAttached(session, tabId);
  const tab = tabStateOf(session, tabId);
  // With no ref, the files answer the picker the page itself asked for (see armFilePickers): the
  // input a script created and clicked -- which is in no document, so no ref could ever name it --
  // or a File System Access picker. With a ref, the element named, as before.
  const byRef = Number.isInteger(args.backendNodeId);
  const chooser = byRef ? null : tab.fileChooser;
  if (byRef) {
    requireSnapshotTab(session, tabId);
  } else if (!chooser) {
    throw new Error(
      "browser_upload needs a ref, or a file picker the page has opened -- and none is open on " +
        "tab " +
        tabId +
        ". Click the page's upload control first (no dialog will appear), or pass the ref of the " +
        "file input or drop zone.",
    );
  } else if (chooser.directory) {
    throw new Error(
      "The page asked for a folder. Folder uploads are not supported yet; nothing was assigned.",
    );
  }
  const files = Array.isArray(args.files) ? args.files : [];
  if (!files.length) {
    throw new Error("browser_upload needs at least one file.");
  }
  const payload = [];
  for (const file of files) {
    const data = assembleUpload(session, file.upload_id);
    if (data === null) {
      for (const entry of files) {
        session.uploadChunks.delete(entry.upload_id);
      }
      throw new Error(
        "The file did not arrive whole; nothing was assigned. Send the upload again.",
      );
    }
    payload.push({
      data,
      name: typeof file.name === "string" ? file.name : "file",
      mime: typeof file.mime === "string" ? file.mime : "",
    });
  }
  const backendNodeId = chooser ? chooser.backendNodeId : args.backendNodeId;
  if (chooser && chooser.kind === "picker") {
    try {
      return await answerFilePicker(tabId, payload);
    } finally {
      tab.fileChooser = null;
      for (const file of files) {
        session.uploadChunks.delete(file.upload_id);
      }
    }
  }
  if (chooser && files.length > 1 && !chooser.multiple) {
    for (const file of files) {
      session.uploadChunks.delete(file.upload_id);
    }
    throw new Error(
      "The page's file picker takes one file; it was given " +
        files.length +
        ". Nothing was assigned.",
    );
  }
  const objectId = await resolveNodeObjectId(tabId, backendNodeId);
  const point = await resolveActionPoint(tabId, backendNodeId).catch(
    () => null,
  );
  if (point) {
    await moveAgentCursor(tabId, point.x, point.y);
  }
  // Runs in the page: the File and the DataTransfer are the page's own, which is why this works
  // where the protocol's own file API does not. The resolver's source is inlined into the
  // declaration rather than duplicated, so the page runs the very function the tests exercise.
  const assignFn = function (delivered) {
    const transfer = new DataTransfer();
    for (const item of delivered) {
      const binary = atob(item.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      transfer.items.add(
        new File(
          [bytes],
          item.name,
          item.mime ? { type: item.mime } : undefined,
        ),
      );
    }
    const found = resolveFileInputFrom(this);
    if (found.error && !found.none) {
      return { ok: false, error: found.error };
    }
    if (found.error) {
      // No file input anywhere near it: a drop zone, which takes files only by drag and drop.
      // Deliver them the way a drag from the desktop would. A drop zone accepts a drag by
      // cancelling dragover; an element that does not was never going to take files, and saying
      // "uploaded" for a drop nothing caught would be a claim about the page nobody observed.
      const drag = (type) =>
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: transfer,
        });
      this.dispatchEvent(drag("dragenter"));
      const accepted = !this.dispatchEvent(drag("dragover"));
      if (!accepted) {
        this.dispatchEvent(drag("dragleave"));
        return {
          ok: false,
          error: found.error + ", and it does not accept dropped files either",
        };
      }
      this.dispatchEvent(drag("drop"));
      const dropped = [];
      for (const file of transfer.files) {
        dropped.push({ name: file.name, size: file.size, type: file.type });
      }
      return { ok: true, files: dropped, delivered_by: "drop" };
    }
    const el = found.input;
    if (delivered.length > 1 && !el.multiple) {
      return {
        ok: false,
        error: "that file input takes one file; it is not marked multiple",
      };
    }
    if (el.disabled) {
      return { ok: false, error: "that file input is disabled" };
    }
    el.files = transfer.files;
    // What the input holds is read BEFORE the page hears about it: many sites read the file in
    // their change handler and then empty the input (GitHub does), and a list read afterwards
    // reported a successful upload as no files at all.
    const assigned = [];
    for (const file of el.files) {
      assigned.push({ name: file.name, size: file.size, type: file.type });
    }
    // A page learns about a user's choice through these two events; a site listening for only one
    // of them would otherwise never see the file.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const reply = { ok: true, files: assigned, delivered_by: "input" };
    if (el.files.length === 0 && assigned.length > 0) {
      reply.page_cleared_input = true; // the page took the files and reset its input, as sites do
    }
    return reply;
  };
  // The page gets one self-contained declaration: the resolver's own source in place of the name
  // the worker knows it by. Nothing is re-implemented for the page, so what runs there and what
  // the unit tests call are the same function.
  const declaration = String(assignFn).replace(
    "resolveFileInputFrom(this)",
    `(${String(resolveFileInputFrom)})(this)`,
  );
  let result;
  try {
    result = await sendCdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: declaration,
      arguments: [{ value: payload }],
      returnByValue: true,
      objectGroup: CDP_OBJECT_GROUP,
    });
  } finally {
    // The bytes have served their purpose either way, and holding them past the call keeps the
    // user's file in a worker for no reason.
    for (const file of files) {
      session.uploadChunks.delete(file.upload_id);
    }
  }
  const value = result && result.result && result.result.value;
  if (!value || !value.ok) {
    throw new Error(
      (value && value.error) || "The file could not be assigned.",
    );
  }
  if (chooser) {
    tab.fileChooser = null; // answered; the page has its files
  }
  const reply = {
    ok: true,
    files: value.files,
    delivered_by: value.delivered_by,
  };
  // The page's own change handler took the files and emptied its input, as most upload widgets
  // do. Said so the model does not read an input that is empty again as an upload that failed.
  if (value.page_cleared_input === true) {
    reply.page_cleared_input = true;
  }
  return reply;
}

// Answer a File System Access picker the page is waiting on (see filePickerShimScript) with the
// agent's files, as handles the page reads them through. Runs in the page; closes over nothing.
async function answerFilePicker(tabId, payload) {
  const windowObject = await sendCdp(tabId, "Runtime.evaluate", {
    expression: "window",
    objectGroup: CDP_OBJECT_GROUP,
  });
  const objectId =
    windowObject && windowObject.result && windowObject.result.objectId;
  if (!objectId) {
    throw new Error("The page could not be reached to answer its file picker.");
  }
  const answerFn = function (delivered, stateKey) {
    const state = this[stateKey];
    if (!state || !state.pending) {
      return {
        ok: false,
        error:
          "no file picker is waiting on this page any more (it was answered, cancelled, or " +
          "timed out); click the page's upload control again",
      };
    }
    if (delivered.length > 1 && !state.pending.multiple) {
      return { ok: false, error: "the page's file picker takes one file" };
    }
    const handles = delivered.map((item) => {
      const binary = atob(item.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const file = new File(
        [bytes],
        item.name,
        item.mime ? { type: item.mime } : undefined,
      );
      // What a page does with an opened handle: read its name and kind, get the file, check or ask
      // for permission. Writing back (createWritable) is a save picker's job and is not offered.
      const handle = {
        kind: "file",
        name: file.name,
        getFile: () => Promise.resolve(file),
        queryPermission: () => Promise.resolve("granted"),
        requestPermission: () => Promise.resolve("granted"),
        isSameEntry: (other) => Promise.resolve(other === handle),
      };
      if (typeof FileSystemFileHandle === "function") {
        Object.setPrototypeOf(handle, FileSystemFileHandle.prototype);
      }
      return handle;
    });
    const pending = state.pending;
    state.pending = null;
    pending.resolve(handles);
    return {
      ok: true,
      files: delivered.map((item, i) => ({
        name: item.name,
        size: handles[i] ? atob(item.data).length : 0,
        type: item.mime || "",
      })),
    };
  };
  const result = await sendCdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: String(answerFn),
    arguments: [{ value: payload }, { value: PICKER_STATE_KEY }],
    returnByValue: true,
    objectGroup: CDP_OBJECT_GROUP,
  });
  const value = result && result.result && result.result.value;
  if (!value || !value.ok) {
    throw new Error(
      (value && value.error) || "The file picker was not answered.",
    );
  }
  return { ok: true, files: value.files, delivered_by: "picker" };
}

// Programmatic el.click() in-page, as a fallback when a real pointer click cannot land (target
// occluded by an overlay, zero-box but present, or a control that ignores synthetic pointer
// events). GATED like browser_click. Constant function body.
async function handleJsClick(session, tabId, args) {
  await ensureAttached(session, tabId);
  requireSnapshotTab(session, tabId);
  const objectId = await resolveNodeObjectId(tabId, args.backendNodeId);
  const point = await resolveActionPoint(tabId, args.backendNodeId).catch(
    () => null,
  );
  if (point) {
    await moveAgentCursor(tabId, point.x, point.y);
  }
  const clickFn = function () {
    const el = this;
    if (!el || typeof el.click !== "function") {
      return { ok: false, error: "element is not clickable" };
    }
    // click() on a DISABLED control dispatches nothing at all, so returning ok would report a
    // click no handler ever saw -- and a submit button gated until a form validates is exactly
    // where the model would believe it had acted.
    if (el.disabled === true) {
      return {
        ok: false,
        error: "the element is disabled; nothing was clicked",
      };
    }
    el.click();
    return {
      ok: true,
      tag: String(el.tagName || "")
        .toLowerCase()
        .slice(0, 40),
    };
  };
  const r = await callOnNode(tabId, objectId, clickFn, []);
  if (!r || !r.ok) {
    throw new Error((r && r.error) || "browser_js_click failed");
  }
  return { ok: true, tag: r.tag || "" };
}

// The definition for one key token, under the modifiers it is pressed with. Shift is part of the
// definition rather than of dispatch alone: a printable key held with Shift produces its SHIFTED
// character, and emitting the raw token as `text` types "1" for "Shift+1" or a lower-case letter
// for "Shift+a" -- the wrong character, reported as the chord that was asked for.
function keyDefinition(token, modifiers) {
  const named = KEY_DEFS[token.toLowerCase()];
  if (named) {
    return named;
  }
  const shifted = ((modifiers || 0) & MODIFIER_BITS.shift) !== 0;
  if (token.length === 1) {
    const upper = token.toUpperCase();
    if (/[A-Z]/.test(upper)) {
      // key casing follows the (separate) Shift modifier; shortcut matching uses
      // code/keyCode + modifiers, so emit lower-case key to keep DOM state consistent.
      return {
        key: token.toLowerCase(),
        code: "Key" + upper,
        keyCode: upper.charCodeAt(0),
        text: shifted ? upper : token,
      };
    }
    // A token that is ALREADY the shifted glyph ("?" rather than "/") has no further shifted
    // form, so it stands for itself.
    const text = shifted ? SHIFTED_KEYS[token] || token : token;
    if (/[0-9]/.test(upper)) {
      return {
        key: token,
        code: "Digit" + upper,
        keyCode: upper.charCodeAt(0),
        text,
      };
    }
    const oem = OEM_KEYS[token];
    if (oem) {
      return { key: token, code: oem[0], keyCode: oem[1], text };
    }
  }
  throw new Error("Unsupported key: " + token);
}

function parseChord(keys) {
  // '+' is a key in its own right ("+" alone, "Control++"), and splitting on '+' leaves it as an
  // empty trailing token. Dropping empty tokens would lose the key entirely -- or, worse, promote
  // the last MODIFIER into the key slot and press something the caller never named.
  const parts = String(keys || "").split("+");
  let keyToken = String(parts.pop()).trim();
  if (keyToken === "" && parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
    keyToken = "+";
  }
  if (keyToken === "") {
    throw new Error(
      'pressKey needs a key or chord, e.g. "Enter" or "Control+A".',
    );
  }
  let modifiers = 0;
  for (const mod of parts) {
    const bit = MODIFIER_BITS[String(mod).trim().toLowerCase()];
    if (!bit) {
      throw new Error("Unknown modifier: " + mod);
    }
    modifiers |= bit;
  }
  return { modifiers, def: keyDefinition(keyToken, modifiers) };
}

// The Chromium editing commands a chord runs on macOS (see MAC_EDITING_COMMANDS), in the order
// the binding lists them. Commands that insert text are left out: the key event's own `text`
// inserts it, and Chromium has no command that takes the character. Returns [] for a chord with
// no binding -- which is what every chord is off macOS.
function macEditingCommands(code, modifiers) {
  const parts = [];
  for (const [name, bit] of [
    ["Shift", MODIFIER_BITS.shift],
    ["Control", MODIFIER_BITS.control],
    ["Alt", MODIFIER_BITS.alt],
    ["Meta", MODIFIER_BITS.meta],
  ]) {
    if ((modifiers & bit) !== 0) {
      parts.push(name);
    }
  }
  parts.push(code);
  const binding = MAC_EDITING_COMMANDS[parts.join("+")];
  if (binding === undefined) {
    return [];
  }
  return (Array.isArray(binding) ? binding : [binding])
    .filter((selector) => !selector.startsWith("insert"))
    .map((selector) => selector.slice(0, -1));
}

function keyEventBase(def, modifiers) {
  return {
    modifiers,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
  };
}

// The keyDown for one chord. On macOS it carries the chord's editing commands, without which
// Command+A selects nothing and Backspace deletes nothing (see MAC_EDITING_COMMANDS).
function keyDownEvent(def, modifiers, isMac) {
  const down = Object.assign({ type: "keyDown" }, keyEventBase(def, modifiers));
  // A keyDown with `text` fires keypress/char: this is what makes Enter's implicit form
  // submit work and makes a printable key actually insert its character. Suppress it under
  // Ctrl/Alt/Meta so chords (Control+A) stay edit commands rather than typing a char.
  const nonShift =
    MODIFIER_BITS.alt | MODIFIER_BITS.control | MODIFIER_BITS.meta;
  if (def.text && (modifiers & nonShift) === 0) {
    down.text = def.text;
  }
  const commands = isMac ? macEditingCommands(def.code, modifiers) : [];
  if (commands.length > 0) {
    down.commands = commands;
  }
  return down;
}

// Whether this browser runs on macOS, asked of Chrome once. A failed lookup is not treated as
// "not macOS": that would quietly send key chords that edit nothing, so the error fails the
// command instead and the next call asks again.
let macPlatform = null;
async function isMacPlatform() {
  if (macPlatform === null) {
    const info = await chrome.runtime.getPlatformInfo();
    macPlatform = info.os === "mac";
  }
  return macPlatform;
}

async function dispatchKey(tabId, def, modifiers) {
  const isMac = await isMacPlatform();
  await sendCdp(
    tabId,
    "Input.dispatchKeyEvent",
    keyDownEvent(def, modifiers, isMac),
  );
  await sendCdp(
    tabId,
    "Input.dispatchKeyEvent",
    Object.assign({ type: "keyUp" }, keyEventBase(def, modifiers)),
  );
}

// Where a global key press is about to land: the page's view of document.activeElement, reduced
// to a short descriptor. This is REPORTING, not a boundary (the page owns its focus and can move
// it), and it exists so a key that went somewhere the model did not expect is visible in the
// reply instead of invisible. A failed read is not reported as "nothing focused" -- it fails the
// command, because an unattributable key press is exactly what this is meant to prevent.
async function focusedElementInfo(tabId) {
  const res = await sendCdp(tabId, "Runtime.evaluate", {
    expression:
      "(function(){var e=document.activeElement;" +
      "while(e&&e.shadowRoot&&e.shadowRoot.activeElement){e=e.shadowRoot.activeElement;}" +
      "if(!e){return null;}" +
      "return {tag:String(e.tagName||'').toLowerCase().slice(0,40)," +
      "id:String(e.id||'').slice(0,120),name:String(e.name||'').slice(0,120)," +
      "type:String(e.type||'').slice(0,40)};})()",
    returnByValue: true,
  });
  const value = res && res.result ? res.result.value : undefined;
  if (value === undefined) {
    throw new Error(
      "Could not read which element has focus; take a fresh snapshot.",
    );
  }
  return value;
}

async function handlePressKey(session, tabId, args) {
  await ensureAttached(session, tabId);
  const { modifiers, def } = parseChord(args.keys);
  // The key goes to whatever the page has focused -- which the page itself can move between a
  // browser_click/browser_focus and this call. Read the target first so the reply says WHERE the
  // key went, not only what was sent.
  const focus = await focusedElementInfo(tabId);
  // Copy, cut and paste are the agent's own clipboard's, never the system's: answered here and
  // not sent to Chrome as keys, which is what would read or write the clipboard every agent and
  // the user share (see "Agent clipboards").
  const clipboardOp = clipboardChord(def, modifiers);
  if (clipboardOp) {
    const clipboard = await runClipboardOp(session, tabId, clipboardOp);
    return { ok: true, keys: String(args.keys), focus, clipboard };
  }
  await dispatchKey(tabId, def, modifiers);
  return { ok: true, keys: String(args.keys), focus };
}

// How far to scroll. Coercing a malformed distance to the default scrolls the page by an amount
// nobody asked for and then reports that as the scroll that was requested.
function scrollAmountPx(raw) {
  if (raw === undefined || raw === null) {
    return DEFAULT_SCROLL_PX;
  }
  const px = Number(raw);
  if (!Number.isFinite(px) || px <= 0) {
    throw new Error(
      "browser_scroll amount must be a positive number of pixels.",
    );
  }
  return px;
}

// Which way to scroll. An exact-match test against "up" makes every other spelling -- "Up", "UP",
// and any word that is not a direction at all -- scroll DOWN, which for "Up" is the literal
// opposite of what was asked for.
function scrollDirection(raw) {
  if (raw === undefined || raw === null) {
    return "down";
  }
  const dir = String(raw).trim().toLowerCase();
  if (dir !== "up" && dir !== "down") {
    throw new Error('browser_scroll direction must be "up" or "down".');
  }
  return dir;
}

// A wheel scroll is animated: the page is still moving when the event is acknowledged (measured:
// 400px still to go on the reply, there 250ms later), so a screenshot or snapshot taken on the
// reply would catch it mid-flight. The page says when it has stopped: scrollend fires on whichever
// scroller moved once its offset settles, and a capture listener on the window sees it wherever it
// fires. Polling instead would answer the question far slower than the scroll itself takes -- a
// background tab answers this worker's timers and object calls in seconds, while the scroll it is
// watching is over in a fifth of one.
// Resolves with the scroll offsets once a scroll comes to rest somewhere other than where it
// started. The scrollend event alone is not enough: scrolling the element into view moments earlier
// ends with one of its own, which arrives late enough to answer for the wheel's (measured: in 1 ms,
// before the wheel had moved anything). Comparing against the offsets read before the wheel tells
// them apart in the page, where no end can be missed between one listener and the next -- waiting
// for the following end instead lost the real one and reported a finished scroll as unsettled. It
// clears its own listener and gives up on its own, so a page is never left carrying it.
const scrollEndScript = (x, y, before) =>
  `new Promise(function(done){` +
  SCROLLER_PATH_SOURCE +
  SCROLL_MOVED_SOURCE +
  `var read=${scrollOffsetsFn.toString()};` +
  `var before=${JSON.stringify(before)};` +
  `function clear(){removeEventListener('scrollend',onEnd,true);}` +
  `function onEnd(){var now=read(${Number(x)}, ${Number(y)});` +
  `if(!scrollMovedFn(before,now)){return;}clear();done(now);}` +
  `addEventListener('scrollend',onEnd,true);` +
  `setTimeout(function(){clear();done(null);},${SCROLL_END_PAGE_TIMEOUT_MS});})`;
// How long to wait for that scrollend. A scroll that moves nothing -- an edge already reached,
// nothing scrollable under the pointer -- never fires one, and that is the answer: it moved 0.
const SCROLL_END_TIMEOUT_MS = 2000;
// The page's own listener gives up later than that, so an end that arrives just after this race
// was abandoned still clears the listener rather than leaving it on the page.
const SCROLL_END_PAGE_TIMEOUT_MS = 5000;

// The offsets of every scroller a wheel at (x, y) can move, and of the visual viewport a pinched
// page's wheel pans first, in one call.
// A scroller's identity, stable across two reads of the same page.
//
// The name these reads are matched by USED to count ancestors up from whatever element the point
// happened to land on ("scroller-2:DIV"). That number is a property of the content under the
// point, not of the scroller: scroll the content and the point lands somewhere else in the same
// container -- on its padding, on a taller row, on a child one level deeper -- and the scroller
// that just moved comes back under a different name. scrollDistance matches by name, finds no
// entry from before, and reports 0 for a scroll it had performed; the in-page scrollend watcher
// compares the whole list and sees a change that was only the renaming. Both were measured inside
// a nested scroll container on a real page.
//
// A path from the root names the ELEMENT. What is under the point may change; where the container
// sits in the document does not. An id short-circuits the sibling count (unique within its tree,
// and the path keeps climbing past it so two trees cannot collide); the guard bounds a DOM deep
// enough, or a getRootNode cycle odd enough, to make this walk expensive.
function scrollerPathFn(el) {
  const parts = [];
  let node = el;
  let guard = 0;
  while (node && guard < 64) {
    guard += 1;
    const parent = node.parentElement;
    if (!parent) {
      const root = node.getRootNode();
      const host = root && root.host;
      if (!host) {
        parts.push(node.tagName || "#document");
        break;
      }
      parts.push("shadow"); // crossed a shadow boundary: the segments above are the host's
      node = host;
      continue;
    }
    if (node.id) {
      parts.push(node.tagName + "#" + node.id);
    } else {
      let index = 0;
      for (
        let sib = parent.firstElementChild;
        sib && sib !== node;
        sib = sib.nextElementSibling
      ) {
        index += 1;
      }
      parts.push(node.tagName + "[" + index + "]");
    }
    node = parent;
  }
  return parts.reverse().join("/");
}

function scrollOffsetsFn(x, y) {
  const vv = window.visualViewport;
  const seen = [];
  const offsets = [["visual-viewport", vv.offsetLeft, vv.offsetTop]];
  // The page's own scroller keeps its plain name wherever it is found. It reaches `add` by two
  // routes -- climbed to as an ancestor of the point, or appended at the end -- and naming it by
  // path on the first route and "page" on the second would be the same mismatch by another name.
  const page = document.scrollingElement;
  const add = (e) => {
    if (seen.indexOf(e) >= 0) {
      return; // one entry per scroller: the page's own scroller is often in the chain as well
    }
    seen.push(e);
    offsets.push([
      e === page ? "page" : scrollerPathFn(e),
      e.scrollLeft,
      e.scrollTop,
    ]);
  };
  let e = document.elementFromPoint(x + vv.offsetLeft, y + vv.offsetTop);
  while (e) {
    const style = getComputedStyle(e);
    if (
      /(auto|scroll|overlay)/.test(style.overflowX + " " + style.overflowY) &&
      (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)
    ) {
      add(e);
    }
    const root = e.getRootNode();
    e = e.parentElement || (root && root.host) || null;
  }
  if (page) {
    add(page);
  }
  return offsets;
}

// Whether any scroller present in BOTH reads has moved.
//
// The same rule scrollDistance measures by, and for the same reason: the chain under the point
// changes composition as the content moves, so an entry appearing or disappearing is not movement
// and must not be read as any. The in-page rest detector used to compare the whole serialized
// list, which made exactly that mistake -- it answered "at rest" for a wheel that had not moved
// anything yet, while scrollDistance correctly reported 0, and the page went on moving after the
// reply had been sent.
function scrollMovedFn(before, now) {
  const was = new Map(before.map((entry) => [entry[0], entry]));
  for (const [name, left, top] of now) {
    const previous = was.get(name);
    if (previous && (previous[1] !== left || previous[2] !== top)) {
      return true;
    }
  }
  return false;
}

// Both readers are stringified into the page, and an injected function cannot call one that stayed
// in the worker: whatever they use has to travel with them. Declared under their own names so the
// same source works unchanged in the worker's scope, where the tests call them directly.
const SCROLLER_PATH_SOURCE = `var scrollerPathFn=${scrollerPathFn.toString()};`;
const SCROLL_MOVED_SOURCE = `var scrollMovedFn=${scrollMovedFn.toString()};`;

// A promise for the offsets the page comes to rest at, away from `before`; null if it never does.
function armScrollEnd(tabId, x, y, before) {
  return sendCdp(tabId, "Runtime.evaluate", {
    expression: scrollEndScript(x, y, before),
    awaitPromise: true,
    returnByValue: true,
  }).then(
    (res) => (res && res.result ? res.result.value : null),
    () => null,
  );
}

// The hit test itself, run in the page with the target element as `this`.
//
// Two things it must get right, both learned the hard way. document.elementFromPoint reports the
// HOST for any point inside a shadow tree, and Node.contains stops at a shadow boundary -- so a
// plain contains() test reads every element in a shadow root as "missed". Climbing through
// .host as well as .parentNode is what makes the shadow button in the E2E fixture scrollable.
function pointLandsOnFn(x, y) {
  const v = window.visualViewport;
  const name = (e) => (e ? e.tagName + (e.id ? "#" + e.id : "") : null);
  const climbs = (from, to) => {
    let e = from;
    while (e) {
      if (e === to) {
        return true;
      }
      e = e.parentNode || e.host || null;
    }
    return false;
  };
  const hit = document.elementFromPoint(x + v.offsetLeft, y + v.offsetTop);
  if (!hit) {
    return { hit: null, target: name(this), onTarget: false };
  }
  return {
    hit: name(hit),
    target: name(this),
    onTarget: hit === this || climbs(hit, this) || climbs(this, hit),
  };
}

// Does the point still land on the element the caller named, or on something inside it? Asked of
// the element itself, so it survives a page that moved between the box read and this question --
// which is the whole reason it is asked. A wheel dispatched at a point that misses its element
// scrolls a stranger and reports the element the caller asked for.
async function pointLandsOn(tabId, backendNodeId, x, y) {
  const resolved = await sendCdp(tabId, "DOM.resolveNode", {
    backendNodeId,
    // Tagged so the handle this pins is released with the rest of the command's group; an
    // untagged one would pin the node in the renderer for the life of the document.
    objectGroup: CDP_OBJECT_GROUP,
  }).catch(() => null);
  const objectId = resolved && resolved.object && resolved.object.objectId;
  if (!objectId) {
    return { known: false, onTarget: true, hit: null, target: null };
  }
  const answer = await sendCdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `(${pointLandsOnFn.toString()})`,
    arguments: [{ value: Number(x) }, { value: Number(y) }],
    returnByValue: true,
  }).catch(() => null);
  const value = answer && answer.result ? answer.result.value : null;
  // An unanswerable hit test must not refuse a scroll that would have worked.
  if (!value || typeof value.onTarget !== "boolean") {
    return { known: false, onTarget: true, hit: null, target: null };
  }
  return {
    known: true,
    onTarget: value.onTarget,
    hit: value.hit,
    target: value.target,
  };
}

// Where the wheel will actually land, and how far the scrollers under that point can still
// travel. A scroll that moves nothing is either an edge already reached or a wheel that never
// reached the scroller at all, and those want opposite fixes -- without the room left, the reply
// says "scrolled 0" for both and a model cannot tell which it got.
function scrollContextFn(x, y) {
  const vv = window.visualViewport;
  const target = document.elementFromPoint(x + vv.offsetLeft, y + vv.offsetTop);
  const name = (e) => (e ? e.tagName + (e.id ? "#" + e.id : "") : null);
  const seen = [];
  const scrollers = [];
  const page = document.scrollingElement;
  // Named exactly as scrollOffsetsFn names them, so a reply's `room` and its `scrolled` are
  // talking about the same containers under the same labels.
  const add = (e) => {
    if (seen.indexOf(e) >= 0) {
      return; // one entry per scroller, as scrollOffsetsFn does
    }
    seen.push(e);
    scrollers.push([
      e === page ? "page" : scrollerPathFn(e),
      e.scrollTop,
      e.scrollHeight - e.clientHeight,
    ]);
  };
  let e = target;
  while (e) {
    const style = getComputedStyle(e);
    if (
      /(auto|scroll|overlay)/.test(style.overflowX + " " + style.overflowY) &&
      (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)
    ) {
      add(e);
    }
    const root = e.getRootNode();
    e = e.parentElement || (root && root.host) || null;
  }
  if (page) {
    add(page);
  }
  return { hit: name(target), scrollers };
}

// The context above, read in the page. Never throws the scroll away: a context that cannot be
// read leaves the reply's diagnosis blank rather than failing a scroll that otherwise worked.
async function scrollContext(tabId, x, y) {
  const read = await sendCdp(tabId, "Runtime.evaluate", {
    expression:
      `(function(){${SCROLLER_PATH_SOURCE}` +
      `return (${scrollContextFn.toString()})(${Number(x)}, ${Number(y)});})()`,
    returnByValue: true,
  }).catch(() => null);
  const value = read && read.result && read.result.value;
  return value && Array.isArray(value.scrollers)
    ? value
    : { hit: null, scrollers: [] };
}

// How far the chain under the point can still travel the way the wheel is about to push it.
function scrollRoom(context, deltaY) {
  return context.scrollers.reduce(
    (total, [, top, max]) =>
      total + (deltaY > 0 ? Math.max(0, max - top) : Math.max(0, top)),
    0,
  );
}

async function scrollOffsets(tabId, x, y) {
  const read = await sendCdp(tabId, "Runtime.evaluate", {
    expression:
      `(function(){${SCROLLER_PATH_SOURCE}` +
      `return (${scrollOffsetsFn.toString()})(${Number(x)}, ${Number(y)});})()`,
    returnByValue: true,
  });
  const offsets = read && read.result && read.result.value;
  if (!Array.isArray(offsets)) {
    throw new Error("Could not read the page's scroll position.");
  }
  return offsets;
}

// How far the offsets moved in total: the scroller that took the wheel is the one that changed,
// and a chain that handed the scroll on (an inner scroller at its end) moved the outer one. Matched
// by name, never by position: the chain under the point can change as the page moves, and
// subtracting position by position would then subtract one scroller's offset from another's.
function scrollDistance(before, after) {
  const was = new Map(before.map(([name, left, top]) => [name, [left, top]]));
  let x = 0;
  let y = 0;
  for (const [name, left, top] of after) {
    const previous = was.get(name);
    if (previous) {
      x += left - previous[0];
      y += top - previous[1];
    }
  }
  return { x: Math.round(x), y: Math.round(y) };
}

async function handleScroll(session, tabId, args) {
  await ensureAttached(session, tabId);
  const amount = scrollAmountPx(args.amount);
  const deltaY = scrollDirection(args.direction) === "up" ? -amount : amount;
  let point;
  if (typeof args.backendNodeId === "number") {
    requireSnapshotTab(session, tabId);
    point = await resolveActionPoint(tabId, args.backendNodeId);
    // The box is read after the page has settled, but a page can move for reasons of its own
    // between that read and this wheel. Ask the element, and take the box once more if it says
    // the point has slipped off it.
    let landing = await pointLandsOn(
      tabId,
      args.backendNodeId,
      point.x,
      point.y,
    );
    if (landing.known && !landing.onTarget) {
      point = await resolveActionPoint(tabId, args.backendNodeId);
      landing = await pointLandsOn(tabId, args.backendNodeId, point.x, point.y);
    }
    if (landing.known && !landing.onTarget) {
      throw new Error(
        "The scroll could not be aimed at " +
          (landing.target || "that element") +
          ": the point on it (" +
          Math.round(point.x) +
          ", " +
          Math.round(point.y) +
          ") lands on " +
          (landing.hit || "nothing") +
          " instead. Something is drawn over it, or the page is still moving " +
          "under it; take a fresh snapshot and try again.",
      );
    }
  } else {
    // The point decides WHICH scroller receives the wheel event, so a made-up one scrolls a
    // container the caller never named. A viewport that cannot be read is not a viewport of
    // 800x600 sitting at (200,200); it is an unknown, and the scroll cannot be placed.
    const metrics = await sendCdp(tabId, "Page.getLayoutMetrics", {});
    // The CSS metrics only: the other members are device pixels, and placing the wheel at those
    // coordinates would put it outside the viewport on any scaled display.
    const vp = metrics && metrics.cssVisualViewport;
    if (!vp || !(vp.clientWidth > 0) || !(vp.clientHeight > 0)) {
      throw new Error(
        "Could not read the viewport to place the scroll; take a fresh snapshot.",
      );
    }
    point = { x: vp.clientWidth / 2, y: vp.clientHeight / 2 };
  }
  const before = await scrollOffsets(tabId, point.x, point.y);
  // Read before the wheel: afterwards the room has already been spent and cannot say what the
  // wheel had to work with.
  const context = await scrollContext(tabId, point.x, point.y);
  await moveAgentCursor(tabId, point.x, point.y);
  // Armed before the wheel so the listener is in place when the scroll starts: the debugger
  // delivers commands in the order they are sent.
  const ended = armScrollEnd(tabId, point.x, point.y, before);
  await dispatchMouse(tabId, "mouseWheel", point.x, point.y, {
    deltaX: 0,
    deltaY,
  });
  const started = Date.now();
  const rested = await Promise.race([
    ended,
    pageDelay(tabId, SCROLL_END_TIMEOUT_MS).then(
      () => null,
      () => null,
    ),
  ]);
  // Rested where the page said, or wherever it is now if no end came.
  const room = scrollRoom(context, deltaY);
  let after = rested || (await scrollOffsets(tabId, point.x, point.y));
  // Matched name by name, as scrollDistance and the in-page watcher are: the chain under the point
  // changes composition as content moves, and an entry appearing or leaving is not movement.
  const moved = scrollMovedFn(before, after);
  let settled = Boolean(rested);
  if (!settled && !moved && room > 0) {
    // Nothing moved, and there WAS somewhere to go that way -- so this is not an edge. Either the
    // wheel has not been acted on yet (a big delta on a heavily zoomed page is animated) or it
    // never reached the scroller. Waiting tells those apart, where reporting rest here told the
    // caller the page had finished moving when it had not started.
    //
    // Whichever it was, the page is at rest by the time this returns: it either moved and then
    // settled, or the grace expired with nothing moving. `scrolled` is measured from the offsets
    // below, so the distance follows whatever actually happened.
    after = await awaitScrollStart(tabId, point.x, point.y, before);
    settled = true;
  } else if (!settled) {
    // Nothing moved and nowhere to go: an edge already reached, which IS rest, and `scrolled` and
    // `room` together say so.
    settled = !moved;
  }
  return {
    ok: true,
    deltaY,
    scrolled: scrollDistance(before, after),
    settled,
    waited_ms: Date.now() - started,
    // What the wheel was aimed at and what it had to work with. scrolled 0 with room left is a
    // wheel that never reached the scroller; scrolled 0 with no room is an edge already reached.
    point: { x: Math.round(point.x), y: Math.round(point.y) },
    hit: context.hit,
    room,
  };
}

// -- what the page said, and what it fetched -----------------------------------
//
// Both are read-only: they report what was already recorded by the event handler above and change
// nothing about the page. They exist because the alternative an agent reaches for is arbitrary
// JavaScript evaluation, which would void most of this project's defenses at once -- an eval can
// read storage outside the isolated world, redefine window.confirm past the dialog policy, click
// without any of the freshness gating, and delete the AI CONTROL overlay that is the user's only
// signal that a session is driving. These answer the questions eval is usually asked for, without
// handing the page's own capabilities to the model.

function boundedTail(entries, limit) {
  const count = Math.max(1, Math.min(limit, entries.length));
  return entries.slice(entries.length - count);
}

async function handleConsole(session, tabId, args) {
  const tab = tabStateOf(session, tabId);
  await ensureAttached(session, tabId);
  const limit = boundedCount(
    args && args.limit,
    50,
    1,
    MAX_CONSOLE_ENTRIES,
    "browser_console limit",
  );
  const levels =
    args && args.level !== undefined && args.level !== null
      ? String(args.level).trim().toLowerCase()
      : "";
  // A level the caller names but that nothing produces is not an error; it is an empty answer.
  // A level that is not a level at all IS an error: silently returning everything would answer a
  // different question than the one asked.
  const known = ["error", "warning", "info", "log", "debug"];
  if (levels !== "" && known.indexOf(levels) < 0) {
    throw new Error(
      "browser_console level must be one of: " + known.join(", ") + ".",
    );
  }
  const matching = levels
    ? tab.consoleEntries.filter((entry) => entry.level === levels)
    : tab.consoleEntries;
  const shown = boundedTail(matching, limit);
  const reply = {
    ok: true,
    entries: shown,
    // What is being left out, said plainly in both directions: older entries this reply did not
    // carry, and entries the ring had already discarded. "No errors" and "the errors scrolled
    // off" must never read the same.
    total: matching.length,
    omitted: Math.max(0, matching.length - shown.length),
    dropped: tab.consoleDropped,
  };
  if (args && args.clear === true) {
    tab.consoleEntries = [];
    tab.consoleDropped = 0;
    reply.cleared = true;
  }
  return reply;
}

async function handleNetwork(session, tabId, args) {
  const tab = tabStateOf(session, tabId);
  await ensureAttached(session, tabId);
  const limit = boundedCount(
    args && args.limit,
    50,
    1,
    MAX_NETWORK_ENTRIES,
    "browser_network limit",
  );
  const onlyFailed = Boolean(args && args.failed_only === true);
  const matching = onlyFailed
    ? tab.networkEntries.filter(
        (entry) =>
          entry.failed || (entry.status !== null && entry.status >= 400),
      )
    : tab.networkEntries;
  const shown = boundedTail(matching, limit);
  const reply = {
    ok: true,
    requests: shown,
    total: matching.length,
    omitted: Math.max(0, matching.length - shown.length),
    dropped: tab.networkDropped,
    // Requests that have not answered yet. Without this, a reply listing nothing reads as "the
    // page asked for nothing" when it may simply still be waiting.
    in_flight: tab.networkPending.size,
  };
  if (args && args.clear === true) {
    tab.networkEntries = [];
    tab.networkDropped = 0;
    reply.cleared = true;
  }
  return reply;
}

// -- dialogs -----------------------------------------------------------------
//
// Dialogs are answered automatically by the onEvent handler above so the page never wedges.
// This tool ARMS the response for the NEXT dialog (one-shot) -- use action "accept" before
// the action that pops a confirm()/prompt() you want accepted (with optional text for a
// prompt) -- and reports the last dialog the extension handled. An arm is bound to the document
// it was armed against, so an embedded third-party frame cannot consume it.

// Is the frame that opened a dialog the document the response was armed against? A real origin
// compares as an origin (a same-origin subframe is still the same document's script); an opaque
// origin has none, so the exact document URL must match instead.
function dialogSourceMatches(frameUrl, armedOrigin) {
  if (!frameUrl || !armedOrigin) {
    return false;
  }
  const frameOrigin = originOf(frameUrl);
  return frameOrigin ? frameOrigin === armedOrigin : frameUrl === armedOrigin;
}

async function handleDialog(session, tabId, args) {
  const tab = tabStateOf(session, tabId);
  await ensureAttached(session, tabId);
  // "dismiss" is the documented default, but an unrecognized action is a request we do not
  // understand -- answering it as a dismiss would silently substitute a different answer.
  const action =
    args && args.action !== undefined && args.action !== null
      ? String(args.action)
      : "dismiss";
  if (action !== "accept" && action !== "dismiss") {
    throw new Error('browser_dialog action must be "accept" or "dismiss".');
  }
  const text = args && typeof args.text === "string" ? args.text : undefined;
  // Bind the arm to the document being driven so a third-party iframe in the same tab cannot
  // consume it (see dialogSourceMatches).
  const info = await tabInfo(tabId);
  if (!info.url) {
    throw new Error(
      "browser_dialog could not identify the tab's document to bind the response " +
        "to; take a fresh snapshot.",
    );
  }
  tab.pendingDialogPolicy = {
    accept: action === "accept",
    text,
    origin: originOf(info.url) || info.url,
  };
  return {
    ok: true,
    armed: action,
    last_dialog: tab.lastDialog,
  };
}

// -- navigation + tabs (via chrome.tabs, no debugger banner) ------------------

function normalizeUrl(raw) {
  const url = String(raw || "").trim();
  // Only http(s): never let the model drive the tab to javascript:/data:/file:.
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  if (/^[\w.-]+\.[a-z]{2,}(\/|$|:)/i.test(url)) {
    return "https://" + url;
  }
  return null;
}

// Whether a tab read AFTER the listener attached shows the requested navigation already finished.
// "complete" on its own is not enough: between asking for a navigation and reading the tab, the
// browser may not have started it yet, and the old document is "complete" too -- settling on that
// reports the page the caller navigated AWAY from as the loaded new one. So a pending navigation
// disqualifies the read, and the url must no longer be the pre-navigation one. priorUrl null means
// a freshly created tab, which has no previous document to be confused with; there any non-empty
// url is the requested navigation having landed.
function tabSettledAt(tab, priorUrl) {
  if (!tab || tab.status !== "complete" || tab.pendingUrl) {
    return false;
  }
  if (priorUrl === null) {
    return typeof tab.url === "string" && tab.url.length > 0;
  }
  // The previous document could not be read, so "this is no longer it" cannot be established.
  // The listener still covers the load; only this shortcut is withheld.
  if (typeof priorUrl !== "string") {
    return false;
  }
  return tab.url !== priorUrl;
}

// Wait for a navigation just requested on tabId to finish. priorUrl is the url the tab showed
// before the request (null for a tab created for this navigation); see tabSettledAt.
//
// Resolves TRUE when the tab reported a completed load, FALSE when the navigation timeout ran out
// first. The two outcomes are not the same fact, and a caller that cannot tell them apart reports
// a load that never finished exactly like one that did. Rejects when the tab itself cannot be
// read, which is neither outcome.
function waitForComplete(tabId, priorUrl) {
  return new Promise((resolve, reject) => {
    let done = false;
    // The deadline timer is held so a completed load can cancel it. Left running, every navigate,
    // back/forward and reload pins its listener and this closure alive for the rest of the
    // 15 s window -- in a service worker that is also a keepalive nothing asked for.
    let timer = null;
    const settle = (fn, value) => {
      if (done) {
        return;
      }
      done = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      chrome.tabs.onUpdated.removeListener(listener);
      fn(value);
    };
    const finish = (completed) => settle(resolve, completed);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        finish(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // On this worker's clock, which Chrome coalesces while it is in the background: the page
    // that would keep better time is the one being replaced by this very navigation, so there is
    // none to ask. A late deadline only reports a load that never completed later than it could.
    timer = setTimeout(() => finish(false), NAV_TIMEOUT_MS);
    // A load that finished between the caller requesting it and this listener attaching fires no
    // further event, so the listener alone would sit out the whole 15 s window and then report
    // load_complete:false for a page that IS loaded -- a false statement about the page, not a
    // slow one. Reading the tab once the listener is attached closes that window from the other
    // side: the listener covers everything completing from here on, this read covers anything
    // that completed before it, and neither can miss it.
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tabSettledAt(tab, priorUrl)) {
          finish(true);
        }
      },
      // A tab that cannot be read (closed mid-navigation) will never complete either. Waiting out
      // the deadline to then call it "did not finish loading" describes the page; the tab being
      // gone is what actually happened, so it is what the caller is told.
      (e) => settle(reject, e instanceof Error ? e : new Error(String(e))),
    );
  });
}

// Takes the session it is acting for like every other handler, even though it
// needs nothing from it: dispatchCommand passes it positionally, so a handler
// that omits it receives the session as its tabId and the tab id as its args.
// That is not a type error in JavaScript -- it surfaces as args.url being
// undefined, and the caller is told its perfectly good URL is not http(s).
async function handleNavigate(_session, tabId, args) {
  const url = normalizeUrl(args && args.url);
  if (!url) {
    throw new Error("navigate requires an http(s) URL.");
  }
  // Read the outgoing document before asking for the new one, so the wait can tell "the new page
  // is already up" from "the old page is still up because the navigation has not started".
  const before = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { url });
  // load_complete carries whether the page actually finished loading. Without it a hung or very
  // slow navigation is indistinguishable from a completed one, and the model reads a partial
  // page as the final one.
  const loaded = await waitForComplete(tabId, before.url);
  const info = await tabInfo(tabId);
  return { ok: true, url: info.url, title: info.title, load_complete: loaded };
}

async function handleHistory(session, tabId, direction) {
  const tab = await chrome.tabs.get(tabId);
  if (direction === "back") {
    await chrome.tabs.goBack(tab.id);
  } else {
    await chrome.tabs.goForward(tab.id);
  }
  const loaded = await waitForComplete(tab.id, tab.url);
  const info = await tabInfo(tab.id);
  return { ok: true, url: info.url, title: info.title, load_complete: loaded };
}

async function handleReload(_session, tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.reload(tab.id);
  // A reload lands on the same url it started from, so the pre-navigation url never stops
  // matching and the wait rests entirely on the completion event -- which a reload always fires.
  const loaded = await waitForComplete(tab.id, tab.url);
  const info = await tabInfo(tab.id);
  return { ok: true, url: info.url, title: info.title, load_complete: loaded };
}

// Caps for the tab listing. Titles and URLs are page-controlled (history.pushState rewrites both
// at will) and this tool is read-only, so its reply reaches the model with no confirmation: an
// uncapped listing puts unbounded page-chosen strings into that context and can outgrow the
// relay's frame. The per-string caps mirror kMaxUrlChars/kMaxTitleChars on the C++ side.
const MAX_LIST_TABS = 100;
const MAX_TAB_TITLE_CHARS = 300;
const MAX_TAB_URL_CHARS = 2048;

// Write one capped, page-controlled string onto an entry, marking the cut when it bites -- a
// silently sliced title or URL reads to the model as the whole thing.
function capField(entry, key, raw, cap) {
  const s = String(raw || "");
  entry[key] = s.length > cap ? s.slice(0, cap) : s;
  if (s.length > cap) {
    entry[key + "_truncated"] = true;
  }
}

async function handleListTabs(session) {
  const tabs = (
    await chrome.tabs.query({ windowId: await sessionWindow(session) })
  ).sort((a, b) => a.index - b.index);
  const groupTitles = new Map();
  const list = [];
  for (const t of tabs.slice(0, MAX_LIST_TABS)) {
    const entry = {
      index: t.index,
      id: t.id,
      tab_id: t.id, // the name every tab-scoped tool's tab_id takes; `id` is kept for older callers
      active: Boolean(t.active),
    };
    // Say which tabs are this session's, and which another session is driving rather than hiding
    // them. The operator can see the whole window either way; what changes is that acting on one
    // held elsewhere is refused, and a listing that showed no reason for that would read as a bug.
    const own = session.tabs.get(t.id);
    if (own) {
      entry.held = true;
      entry.opened_by_session = own.origin === "opened";
      if (own.agent) {
        entry.agent = own.agent;
      }
      if (t.id === session.currentTabId) {
        entry.current = true;
      }
    } else if (leaseHolder(t.id, session)) {
      entry.controlled_by_other_session = true;
    }
    capField(entry, "title", t.title, MAX_TAB_TITLE_CHARS);
    capField(entry, "url", t.url, MAX_TAB_URL_CHARS);
    if (typeof t.groupId === "number" && t.groupId >= 0) {
      entry.group_id = t.groupId;
      if (!groupTitles.has(t.groupId)) {
        try {
          const g = await chrome.tabGroups.get(t.groupId);
          groupTitles.set(t.groupId, g.title || "");
        } catch (_e) {
          groupTitles.set(t.groupId, "");
        }
      }
      capField(entry, "group", groupTitles.get(t.groupId), MAX_TAB_TITLE_CHARS);
    }
    list.push(entry);
  }
  // Remember which tab each index named, so an index-addressed action can prove it still names
  // that same tab, in that same window, before it acts. Only the LISTED tabs are remembered: an
  // index past the cap was never shown to the model, so it names nothing it could have confirmed.
  session.lastTabListing = {
    windowId: tabs.length ? tabs[0].windowId : null,
    entries: list.map((e) => ({ index: e.index, id: e.id })),
  };
  // Every tab the session holds, wherever it is: an agent working in two windows still sees its
  // own tabs from either one, by the tab_id it acts on them with.
  const yours = [];
  for (const state of session.tabs.values()) {
    const tab = await chrome.tabs.get(state.id).catch(() => null);
    if (!tab) {
      continue;
    }
    const entry = { tab_id: tab.id, window_id: tab.windowId };
    if (state.agent) {
      entry.agent = state.agent;
    }
    if (tab.id === session.currentTabId) {
      entry.current = true;
    }
    capField(entry, "title", tab.title, MAX_TAB_TITLE_CHARS);
    capField(entry, "url", tab.url || tab.pendingUrl, MAX_TAB_URL_CHARS);
    yours.push(entry);
  }
  return {
    tabs: list,
    count: tabs.length,
    capped: tabs.length > MAX_LIST_TABS,
    your_tabs: yours,
  };
}

// An index-addressed tab action is meaningful only against the listing the model read. A tab id
// is the tab's stable identity for its whole lifetime, so compare THAT: if the tab now sitting
// at the index is a different tab -- or the query resolved a different window than the one that
// was listed -- the index no longer names what the operator confirmed.
function requireListedTab(session, tab) {
  if (
    !session.lastTabListing ||
    session.lastTabListing.windowId !== tab.windowId
  ) {
    throw new Error(
      "There is no current tab listing for this window; call browser_tabs before acting on a " +
        "tab index.",
    );
  }
  const listed = session.lastTabListing.entries.find(
    (e) => e.index === tab.index,
  );
  if (!listed || typeof tab.id !== "number" || listed.id !== tab.id) {
    throw new Error(
      "The tabs moved since the last listing (index " +
        tab.index +
        " is a different tab now); " +
        "call browser_tabs again before acting on a tab index.",
    );
  }
}

const GROUP_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

// Resolve a comma-separated zero-based tab-index spec to tab ids; default to the active tab.
async function tabIdsFromIndices(session, spec) {
  const tabs = await chrome.tabs.query({
    windowId: await sessionWindow(session),
  });
  if (spec === undefined || spec === null || String(spec).trim() === "") {
    const active = tabs.find((t) => t.active);
    if (!active) {
      throw new Error("No active tab to group.");
    }
    return [active.id];
  }
  // Every token has to name a tab. Dropping the ones that do not parse would act on a SUBSET of
  // what was confirmed, and an empty token is worse than that: Number("") is 0, so "0,,1" or a
  // trailing comma would fabricate tab index 0 -- a tab the caller never named.
  const indices = String(spec)
    .split(",")
    .map((token) => {
      const trimmed = token.trim();
      const n = Number(trimmed);
      if (trimmed === "" || !Number.isInteger(n) || n < 0) {
        throw new Error(
          'tab_indices must be comma-separated non-negative integers, e.g. "0,1" (got "' +
            trimmed +
            '").',
        );
      }
      return n;
    });
  const ids = [];
  for (const idx of indices) {
    const t = tabs.find((x) => x.index === idx);
    if (!t) {
      throw new Error("No tab at index " + idx + ".");
    }
    requireListedTab(session, t);
    ids.push(t.id);
  }
  return ids;
}

async function handleGroupTabs(session, args) {
  const tabIds = await tabIdsFromIndices(session, args && args.tab_indices);
  expectGroupChange(tabIds); // the agent arranging tabs is not the user taking one back
  const groupId = await chrome.tabs.group({ tabIds });
  session.lastTabListing = null; // grouping moves tabs together: every index after this is unproven
  const update = {};
  if (args && typeof args.title === "string" && args.title.length > 0) {
    update.title = args.title;
  }
  // A color Chrome does not know is not a color it silently keeps: ignoring it would leave the
  // group whatever shade Chrome picked while the caller believes it named one.
  if (args && typeof args.color === "string") {
    if (!GROUP_COLORS.has(args.color)) {
      throw new Error(
        "browser_group_tabs color must be one of: " +
          Array.from(GROUP_COLORS).join(", ") +
          ".",
      );
    }
    update.color = args.color;
  }
  if (Object.keys(update).length > 0) {
    await chrome.tabGroups.update(groupId, update);
  }
  // The group's title/color are reported as BROWSER state, so they have to come from the browser.
  // Falling back to the requested values on a failed read would echo the request back as if it
  // had been observed, which is the one thing a read-back exists to rule out.
  const group = await chrome.tabGroups.get(groupId);
  return {
    ok: true,
    group_id: groupId,
    title: group.title || "",
    color: group.color || "",
    tab_count: tabIds.length,
  };
}

async function handleUngroupTabs(session, args) {
  const tabIds = await tabIdsFromIndices(session, args && args.tab_indices);
  expectGroupChange(tabIds); // the agent arranging tabs is not the user taking one back
  await chrome.tabs.ungroup(tabIds);
  session.lastTabListing = null; // ungrouping moves tabs out of the group: the indices are unproven
  return { ok: true, ungrouped: tabIds.length };
}

async function tabByIndex(session, index) {
  const tabs = await chrome.tabs.query({
    windowId: await sessionWindow(session),
  });
  const tab = tabs.find((t) => t.index === index);
  if (!tab) {
    throw new Error("No tab at index " + index + ".");
  }
  requireListedTab(session, tab);
  return tab;
}

// Text bound for the tab strip, by the server's own rule for agent names: control and format
// characters (a bidi override would reorder the title), unassigned code points, lone surrogates
// and line or paragraph separators are dropped, and the length is counted in code points, so a cut
// never splits a surrogate pair. Any script survives: stripping to ASCII turned "café" into "caf"
// and a name with no ASCII at all into none, which put that agent's tabs in the shared group.
function tabStripText(text, maxChars) {
  return Array.from(text.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").trim())
    .slice(0, maxChars)
    .join("")
    .trim();
}

// The agent name a tool call gave, as the group key it becomes, or undefined when none was given.
// The server validates it; this is the second, local bound on what reaches the tab strip.
function agentArg(args) {
  if (!args || typeof args.agent !== "string") {
    return undefined;
  }
  return tabStripText(args.agent, 24) || undefined;
}

async function handleSelectTab(session, args) {
  requireNotRecording(session, "browser_select_tab");
  const named = args ? args.tab_id : undefined;
  let tab;
  if (named !== undefined && named !== null) {
    if (!Number.isInteger(named) || named <= 0) {
      throw new Error("tab_id must be a positive integer.");
    }
    tab = await chrome.tabs.get(named).catch(() => null);
    if (!tab) {
      throw new Error("There is no tab " + named + ".");
    }
  } else {
    tab = await tabByIndex(session, Number(args && args.index));
  }
  requireUnleasedTab(session, tab);
  // Retarget the session -- and nothing else. The tab is NOT activated: its window shows the tab
  // the user chose to look at, and the session drives this one in the background over the
  // debugger protocol. Neither the tab nor its window is brought forward. The tab is held from
  // here on (a tab of the user's is borrowed, and handed back when the session is done).
  setCurrentTab(session, tab, agentArg(args));
  session.actedTabId = tab.id;
  const info = await tabInfo(tab.id);
  return {
    ok: true,
    index: tab.index,
    tab_id: tab.id,
    url: info.url,
    title: info.title,
  };
}

async function handleNewTab(session, args) {
  requireNotRecording(session, "browser_new_tab");
  // A supplied url must be usable. Letting a blank one through opens a blank tab under the guise
  // of having honored the request, which is not the tab the caller asked for.
  if (args && typeof args.url === "string" && args.url.trim().length === 0) {
    throw new Error("newTab url must be http(s).");
  }
  const url = args && args.url ? normalizeUrl(args.url) : null;
  if (args && args.url && !url) {
    throw new Error("newTab url must be http(s).");
  }
  // Open it in the session's window, in the BACKGROUND, and make it the session's tab. The tab
  // the user is looking at stays in front; the session drives this one over the debugger
  // protocol without it ever being shown. Creating it without a window would put it in whichever
  // window the user focused last.
  //
  // With no url it opens on about:blank rather than Chrome's new-tab page: the debugger may not
  // attach to the new-tab page, so a tab opened there could be neither marked as the assistant's
  // nor driven until it had been navigated somewhere else first.
  const tab = await chrome.tabs.create({
    windowId: await sessionWindow(session),
    active: false,
    url: url || "about:blank",
  });
  // Held as one the session opened -- so it is closed when the session is done with it -- in the
  // group of the agent that asked for it.
  holdTab(session, tab, "opened", agentArg(args));
  setCurrentTab(session, tab);
  session.actedTabId = tab.id;
  session.lastTabListing = null; // a new tab shifts what an index names
  // chrome.tabs.create resolves the moment the tab EXISTS -- the target is still in pendingUrl
  // and url is empty. Reporting the requested url here would state that the tab is at a page no
  // load has been attempted for, so wait for the load and report what the tab actually shows
  // (a redirect, an interstitial, or a failed navigation all say so on their own).
  let loaded = true;
  if (url) {
    // null: a tab created for this navigation has no previous document, so any settled url is
    // this load having landed. waitForComplete re-reads the tab after attaching its listener,
    // which is what makes a load that finished before the wait began report as complete instead
    // of sitting out the navigation timeout and then denying it loaded.
    loaded = await waitForComplete(tab.id, null);
  }
  const now = await chrome.tabs.get(tab.id);
  return {
    ok: true,
    tab_id: tab.id,
    index: now.index,
    url: now.url || now.pendingUrl || "",
    title: now.title || "",
    load_complete: loaded,
  };
}

// Close the tab named by tab_id (one this session holds), by index (from the last listing), or the
// session's current tab. Never a tab another session is driving.
async function handleCloseTab(session, args) {
  const named = args ? args.tab_id : undefined;
  let tab;
  if (named !== undefined && named !== null) {
    if (!Number.isInteger(named) || named <= 0) {
      throw new Error("tab_id must be a positive integer.");
    }
    tab = await heldTab(session, named);
  } else if (args && args.index !== undefined && args.index !== null) {
    tab = await tabByIndex(session, Number(args.index));
    requireUnleasedTab(session, tab);
  } else {
    tab = await activeTab(session);
  }
  session.actedTabId = tab.id;
  await chrome.tabs.remove(tab.id);
  // Let go of it now rather than when tabs.onRemoved gets round to it, so THIS reply already tells
  // the server to drop the refs bound to it.
  await dropTab(session, tab.id, { closed: true });
  session.lastTabListing = null; // every index after the closed one has shifted
  return { ok: true, index: tab.index, tab_id: tab.id };
}

// -- browser windows (chrome.windows) ----------------------------------------
//
// A model-opened link can spawn a popup or a new window; browser_windows lists them (and
// browser_tabs lists the tabs inside) so nothing opened off-screen is invisible. window CRUD
// mutates the browser (opening/closing windows), so it is gated at the normal-confirm tier.

async function handleListWindows(session) {
  const wins = await chrome.windows.getAll({ populate: true });
  // Only what the browser actually supplied. A missing type reported as "normal" is a claim about
  // a window nobody read, and an absent tabs array reported as tab_count 0 describes a populated
  // window as empty -- the operator then closes what looks like an empty window.
  const list = wins.map((w) => {
    const entry = {
      window_id: w.id,
      focused: Boolean(w.focused),
      incognito: Boolean(w.incognito),
    };
    if (typeof w.type === "string") {
      entry.type = w.type;
    }
    if (typeof w.state === "string") {
      entry.state = w.state;
    }
    if (Array.isArray(w.tabs)) {
      entry.tab_count = w.tabs.length;
    }
    return entry;
  });
  // Remember which ids were actually shown, so a focus/close can prove the id it was given names
  // a window the caller was told about rather than one it produced on its own.
  session.lastWindowListing = new Set(list.map((w) => w.window_id));
  return { windows: list };
}

// How long a new window is watched for a compositor-granted focus. The window maps and the
// compositor answers within roughly a frame or two; a focus that lands after this is attributed to
// the user rather than to the window being opened.
const NEW_WINDOW_FOCUS_SETTLE_MS = 750;

// The Chrome window holding OS focus, or null when the user is working in another application.
async function osFocusedWindowId() {
  const wins = await chrome.windows.getAll().catch(() => []);
  const focused = wins.find((w) => w.focused);
  return focused ? focused.id : null;
}

// Whether windowId takes OS focus within timeoutMs. Focus arrives asynchronously on Wayland and
// macOS, so a single read straight after create() would miss it. Timed by the new window's own
// page where there is one: this worker's clock, coalesced in the background, drew the watch out
// to eleven seconds on a Mac where the answer is always no.
function windowGainsOsFocus(windowId, timeoutMs, tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      chrome.windows.onFocusChanged.removeListener(listener);
      resolve(value);
    };
    const listener = (focusedId) => {
      if (focusedId === windowId) {
        finish(true);
      }
    };
    let timer = null;
    if (typeof tabId === "number") {
      pageDelay(tabId, timeoutMs).then(
        () => finish(false),
        () => finish(false), // the page went away; it cannot be watched any longer either
      );
    } else {
      timer = setTimeout(() => finish(false), timeoutMs);
    }
    chrome.windows.onFocusChanged.addListener(listener);
    // It may already hold focus by the time the listener is attached.
    chrome.windows
      .get(windowId)
      .then((w) => {
        if (w && w.focused) {
          finish(true);
        }
      })
      .catch(() => {});
  });
}

// A window action is meaningful only against a window the caller has been shown. Chrome window
// ids are small sequential integers, so an invented or stale one readily names somebody's live
// window -- and "close" takes it and its tabs down.
function requireListedWindow(session, windowId) {
  if (!session.lastWindowListing || !session.lastWindowListing.has(windowId)) {
    throw new Error(
      "Window " +
        windowId +
        " is not in the current window listing; call " +
        "browser_windows before acting on a window id.",
    );
  }
}

// The window as it exists right now, so the reply attributes the action to something observed
// rather than to the bare integer that was confirmed.
async function windowFacts(windowId) {
  const win = await chrome.windows.get(windowId, { populate: true });
  const facts = {};
  if (typeof win.type === "string") {
    facts.type = win.type;
  }
  if (Array.isArray(win.tabs)) {
    facts.tab_count = win.tabs.length;
  }
  return facts;
}

async function handleWindow(session, args) {
  const action = String((args && args.action) || "").toLowerCase();
  if (action !== "new" && action !== "focus" && action !== "close") {
    throw new Error("browser_window action must be new, focus, or close.");
  }
  if (action !== "close") {
    // new and focus both retarget the session; close does not.
    requireNotRecording(session, "browser_window " + action);
  }
  if (action === "new") {
    // A standard browser window (Chrome's extension API does not reliably honor a popup type
    // for a navigated window, so we do not expose one). An optional URL opens it there.
    const url = args && args.url ? normalizeUrl(args.url) : null;
    if (args && args.url && !url) {
      throw new Error("browser_window new url must be http(s).");
    }
    // focused:false -- the window opens without taking OS focus from whatever the user is
    // working in. It becomes the session's window all the same. Windows, macOS, and X11 honor
    // that; a Wayland compositor decides focus itself, and some (Hyprland by default) focus every
    // newly mapped window regardless, so the outcome is observed and reported, never assumed.
    const osFocusBefore = await osFocusedWindowId();
    // about:blank rather than the new-tab page when no url is given, for the reason handleNewTab
    // gives: the debugger may not attach to the new-tab page.
    const win = await chrome.windows.create({
      focused: false,
      url: url || "about:blank",
    });
    const firstTab = (win.tabs && win.tabs[0]) || null;
    // The window and its tab are the session's own: held as opened, so they close when the session
    // is done with them, and made current.
    if (firstTab) {
      holdTab(session, firstTab, "opened", agentArg(args));
      setCurrentTab(session, firstTab);
      session.actedTabId = firstTab.id;
    }
    // Attached first: the watch below is timed by this page, and an unattached tab cannot time it --
    // the watch would collapse to nothing and report a focus nobody waited for.
    const watched =
      firstTab &&
      (await ensureAttached(session, firstTab.id).then(
        () => true,
        () => false,
      ))
        ? firstTab.id
        : null;
    const tookOsFocus =
      osFocusBefore !== win.id &&
      (await windowGainsOsFocus(win.id, NEW_WINDOW_FOCUS_SETTLE_MS, watched));
    // A window this session just opened is one the caller has been told about, so it can be
    // named next without a re-listing.
    if (!session.lastWindowListing) {
      session.lastWindowListing = new Set();
    }
    session.lastWindowListing.add(win.id);
    const created = {
      ok: true,
      window_id: win.id,
      tab_index: firstTab ? firstTab.index : null,
      took_os_focus: tookOsFocus,
    };
    if (typeof win.type === "string") {
      created.type = win.type;
    } // never a fabricated "normal"
    return created;
  }
  const windowId = Number(args && args.window_id);
  if (!Number.isInteger(windowId)) {
    throw new Error(
      "browser_window needs window_id for focus/close (see browser_windows).",
    );
  }
  requireListedWindow(session, windowId);
  const facts = await windowFacts(windowId);
  if (action === "focus") {
    // Make this window the session's working window: its active tab becomes the target of every
    // later command. It is deliberately NOT raised or given OS focus -- that would pull the user's
    // keyboard away from whatever they are doing -- and none is needed: the session drives the tab
    // over the debugger protocol, with focus emulated for the page (enableSessionDomains).
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab || typeof tab.id !== "number") {
      throw new Error("Window " + windowId + " has no active tab to control.");
    }
    requireUnleasedTab(session, tab);
    setCurrentTab(session, tab);
    session.actedTabId = tab.id;
    session.lastTabListing = null; // indices from another window's listing name nothing here
    return Object.assign(
      { ok: true, window_id: windowId, session_window: true },
      facts,
    );
  }
  await chrome.windows.remove(windowId); // action === "close"
  session.lastWindowListing.delete(windowId); // that window is gone; it can never be named again
  return Object.assign({ ok: true, window_id: windowId, closed: true }, facts);
}

// -- device emulation (Emulation domain) -------------------------------------
//
// Was this argument SUPPLIED? Distinguishing "absent" from "present but unusable" is what lets a
// malformed value be refused instead of quietly treated as though it had never been sent.
function argProvided(v) {
  return v !== undefined && v !== null;
}

// Emulate a device viewport / user-agent / touch for the active tab (responsive testing, UA
// gating, mobile layouts). Overrides are per-CDP-session, so they clear automatically when we
// detach (tab switch / disconnect); reset clears them explicitly and restores the real UA.
// Undo every override this tool can install. A clear that failed leaves the tab emulating -- a
// fake viewport, touch input, or a spoofed identity -- for the rest of the session. Swallowing
// that and answering ok:true reports the one state the caller must never be told without it being
// true, so let the failure surface.
async function resetEmulation(session, tabId) {
  const tab = tabStateOf(session, tabId);
  await sendCdp(tabId, "Emulation.clearDeviceMetricsOverride");
  await sendCdp(tabId, "Emulation.setTouchEmulationEnabled", {
    enabled: false,
  });
  if (tab.originalUserAgent) {
    await sendCdp(tabId, "Emulation.setUserAgentOverride", {
      userAgent: tab.originalUserAgent,
    });
  }
  tab.lastShot = null; // clearing the metrics relays the page out from under any screenshot
  // False only when no real UA was ever captured -- in which case no override could have been
  // installed either (see applyUserAgentOverride), so there is nothing left spoofed.
  return {
    ok: true,
    reset: true,
    user_agent_restored: Boolean(tab.originalUserAgent),
  };
}

// A viewport is width AND height together. Skipping the override because one of them was missing
// or non-positive leaves the tab laid out at a size nobody asked for, while the reply lists
// whatever else did apply -- so a metrics request that cannot be honored is refused rather than
// dropped, and a device_scale_factor is never quietly rewritten to 1.
async function applyDeviceMetrics(tabId, args, applied) {
  if (
    !argProvided(args.width) &&
    !argProvided(args.height) &&
    !argProvided(args.device_scale_factor)
  ) {
    return;
  }
  const w = Number(args.width);
  const h = Number(args.height);
  const dsf = Number(args.device_scale_factor);
  if (!(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)) {
    throw new Error(
      "browser_emulate needs both width and height as positive integers.",
    );
  }
  if (
    argProvided(args.device_scale_factor) &&
    !(Number.isFinite(dsf) && dsf > 0)
  ) {
    throw new Error(
      "browser_emulate device_scale_factor must be a positive number.",
    );
  }
  await sendCdp(tabId, "Emulation.setDeviceMetricsOverride", {
    width: Math.round(w),
    height: Math.round(h),
    deviceScaleFactor: Number.isFinite(dsf) && dsf > 0 ? dsf : 1,
    mobile: args.mobile === true,
  });
  applied.width = Math.round(w);
  applied.height = Math.round(h);
  applied.mobile = args.mobile === true;
  if (argProvided(args.device_scale_factor)) {
    applied.device_scale_factor = dsf;
  }
}

async function applyUserAgentOverride(session, tabId, args, applied) {
  const tab = tabStateOf(session, tabId);
  if (typeof args.user_agent !== "string" || args.user_agent.length === 0) {
    return;
  }
  // An override with no captured original cannot be undone; refuse it rather than pin an
  // identity on the tab that reset has no real value to restore.
  if (!tab.originalUserAgent) {
    throw new Error(
      "Cannot override the user agent: the browser's real user agent could not " +
        "be read, so the override could not be undone.",
    );
  }
  await sendCdp(tabId, "Emulation.setUserAgentOverride", {
    userAgent: args.user_agent,
  });
  // The full string is what was applied; the echo is capped. A silent slice reads back as the
  // whole override, so mark it the way every other capped field in this file does.
  applied.user_agent = args.user_agent.slice(0, 120);
  if (args.user_agent.length > 120) {
    applied.user_agent_truncated = true;
    applied.user_agent_length = args.user_agent.length;
  }
}

async function handleEmulate(session, tabId, args) {
  const tab = tabStateOf(session, tabId);
  await ensureAttached(session, tabId);
  if (tab.originalUserAgent === null) {
    // The real UA comes from THIS worker's own context, never from the page: navigator.userAgent
    // read in the page world is a value a hostile page can redefine, and reset would then install
    // that attacker-chosen string as a genuine override for the rest of the session.
    const ua =
      navigator && typeof navigator.userAgent === "string"
        ? navigator.userAgent
        : "";
    if (ua.length > 0) {
      tab.originalUserAgent = ua;
    }
  }
  if (args.reset === true) {
    return await resetEmulation(session, tabId);
  }
  const applied = {};
  await applyDeviceMetrics(tabId, args, applied);
  await applyUserAgentOverride(session, tabId, args, applied);
  if (typeof args.touch === "boolean") {
    // maxTouchPoints makes navigator.maxTouchPoints reflect touch live (the 'ontouchstart' in
    // window feature flag is fixed at page load, so it only flips after a reload).
    await sendCdp(tabId, "Emulation.setTouchEmulationEnabled", {
      enabled: args.touch,
      maxTouchPoints: args.touch ? 5 : 0,
    });
    applied.touch = args.touch;
  }
  if (Object.keys(applied).length === 0) {
    throw new Error(
      "browser_emulate needs width+height, user_agent, touch, or reset.",
    );
  }
  // Emulation relays the page out (a new viewport, a UA-gated variant): any outstanding
  // screenshot describes a render that no longer exists, so a coordinate click must not be
  // able to match its fingerprint.
  tab.lastShot = null;
  return { ok: true, applied };
}

// -- print to PDF (Page.printToPDF) ------------------------------------------
//
// Render the active tab to a PDF at the browser level (no OS print dialog, no printer).
// The base64 PDF rides back in the reply; the bridge decodes it, size-caps it, and writes
// the file to disk -- the extension never touches the filesystem. Backgrounds print by
// default (technicians usually want the page as it looks). Only well-formed numeric/enum
// options are forwarded, so a page can neither steer the output path nor inject options.
// A print option that is out of range is a request this layer cannot honor -- and it is the only
// layer that range-checks, since the C++ contract only type-checks. Dropping one renders the PDF
// at Chrome's default instead, which is a different document than the one that was asked for.
// Parse a numeric print option, throwing `err` unless it is finite and passes `isValid`. Pulling
// the finite/range check out keeps printPageOptions itself under the complexity limit.
function printNumber(value, isValid, err) {
  const n = Number(value);
  if (!Number.isFinite(n) || !isValid(n)) {
    throw new Error(err);
  }
  return n;
}

function printPageOptions(args) {
  const opts = { transferMode: "ReturnAsBase64" };
  if (typeof args.landscape === "boolean") {
    opts.landscape = args.landscape;
  }
  opts.printBackground = args.print_background !== false;
  if (args.scale !== undefined && args.scale !== null) {
    opts.scale = printNumber(
      args.scale,
      (n) => n >= 0.1 && n <= 2,
      "browser_print scale must be between 0.1 and 2.",
    );
  }
  const paper = [
    ["paper_width", "paperWidth"],
    ["paper_height", "paperHeight"],
  ];
  for (const [argName, optName] of paper) {
    if (args[argName] === undefined || args[argName] === null) {
      continue;
    }
    opts[optName] = printNumber(
      args[argName],
      (n) => n > 0,
      "browser_print " + argName + " must be a positive number of inches.",
    );
  }
  return opts;
}

async function handlePrint(session, tabId, args) {
  const tab = tabStateOf(session, tabId);
  await ensureAttached(session, tabId);
  const opts = printPageOptions(args);
  if (
    typeof args.page_ranges === "string" &&
    args.page_ranges.trim().length > 0
  ) {
    const ranges = args.page_ranges.trim();
    // Truncating a range spec prints a valid-but-DIFFERENT set of pages (a cut mid-token still
    // parses), and the reply would call that a success.
    if (ranges.length > 100) {
      throw new Error(
        "browser_print page_ranges is too long (max 100 characters).",
      );
    }
    opts.pageRanges = ranges;
  }
  // The document the operator approved printing is the one that was in front of them. A
  // meta-refresh, a JS redirect, or an ad frame navigating the top frame between that
  // confirmation and this round trip renders a DIFFERENT page into the file, and the reply would
  // present it as the print that was asked for. Bind the capture to the generation it started
  // against, the same way a snapshot is.
  const startEpoch = tab.domEpoch;
  const res = await sendCdp(tabId, "Page.printToPDF", opts);
  if (tab.domEpoch !== startEpoch) {
    throw new Error(
      "The page navigated while it was being printed; print it again.",
    );
  }
  const data = res && typeof res.data === "string" ? res.data : "";
  if (!data) {
    throw new Error("The browser returned an empty PDF.");
  }
  // Bound the payload where it is produced. A reply past the relay's frame cap does not come
  // back as an error at all: it fails the frame parse, tears the relay down, and the caller sees
  // a transport reset instead of the real reason. Mirror the bridge's own PDF cap so an
  // oversized print is reported as what it is, with the way out.
  if (data.length > MAX_PDF_BASE64) {
    throw new Error(
      "The printed PDF is too large to return; narrow it with page_ranges.",
    );
  }
  const info = await tabInfo(tabId);
  return { data, url: info.url, title: info.title };
}

// -- site permissions (chrome.contentSettings) -------------------------------
//
// Grant/block/reset a site permission (geolocation, notifications, camera, mic, ...) for an
// origin, so automation can pre-answer the permission prompts that would otherwise block a
// flow. Uses the native, origin-scoped contentSettings API rather than a tab-attached CDP
// Browser.* call (which is unreliable through chrome.debugger). Only a fixed allowlist of
// content types and settings is accepted and the origin is reduced to a validated http(s)
// pattern, so a page can neither widen its own grants nor steer the pattern.
const PERMISSION_TYPES = {
  geolocation: "location",
  notifications: "notifications",
  camera: "camera",
  microphone: "microphone",
  images: "images",
  javascript: "javascript",
  popups: "popups",
  automatic_downloads: "automaticDownloads",
};
const PERMISSION_SETTINGS = ["allow", "block", "ask"];

// What Chrome actually accepts, per type. "ask" is meaningful only where there is a prompt to
// show: javascript, images and popups are on-or-off, and asking for "ask" on them is rejected by
// the API rather than treated as a default. Anything not listed takes the full set.
const SETTINGS_BY_PERMISSION = {
  javascript: ["allow", "block"],
  images: ["allow", "block"],
  popups: ["allow", "block"],
};

// A single concrete host: a dotted name, or a bracketed IPv6 literal. "*" is NOT a forbidden
// host code point in the URL standard, so `new URL("https://*")` parses with host "*" -- and
// that host would reach chrome.contentSettings as the pattern "https://*/*", which grants the
// permission on EVERY https origin in the profile. A permission is scoped to one site by
// definition, so anything that is not one host is refused rather than widened.
const CONCRETE_HOST =
  /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i;

// Reduce an origin or full URL to an origin match pattern ("https://host:port/*"); returns
// null for anything that is not http(s) on a single concrete host.
function originPattern(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_error) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (!CONCRETE_HOST.test(parsed.hostname)) {
    return null;
  }
  return parsed.protocol + "//" + parsed.host + "/*";
}

async function handlePermission(session, args) {
  const typeKey =
    PERMISSION_TYPES[String((args && args.name) || "").toLowerCase()];
  if (!typeKey) {
    throw new Error(
      "browser_permission name must be one of: " +
        Object.keys(PERMISSION_TYPES).join(", ") +
        ".",
    );
  }
  const setting = String((args && args.setting) || "").toLowerCase();
  if (!PERMISSION_SETTINGS.includes(setting)) {
    throw new Error("browser_permission setting must be allow, block, or ask.");
  }
  let origin = args && args.origin ? String(args.origin) : null;
  // A grant is persistent, origin-scoped, and outlives the session, and the human approves the
  // ARGUMENTS -- with the origin omitted nobody in the chain can see which site is being handed
  // the camera. Only the restrictive settings may name the site by "whatever is in front of us".
  if (!origin && setting === "allow") {
    throw new Error(
      "browser_permission allow needs an explicit http(s) origin, so the site being granted the " +
        "permission is named in the request.",
    );
  }
  let ambientTab = null;
  if (!origin) {
    ambientTab = await activeTab(session);
    origin = ambientTab && ambientTab.url ? ambientTab.url : null;
  }
  const pattern = origin ? originPattern(origin) : null;
  if (!pattern) {
    throw new Error(
      "browser_permission needs a valid http(s) origin (or an active http(s) tab).",
    );
  }
  const store = chrome.contentSettings[typeKey];
  if (!store || typeof store.set !== "function") {
    throw new Error(
      "This browser cannot set the '" + args.name + "' permission.",
    );
  }
  // The ambient origin was read before the store lookup; a tab switch or a navigation in between
  // would redirect the setting to a site nobody named. Prove the same tab still shows the same
  // origin immediately before the write.
  if (ambientTab !== null) {
    const now = await activeTab(session);
    if (now.id !== ambientTab.id || originPattern(now.url || "") !== pattern) {
      throw new Error(
        "The active tab changed while applying the permission; name the origin explicitly.",
      );
    }
  }
  // Chrome accepts a different set of values per type, and passing one it does not take comes
  // back as "Invalid invocation: Error at property 'setting': Value must be one of allow,
  // block" -- which names neither the tool, the permission, nor what WOULD have worked. The
  // check moves here so the refusal can say all three.
  const allowed = SETTINGS_BY_PERMISSION[typeKey] || PERMISSION_SETTINGS;
  if (allowed.indexOf(setting) < 0) {
    throw new Error(
      "Chrome does not accept '" +
        setting +
        "' for the '" +
        String(args.name).toLowerCase() +
        "' permission; it takes " +
        allowed.join(" or ") +
        ". Chrome's extension API cannot return one site to the browser default -- " +
        "clear that in chrome://settings/content.",
    );
  }
  await store.set({ primaryPattern: pattern, setting });
  return { ok: true, name: String(args.name).toLowerCase(), setting, pattern };
}

// -- web storage (localStorage / sessionStorage) -----------------------------
//
// Read or write the active tab's local/session storage: get/set/remove/clear/keys. Chrome's
// extension debugger transport does NOT expose the CDP DOMStorage domain, even though raw CDP
// defines it. Run instead in a named ISOLATED WORLD: it shares the document's storage area but
// has its own pristine global/prototypes, so page code cannot shadow localStorage or replace
// Storage.prototype methods to forge reads/no-op writes. The function also compares the live
// origin before touching anything. Returned keys and values are capped so a huge store cannot
// flood the transport.
const MAX_STORAGE_VALUE_CHARS = 20000;
const MAX_STORAGE_KEYS = 500;
// A key NAME is page-controlled too, and the count cap alone bounds nothing: 500 names of a
// megabyte each is a half-gigabyte reply that never parses as a frame.
const MAX_STORAGE_KEY_CHARS = 512;

// Name the storage area by the attached page's own security origin. An opaque origin
// (sandboxed, file:) has no area to address, so it fails closed rather than resolving to
// something else's store.
function storageIdFor(url, area) {
  const origin = originOf(url);
  if (!origin) {
    throw new Error(
      "This page has no addressable storage origin (it is sandboxed or has an opaque origin).",
    );
  }
  return { securityOrigin: origin, isLocalStorage: area !== "session" };
}

async function storageOperation(tabId, storageId, area, action, key, value) {
  const tree = await sendCdp(tabId, "Page.getFrameTree", {});
  const frameId =
    tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
  if (!frameId) {
    throw new Error(
      "Could not identify the active document for browser_storage.",
    );
  }
  const world = await sendCdp(tabId, "Page.createIsolatedWorld", {
    frameId,
    worldName: "ChromeControlMCPStorage",
    grantUniveralAccess: false,
  });
  const contextId = world && world.executionContextId;
  if (!Number.isInteger(contextId)) {
    throw new Error("Could not create an isolated storage context.");
  }
  const operation = function (
    storageArea,
    storageAction,
    storageKey,
    storageValue,
    expectedOrigin,
    maxValue,
    maxKeys,
    maxKey,
  ) {
    try {
      if (location.origin !== expectedOrigin) {
        return {
          ok: false,
          error: "The document origin changed before the storage operation.",
        };
      }
      const store =
        storageArea === "session"
          ? globalThis.sessionStorage
          : globalThis.localStorage;
      const proto = globalThis.Storage.prototype;
      const get = function (k) {
        return proto.getItem.call(store, k);
      };
      const length = function () {
        return Object.getOwnPropertyDescriptor(proto, "length").get.call(store);
      };
      if (storageAction === "get") {
        const got = get(storageKey);
        if (got === null) {
          return { ok: true, present: false, value: null };
        }
        const text = String(got);
        return text.length > maxValue
          ? {
              ok: true,
              present: true,
              value: text.slice(0, maxValue),
              truncated: true,
            }
          : { ok: true, present: true, value: text };
      }
      if (storageAction === "keys") {
        const total = length();
        const count = Math.min(total, maxKeys);
        const names = [];
        let cut = false;
        for (let i = 0; i < count; i++) {
          let raw = String(proto.key.call(store, i));
          if (raw.length > maxKey) {
            cut = true;
            raw = raw.slice(0, maxKey);
          }
          names.push(raw);
        }
        return {
          ok: true,
          keys: names,
          count: total,
          capped: total > maxKeys,
          keys_truncated: cut,
        };
      }
      if (storageAction === "set") {
        proto.setItem.call(store, storageKey, storageValue);
        if (get(storageKey) !== storageValue) {
          return {
            ok: false,
            error:
              "The value was not stored (the area rejected or dropped the write).",
          };
        }
        return { ok: true, stored: true };
      }
      if (storageAction === "remove") {
        const existed = get(storageKey) !== null;
        proto.removeItem.call(store, storageKey);
        if (get(storageKey) !== null) {
          return {
            ok: false,
            error: "The key is still present after the remove.",
          };
        }
        return { ok: true, removed: existed };
      }
      const before = length();
      proto.clear.call(store);
      const after = length();
      if (after > 0) {
        return {
          ok: false,
          error:
            "The storage area still holds " +
            after +
            " entries after the clear.",
        };
      }
      return { ok: true, cleared: before };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  };
  const call = await sendCdp(tabId, "Runtime.callFunctionOn", {
    executionContextId: contextId,
    functionDeclaration: operation.toString(),
    arguments: [
      { value: area },
      { value: action },
      { value: key },
      { value },
      { value: storageId.securityOrigin },
      { value: MAX_STORAGE_VALUE_CHARS },
      { value: MAX_STORAGE_KEYS },
      { value: MAX_STORAGE_KEY_CHARS },
    ],
    returnByValue: true,
  });
  const result = call && call.result && call.result.value;
  if (call && call.exceptionDetails) {
    throw new Error(
      "The isolated storage operation threw before returning a result.",
    );
  }
  if (!result || result.ok !== true) {
    throw new Error(
      (result && result.error) ||
        "browser_storage failed in its isolated context.",
    );
  }
  return result;
}

async function handleStorage(session, tabId, args) {
  await ensureAttached(session, tabId);
  const action = String((args && args.action) || "").toLowerCase();
  if (["get", "set", "remove", "clear", "keys"].indexOf(action) < 0) {
    throw new Error(
      "browser_storage action must be get, set, remove, clear, or keys.",
    );
  }
  const area = String((args && args.area) || "local").toLowerCase();
  if (area !== "local" && area !== "session") {
    throw new Error("browser_storage area must be local or session.");
  }
  if (
    (action === "get" || action === "set" || action === "remove") &&
    (typeof args.key !== "string" || args.key.length === 0)
  ) {
    throw new Error("browser_storage " + action + " needs a key.");
  }
  if (action === "set" && typeof args.value !== "string") {
    throw new Error("browser_storage set needs a string value.");
  }
  // The command carries no site of its own: it acts on whichever tab is active when the frame
  // executes. Resolve that origin BEFORE touching anything, so a caller that states which site
  // it meant is refused on a mismatch rather than reading (or clearing) another site's tokens,
  // and so the reply names the origin the operation actually touched.
  const info = await tabInfo(tabId);
  if (
    args &&
    typeof args.expect_origin === "string" &&
    args.expect_origin.length > 0 &&
    !originsMatch(info.url, args.expect_origin)
  ) {
    throw new Error(
      "The active tab is " +
        (info.url || "an unknown page") +
        ", not " +
        args.expect_origin +
        "; browser_storage will not touch another site's storage.",
    );
  }
  const storageId = storageIdFor(info.url, area);
  const result = await storageOperation(
    tabId,
    storageId,
    area,
    action,
    args.key || "",
    action === "set" ? args.value : "",
  );
  return Object.assign({ url: info.url }, result);
}

// -- cookies (chrome.cookies) ------------------------------------------------
//
// Read/set/remove cookies for an origin via the native chrome.cookies API (reliable + covers
// httpOnly cookies a page's document.cookie cannot). SENSITIVE: get returns cookie VALUES,
// which can include session tokens, and set can install a session cookie -- the tool is gated
// (confirmed each call) and its scope is bound to a validated http(s) url; a set is confined by
// the API to that url's domain, so it cannot forge a cookie for an unrelated site. Values and
// the returned list are capped so a large jar cannot flood the transport.
const COOKIE_SAME_SITE = {
  no_restriction: "no_restriction",
  lax: "lax",
  strict: "strict",
};

function cookieView(c) {
  // A value long enough to be sliced is not the value the caller reads back. Chrome's own ~4096
  // byte cookie limit makes the cut rare, but a cap that is silent is a cap that misreports the
  // day it does bite -- every other capped field in this file says so.
  const overCap = Boolean(c.value && c.value.length > 4096);
  return {
    name: c.name,
    value: overCap ? c.value.slice(0, 4096) : c.value,
    value_truncated: overCap,
    domain: c.domain,
    path: c.path,
    secure: Boolean(c.secure),
    http_only: Boolean(c.httpOnly),
    same_site: c.sameSite || null,
    session: Boolean(c.session),
    expires: c.expirationDate || null,
  };
}

// A cookie attribute that cannot be honored is not an attribute that may be dropped: scope
// (path), cross-site exposure (same_site), and lifetime (expires_days) are the whole point of
// asking for them, and Chrome's default for each is a DIFFERENT cookie than the one requested.
function cookieDetails(url, args) {
  const details = { url, name: String(args.name), value: args.value };
  if (args.path !== undefined && args.path !== null) {
    if (typeof args.path !== "string" || args.path.length === 0) {
      throw new Error("browser_cookies path must be a non-empty string.");
    }
    details.path = args.path;
  }
  if (typeof args.secure === "boolean") {
    details.secure = args.secure;
  }
  if (typeof args.http_only === "boolean") {
    details.httpOnly = args.http_only;
  }
  if (args.same_site !== undefined && args.same_site !== null) {
    const ss =
      typeof args.same_site === "string"
        ? COOKIE_SAME_SITE[args.same_site.toLowerCase()]
        : null;
    if (!ss) {
      throw new Error(
        "browser_cookies same_site must be one of: " +
          Object.keys(COOKIE_SAME_SITE).join(", ") +
          ".",
      );
    }
    details.sameSite = ss;
  }
  if (args.expires_days !== undefined && args.expires_days !== null) {
    const days = Number(args.expires_days);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(
        "browser_cookies expires_days must be a positive number.",
      );
    }
    details.expirationDate =
      Math.floor(Date.now() / 1000) + Math.round(days * 86400);
  }
  return details;
}

async function cookiesSet(url, args) {
  if (typeof args.value !== "string") {
    throw new Error("browser_cookies set needs a string value.");
  }
  const details = cookieDetails(url, args);
  const cookie = await chrome.cookies.set(details);
  if (!cookie) {
    throw new Error(
      "browser_cookies set failed (the browser rejected the cookie).",
    );
  }
  // Report the cookie the browser actually installed, not the one that was asked for: Chrome
  // adjusts path, domain, sameSite and lifetime on its own rules, and a caller that cannot see
  // the difference cannot tell a session cookie from the persistent one it requested. The value
  // is the caller's own and is left out -- a set is not a reason to put a token in the reply.
  const view = cookieView(cookie);
  delete view.value;
  delete view.value_truncated;
  return Object.assign({ ok: true, url, set: true }, view);
}

async function handleCookies(session, args) {
  const action = String((args && args.action) || "").toLowerCase();
  if (["get", "set", "remove"].indexOf(action) < 0) {
    throw new Error("browser_cookies action must be get, set, or remove.");
  }
  // A url that was SUPPLIED must be usable. Letting an empty or blank one fall through to the
  // active tab answers a different question than the one that was asked -- and the answer is a
  // site's cookies, which can be its session tokens.
  if (
    args &&
    args.url !== undefined &&
    args.url !== null &&
    (typeof args.url !== "string" || args.url.trim().length === 0)
  ) {
    throw new Error("browser_cookies url must be a non-empty http(s) url.");
  }
  let url = args && args.url ? String(args.url).trim() : null;
  if (!url) {
    const tab = await activeTab(session);
    url = tab && tab.url ? tab.url : null;
  }
  if (!url || !/^https?:/i.test(url)) {
    throw new Error(
      "browser_cookies needs a valid http(s) url (or an active http(s) tab).",
    );
  }
  if (action === "get") {
    const all = await chrome.cookies.getAll({ url });
    return {
      ok: true,
      url,
      count: all.length,
      capped: all.length > 100,
      cookies: all.slice(0, 100).map(cookieView),
    };
  }
  if (!args || typeof args.name !== "string" || args.name.length === 0) {
    throw new Error("browser_cookies " + action + " needs a name.");
  }
  if (action === "remove") {
    const removed = await chrome.cookies.remove({
      url,
      name: String(args.name),
    });
    return {
      ok: true,
      url,
      name: String(args.name),
      removed: Boolean(removed),
    };
  }
  return await cookiesSet(url, args);
}

// -- downloads (chrome.downloads) --------------------------------------------
//
// Download a url to disk via the native chrome.downloads API and wait for it to finish,
// returning the real saved path + byte size. The op writes a file, so it is gated. filename
// is optional and must be RELATIVE with no ".." (chrome.downloads rejects absolute/parent
// paths anyway; we reject early with a clear message), so a page cannot steer the write
// outside the browser's download tree. Poll to completion under a bounded timeout.
async function pollDownload(session, tabId, id, timeoutMs, gen) {
  const deadline = Date.now() + timeoutMs;
  let item = null;
  while (Date.now() < deadline) {
    // The command this poll belongs to is retired the moment a newer frame arrives, the host
    // cancels, or the session is torn down. Polling on past that keeps working for a reply
    // nothing is waiting for, and finally posts it into a relay that has already been reset.
    if (gen !== session.commandGeneration) {
      throw new Error("The download wait was superseded by a newer command.");
    }
    const found = await chrome.downloads.search({ id });
    item = found && found[0];
    if (item && item.state !== "in_progress") {
      return item;
    }
    await pageDelay(tabId, 250);
  }
  return item;
}

async function handleDownload(session, tabId, args) {
  // Attached because the poll below is timed by this tab's page, as every wait here is.
  await ensureAttached(session, tabId);
  // The generation this download wait belongs to, captured before anything can supersede it.
  const gen = session.commandGeneration;
  const url = args && args.url ? String(args.url) : "";
  if (!/^https?:/i.test(url)) {
    throw new Error("browser_download needs a valid http(s) url.");
  }
  const opts = { url, conflictAction: "uniquify", saveAs: false };
  if (typeof args.filename === "string" && args.filename.trim().length > 0) {
    const fn = args.filename.trim();
    if (/^([a-zA-Z]:|\\|\/)/.test(fn) || fn.indexOf("..") >= 0) {
      throw new Error(
        "browser_download filename must be a relative name without '..'.",
      );
    }
    opts.filename = fn;
  }
  let timeoutMs = Number(args && args.timeout_ms);
  if (!Number.isFinite(timeoutMs)) {
    timeoutMs = 30000;
  }
  timeoutMs = Math.min(120000, Math.max(1000, timeoutMs));
  const id = await chrome.downloads.download(opts);
  if (typeof id !== "number") {
    throw new Error("browser_download failed to start.");
  }
  const item = await pollDownload(session, tabId, id, timeoutMs, gen);
  if (!item) {
    throw new Error("browser_download could not track the download.");
  }
  if (item.state !== "complete") {
    // Say which state, in the error itself: a reply carrying only ok:false reaches the model as
    // "the browser reported failure", with the one fact that explains it left behind.
    return {
      ok: false,
      id,
      state: item.state,
      error: item.error
        ? `The download ${item.state} (${item.error}).`
        : `The download is ${item.state} and did not finish in time.`,
      path: item.filename || null,
    };
  }
  return {
    ok: true,
    id,
    state: item.state,
    path: item.filename || null,
    bytes: item.fileSize || item.totalBytes || 0,
    url,
  };
}

// -- HTTP auth (Fetch domain) ------------------------------------------------
//
// Arm credentials to auto-answer HTTP Basic/Digest 401 challenges on the active tab, so
// automation can reach password-protected pages without a native auth dialog wedging the
// browser. Enables the Fetch domain (handleAuthRequests); the onEvent handler answers each
// challenge and continues every other paused request. clear:true (or a tab switch/detach)
// disarms + disables Fetch. The password is used only to answer challenges and is never
// echoed back in the result.
// Carry any interception failure back on the reply. While Fetch is on, every request in the tab
// is paused, so a continue that failed is a resource the page is still waiting on -- the operator
// sees only a slow page unless the arm/disarm reply says so.
function fetchStateReply(tab, reply) {
  if (tab.lastFetchError !== null) {
    reply.last_fetch_error = tab.lastFetchError;
  }
  return reply;
}

async function handleHttpAuth(session, tabId, args) {
  const tab = tabStateOf(session, tabId);
  await ensureAttached(session, tabId);
  if (args && args.clear === true) {
    tab.httpAuthCreds = null;
    // Not swallowed: while Fetch is still enabled every request stays paused for a handler that no
    // longer answers them, and the page wedges. Saying "cleared" then would be a false report.
    await sendCdp(tabId, "Fetch.disable");
    return fetchStateReply(tab, { ok: true, armed: false });
  }
  const username =
    args && typeof args.username === "string" ? args.username : "";
  const password =
    args && typeof args.password === "string" ? args.password : "";
  if (!username) {
    throw new Error(
      "browser_http_auth needs a username (or clear:true to disarm).",
    );
  }
  // Bind the credentials to the current tab's origin so the onEvent handler only ever hands
  // them to a same-origin challenge. Fail closed if the tab has no resolvable origin.
  let origin = null;
  try {
    const current = await chrome.tabs.get(tabId);
    if (current && current.url) {
      origin = new URL(current.url).origin;
    }
  } catch (_e) {
    origin = null;
  }
  if (!origin || origin === "null") {
    throw new Error(
      "browser_http_auth could not resolve the tab's origin to bind the credentials to.",
    );
  }
  // The origin comes from whichever tab is active when the frame executes, which need not be the
  // site the password was confirmed for. When the caller states the origin it means, the arm
  // happens only if the tab is still that origin.
  if (
    args &&
    typeof args.origin === "string" &&
    args.origin.length > 0 &&
    !originsMatch(args.origin, origin)
  ) {
    throw new Error(
      "The active tab is " +
        origin +
        ", not " +
        args.origin +
        "; browser_http_auth will not arm credentials for a different origin.",
    );
  }
  tab.httpAuthCreds = { username, password, origin };
  await sendCdp(tabId, "Fetch.enable", {
    handleAuthRequests: true,
    patterns: [{ urlPattern: "*" }],
  });
  return fetchStateReply(tab, { ok: true, armed: true, username, origin });
}

// -- Bring the bridge up -----------------------------------------------------

// Connect when the extension loads, when the browser starts, and on demand from the
// toolbar button (which also re-arms after a disconnect).
// Each opens a port only when none is up. connect() now creates a session per
// call, so wiring it directly as a listener would spawn a surplus host process
// every time the toolbar button was pressed.
const connectIfIdle = () => {
  if (!anyPortOpen()) {
    connect();
  }
};
chrome.runtime.onInstalled.addListener(connectIfIdle);
chrome.runtime.onStartup.addListener(connectIfIdle);

// The toolbar button fixes whatever the current state is, which is also what the title says it
// will do. Paused -> resume and connect. Connected -> pause. Neither -> the user can see it is not
// connected and is asking for an attempt now, so the waiting interval does not apply to it.
const onActionClicked = async () => {
  if (bridgePaused) {
    await setBridgePaused(false);
    resetReconnectDelay();
    connect({ force: true });
    return;
  }
  if (anyPortOpen()) {
    await setBridgePaused(true);
    return;
  }
  resetReconnectDelay();
  connect({ force: true });
};
chrome.action.onClicked.addListener(() => {
  void onActionClicked();
});

// Before anything decides whether to connect. A pause the user set yesterday has to be in force
// for the listeners below, which fire as soon as the browser starts moving.
void loadBridgeState();

// What an earlier worker held, parked until the first offer says whose servers are still there.
leasesLoaded = loadLeases().catch(() => {});

// Ordinary browsing re-arms the bridge too. The 2 s timer below lives only as long as this
// worker, and Chrome coalesces a background worker's timers into seconds, so a bridge that came up
// after the browser did would otherwise wait on the alarm -- up to a minute of the user's time.
// Every tab event is a moment the worker is awake anyway: a connect attempt then costs nothing and
// is refused in microseconds while the port is already up.
const reconnectOnActivity = () => {
  if (!anyPortOpen()) {
    connect();
  }
};
chrome.tabs.onUpdated.addListener(reconnectOnActivity);
chrome.tabs.onActivated.addListener(reconnectOnActivity);

// A standing alarm re-arms the bridge when nothing else does. The 2 s reconnect
// timer above only lives as long as this service worker, and Chrome retires an
// MV3 worker after ~30 s idle: a host that was not there at startup (no MCP
// server yet, or one that had lost its rendezvous record) would otherwise stay
// unreachable until the browser restarted or the toolbar button was pressed.
// An alarm fires whether or not the worker is alive, so the bridge comes up
// within a minute of the server publishing its record. Guarded: the pure unit
// harness stubs `chrome` without alarms.
const RECONNECT_ALARM = "chrome_control_mcp.reconnect";
const PROBE_SAFETY_NET_MS = 5 * 60000;
let lastSafetyProbeAt = Date.now();
if (chrome.alarms) {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== RECONNECT_ALARM) {
      return;
    }
    // Sessions that went quiet are stood down, and parked ones nobody came back for released.
    sweepIdleSessions();
    // A newer install waiting for nobody to be using this: a tab let go of, or a server gone.
    void reloadForNewerInstall();
    // With nothing attached this is the reconnect it always was.
    if (!anyPortOpen()) {
      connect();
      return;
    }
    // With something attached, the attached relays report new servers themselves
    // (bridge_servers) by reading their own directory, which starts no process. A probe -- which
    // does start one -- is only the safety net: for a relay too old to report, and for a server
    // that was set aside after refusing and whose wait is now over. It used to run on every
    // tick, one host process every thirty seconds for as long as an editor was open.
    const held = new Set(heldServers());
    const refusalOver = [...lastOfferedServers].some(
      (id) => !held.has(id) && refusedServers.has(id) && !serverRefused(id),
    );
    if (refusalOver || Date.now() - lastSafetyProbeAt >= PROBE_SAFETY_NET_MS) {
      lastSafetyProbeAt = Date.now();
      probeForServers();
    }
  });
}

// Expose the last health snapshot to a popup / options page later.
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request && request.type === "chrome_control_mcp.getHealth") {
    if (!anyPortOpen()) {
      connect();
    }
    // One worker now serves several sessions, so health is a list. The first
    // entry is the oldest session, which is the one a single-server install
    // has.
    sendResponse({
      sessions: [...sessions].map((entry) => ({
        server: entry.serverId,
        tabs: entry.tabs.size,
        idle: entry.idle,
        ...entry.health,
      })),
    });
  }
  return false;
});

connect();
