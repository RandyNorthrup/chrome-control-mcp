// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// A dedicated Chrome for the live suites: its own profile, its own bridge, and no window on the
// user's screen. The user's own Chrome is never touched -- not its tabs, its windows, its focus,
// nor its native-messaging registration -- so the suites can run while the user works, and can
// run the same browser at any display scale, window size, and zoom a user could have.
//
// Pairing: the MCP server and the relay Chrome starts both read CHROME_CONTROL_MCP_RUNTIME_DIR,
// so this browser's extension reaches this server and nothing else, and the user's extension
// never reaches it. The native-messaging manifest is written by the product's own installer into
// this profile's NativeMessagingHosts directory, the user-level location Chrome reads for a
// profile started with --user-data-dir.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// Chrome stores a zoom level, not a factor: level = log(factor) / log(1.2), the step its zoom
// controls take (components/zoom: blink::ZoomFactorToZoomLevel).
export function zoomLevelForPercent(percent) {
  return Math.log(percent / 100) / Math.log(1.2);
}

async function installNativeHost(executable, env) {
  const child = spawn(executable, [], {
    env: { ...env, CHROME_CONTROL_MCP_MODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const line = new Promise((resolve) => {
    readline.createInterface({ input: child.stdout }).once("line", resolve);
  });
  child.stdin.end(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_extension_install", arguments: {} },
    })}\n`,
  );
  const [response, exitCode] = await Promise.all([
    line,
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Installer exited ${exitCode}: ${stderr}`);
  }
  const result = JSON.parse(response).result;
  const state = JSON.parse(result.content[0].text);
  if (result.isError || state.state !== "prepared") {
    throw new Error(`Native host install failed: ${result.content[0].text}`);
  }
}

// Prepare the dedicated browser: its profile, its bridge directory, and the native-messaging
// registration. `scaleFactor` is the display scale (Windows 125%, a Retina panel's 2x),
// `windowSize` the browser window in DIPs, `zoomPercent` the browser zoom a user sets in Chrome's
// settings. Returns the environment the MCP server must run with to pair with it, and launch():
// start the server with that environment first, then launch -- which waits for the server's
// rendezvous record, so the extension's first connection at startup finds it rather than waiting
// out the reconnect alarm.
export async function prepareIsolatedChrome({
  chrome,
  executable,
  scaleFactor = 1,
  windowSize = [1280, 800],
  zoomPercent = 100,
}) {
  if (process.platform === "win32") {
    // Chrome for Windows finds native-messaging hosts in the registry, one key per browser
    // brand, not in the profile: an install here would rewrite the user's own registration.
    throw new Error(
      "The isolated browser is not supported on Windows: Chrome registers native-messaging " +
        "hosts in the registry, shared with the user's own Chrome.",
    );
  }
  // A short root: the bridge's socket path must fit sockaddr_un (104 bytes on macOS).
  const root = await mkdtemp(path.join("/tmp", "ccm-"));
  const profile = path.join(root, "profile");
  const runtime = path.join(root, "run");
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(path.join(profile, "Default"), { recursive: true });
  const env = {
    ...process.env,
    CHROME_CONTROL_MCP_RUNTIME_DIR: runtime,
    CHROME_CONTROL_MCP_NATIVE_HOST_DIR: path.join(
      profile,
      "NativeMessagingHosts",
    ),
  };
  await installNativeHost(executable, env);
  if (zoomPercent !== 100) {
    // The default zoom a user picks in Settings > Appearance > Page zoom. "x" is the key Chrome
    // gives the profile's default storage partition (ChromeZoomLevelPrefs).
    await writeFile(
      path.join(profile, "Default", "Preferences"),
      JSON.stringify({
        partition: {
          default_zoom_level: { x: zoomLevelForPercent(zoomPercent) },
        },
      }),
    );
  }
  const extension = path.join(path.dirname(executable), "extension");
  let browser = null;
  let stderr = "";
  let exited = false;
  const close = async () => {
    if (browser && !exited) {
      browser.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => browser.once("exit", resolve)),
        sleep(5000),
      ]);
      if (!exited) {
        browser.kill("SIGKILL");
      }
    }
    await rm(root, { recursive: true, force: true });
  };
  const launch = async () => {
    const record = path.join(runtime, "browser_bridge.json");
    let published = false;
    for (let attempt = 0; attempt < 120 && !published; attempt += 1) {
      published = Boolean(await readFile(record, "utf8").catch(() => null));
      if (!published) {
        await sleep(250);
      }
    }
    if (!published) {
      throw new Error(
        `No MCP server published its bridge record in ${runtime}; start it with this ` +
          "environment before launching the browser.",
      );
    }
    const args = [
      `--user-data-dir=${profile}`,
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      `--window-size=${windowSize[0]},${windowSize[1]}`,
      `--force-device-scale-factor=${scaleFactor}`,
      "--headless=new",
      "--remote-debugging-port=0",
      "about:blank",
    ];
    browser = spawn(chrome, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    browser.stderr.setEncoding("utf8");
    browser.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    browser.once("exit", () => {
      exited = true;
    });
    // The DevTools endpoint Chrome writes once it is up. The suites use it only for what no tool
    // offers and a user does with their hands: a trackpad pinch.
    const portFile = path.join(profile, "DevToolsActivePort");
    let devtools = null;
    for (let attempt = 0; attempt < 120 && !exited; attempt += 1) {
      const text = await readFile(portFile, "utf8").catch(() => "");
      const [port, browserPath] = text.split(/\r?\n/);
      if (port && browserPath) {
        devtools = { port: Number(port), browserPath };
        break;
      }
      await sleep(250);
    }
    if (!devtools) {
      throw new Error(`The isolated browser did not start: ${stderr}`);
    }
    return devtools;
  };
  return { env, profile, launch, close, stderr: () => stderr };
}
