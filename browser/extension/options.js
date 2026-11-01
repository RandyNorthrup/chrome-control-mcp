// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The options page: the name agents use for this Chrome profile. The service worker reads the same
// storage key and takes a change at once, so nothing has to be reloaded.

const PROFILE_NAME_KEY = "chrome_control_mcp.profileName";
const PROFILE_GENERATED_KEY = "chrome_control_mcp.profileGenerated";
const MAX_PROFILE_NAME_CHARS = 64;

// Printable text only, whitespace collapsed, bounded: the same rule the service worker and the
// server apply, so what is saved here is what agents see.
function cleanName(value) {
  return Array.from(typeof value === "string" ? value : "")
    .filter((ch) => !/[\p{C}\p{Zl}\p{Zp}]/u.test(ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROFILE_NAME_CHARS)
    .trim();
}

async function loadState() {
  const stored = await chrome.storage.local.get([
    PROFILE_NAME_KEY,
    PROFILE_GENERATED_KEY,
  ]);
  const info = await chrome.identity
    .getProfileUserInfo({ accountStatus: "ANY" })
    .catch(() => null);
  const email = info && typeof info.email === "string" ? info.email.trim() : "";
  return {
    custom: cleanName(stored && stored[PROFILE_NAME_KEY]),
    email,
    generated: cleanName(stored && stored[PROFILE_GENERATED_KEY]),
  };
}

function currentName(state) {
  return state.custom || state.email || state.generated || "this profile";
}

function render(state) {
  document.getElementById("account").textContent = state.email
    ? `Signed in to Chrome as ${state.email}.`
    : "Not signed in to Chrome, so there is no account email to use.";
  document.getElementById("name").value = state.custom;
  document.getElementById("name").placeholder = state.email || state.generated;
  document.getElementById("current").textContent = currentName(state);
  document.getElementById("clear").disabled = !state.custom;
}

async function saveName(raw) {
  const name = cleanName(raw);
  if (name) {
    await chrome.storage.local.set({ [PROFILE_NAME_KEY]: name });
  } else {
    await chrome.storage.local.remove(PROFILE_NAME_KEY);
  }
  return name;
}

async function refresh(message) {
  render(await loadState());
  document.getElementById("status").textContent = message || "";
}

function wireOptionsPage() {
  document.getElementById("save").addEventListener("click", async () => {
    const name = await saveName(document.getElementById("name").value);
    await refresh(
      name ? `Saved. Agents now call this profile ${name}.` : "Name cleared.",
    );
  });
  document.getElementById("clear").addEventListener("click", async () => {
    await saveName("");
    await refresh("Name cleared; agents use the account email again.");
  });
  document.getElementById("name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      document.getElementById("save").click();
    }
  });
  void refresh();
}

if (typeof document !== "undefined" && document.getElementById("save")) {
  wireOptionsPage();
}
