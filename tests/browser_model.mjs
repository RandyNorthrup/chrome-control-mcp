// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// A small model of the browser for driving the service worker in tests: tabs, windows, groups,
// the debugger, and the events Chrome fires, so assertions are about what the user would see.
// Shared by the suites that need a whole browser rather than a single function.

import { loadWorker, makeFakePort, settle } from "./extension_harness.mjs";

export const PROTOCOL = 2;

// The browser as the worker sees it through chrome.*: windows of tabs, tab groups, the debugger,
// and the listeners the worker registers, which the test fires as Chrome would. @p exported and
// @p live are the worker names a suite reads (see loadWorker); @p refuseRemovals is how many
// tabs.remove calls Chrome refuses first, as it does while the user drags a tab; @p cdp answers a
// debugger command (tabId, method, params) when it returns anything but undefined. Every
// debugger command is recorded in calls.cdp.
export function fakeBrowser({
  exported,
  live = "",
  refuseRemovals = 0,
  cdp = () => undefined,
} = {}) {
  let removalsRefused = 0;
  const tabs = new Map();
  const groups = new Map();
  const listeners = new Map();
  const attached = new Set();
  const ports = [];
  const calls = {
    removed: [],
    ungrouped: [],
    grouped: [],
    connects: 0,
    cdp: [],
  };
  let nextTabId = 100;
  let nextGroupId = 500;
  let focusedWindow = { id: 1, focused: true };

  const on = (name) => ({
    addListener: (fn) => {
      if (!listeners.has(name)) {
        listeners.set(name, []);
      }
      listeners.get(name).push(fn);
    },
    removeListener: () => {},
  });
  const fire = (name, ...args) => {
    for (const fn of listeners.get(name) || []) {
      fn(...args);
    }
  };
  const copy = (tab) => ({ ...tab });

  function addTab(props) {
    const id = props.id ?? nextTabId++;
    const windowId = props.windowId ?? 1;
    const index = [...tabs.values()].filter(
      (t) => t.windowId === windowId,
    ).length;
    const tab = {
      id,
      windowId,
      index,
      active: false,
      pinned: false,
      groupId: -1,
      url: "https://example.test/" + id,
      title: "tab " + id,
      ...props,
    };
    tabs.set(id, tab);
    return tab;
  }

  const overrides = {
    "runtime.connectNative": () => {
      calls.connects += 1;
      const port = makeFakePort();
      ports.push(port);
      return port;
    },
    "runtime.id": "self",
    "tabs.get": (id) =>
      tabs.has(id)
        ? Promise.resolve(copy(tabs.get(id)))
        : Promise.reject(new Error("No tab with id: " + id)),
    "tabs.query": (q = {}) =>
      Promise.resolve(
        [...tabs.values()]
          .filter(
            (t) =>
              (q.windowId === undefined || t.windowId === q.windowId) &&
              (q.groupId === undefined || t.groupId === q.groupId) &&
              (q.active === undefined || t.active === q.active),
          )
          .map(copy),
      ),
    "tabs.create": (props) => {
      const tab = addTab({
        windowId: props.windowId,
        url: props.url,
        active: props.active,
      });
      fire("tabs.onCreated", copy(tab));
      return Promise.resolve(copy(tab));
    },
    "tabs.remove": (ids) => {
      if (removalsRefused < refuseRemovals) {
        removalsRefused += 1;
        return Promise.reject(
          new Error(
            "Tabs cannot be edited right now (user may be dragging a tab).",
          ),
        );
      }
      for (const id of [].concat(ids)) {
        calls.removed.push(id);
        tabs.delete(id);
        attached.delete(id); // Chrome ends the attachment with the tab
        fire("tabs.onRemoved", id, {});
      }
      return Promise.resolve();
    },
    "tabs.group": ({ tabIds, groupId, createProperties }) => {
      let id = groupId;
      if (id === undefined) {
        id = nextGroupId++;
        groups.set(id, {
          id,
          windowId: createProperties.windowId,
          title: "",
          color: "grey",
        });
      }
      for (const tabId of tabIds) {
        tabs.get(tabId).groupId = id;
        calls.grouped.push(tabId);
        fire("tabs.onUpdated", tabId, { groupId: id }, copy(tabs.get(tabId)));
      }
      return Promise.resolve(id);
    },
    "tabs.ungroup": (ids) => {
      for (const id of [].concat(ids)) {
        if (tabs.has(id)) {
          tabs.get(id).groupId = -1;
          calls.ungrouped.push(id);
          fire("tabs.onUpdated", id, { groupId: -1 }, copy(tabs.get(id)));
        }
      }
      return Promise.resolve();
    },
    "tabs.update": (id, props) => {
      const tab = tabs.get(id);
      if (props && props.active && tab) {
        for (const other of tabs.values()) {
          if (other.windowId === tab.windowId) {
            other.active = other.id === id;
          }
        }
        fire("tabs.onActivated", { tabId: id, windowId: tab.windowId });
      }
      return Promise.resolve(copy(tab));
    },
    "tabGroups.get": (id) =>
      groups.has(id)
        ? Promise.resolve({ ...groups.get(id) })
        : Promise.reject(new Error("no group")),
    "tabGroups.update": (id, props) => {
      Object.assign(groups.get(id), props);
      return Promise.resolve({ ...groups.get(id) });
    },
    "tabGroups.query": () =>
      Promise.resolve([...groups.values()].map((g) => ({ ...g }))),
    "windows.get": (id) => Promise.resolve({ id }),
    "windows.getLastFocused": () => Promise.resolve({ ...focusedWindow }),
    "debugger.attach": ({ tabId }) => {
      attached.add(tabId);
      return Promise.resolve();
    },
    "debugger.detach": ({ tabId }) => {
      attached.delete(tabId);
      return Promise.resolve();
    },
    "debugger.sendCommand": ({ tabId }, method, params) => {
      calls.cdp.push({ tabId, method, params });
      const answer = cdp(tabId, method, params);
      return Promise.resolve(answer === undefined ? {} : answer);
    },
    "debugger.getTargets": () => Promise.resolve([]),
    "scripting.executeScript": () => Promise.resolve([]),
  };
  for (const name of [
    "tabs.onCreated",
    "tabs.onUpdated",
    "tabs.onRemoved",
    "tabs.onReplaced",
    "tabs.onAttached",
    "tabs.onDetached",
    "tabs.onActivated",
    "debugger.onDetach",
    "debugger.onEvent",
    "webNavigation.onCreatedNavigationTarget",
  ]) {
    overrides[name] = on(name);
  }
  const worker = loadWorker(exported, overrides, live);
  return {
    worker,
    tabs,
    groups,
    attached,
    ports,
    calls,
    fire,
    addTab,
    copy,
    focus: (windowId, focused = true) => {
      focusedWindow = { id: windowId, focused };
    },
  };
}

// A browser with the worker attached to one server, ready for commands.
export async function attachedBrowser(server = "100", options = {}) {
  const browser = fakeBrowser(options);
  const port = browser.ports[0];
  port.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: [server] });
  port.emit({ type: "bridge_ready", protocol: PROTOCOL });
  await settle();
  const session = [...browser.worker.sessions][0];
  return { ...browser, port, session };
}

// Send one command frame the way the relay does and return the reply the worker posted.
export async function command(port, cmd, args = {}) {
  const id = "c-" + Math.random().toString(36).slice(2);
  port.emit({ type: "command", id, cmd, ...args });
  for (let i = 0; i < 20; i += 1) {
    await settle();
    const reply = port.posted.find((f) => f.id === id && f.type !== "progress");
    if (reply) {
      return reply;
    }
  }
  throw new Error("no reply to " + cmd);
}
