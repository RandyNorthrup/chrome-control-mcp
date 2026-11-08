// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// A dedicated Chrome for the live suites: its own profile, its own bridge, and no window on the
// user's screen. The user's own Chrome is never touched -- not its tabs, its windows, its focus,
// nor its native-messaging registration -- so the suites can run while the user works, and can
// run the same browser at any display scale, window size, and zoom a user could have.
//
// Pairing: the MCP server and the relay Chrome starts both read CHROME_CONTROL_MCP_RUNTIME_DIR,
// so this browser's extension reaches this server and nothing else, and the user's extension
// never reaches it. On Linux and macOS the native-messaging manifest is written by the product's
// own installer into this profile's NativeMessagingHosts directory, the user-level location
// Chrome reads for a profile started with --user-data-dir. Windows keeps that registration in the
// registry, one key for the user and not per profile, so a dedicated browser there runs against
// the user's existing key: the run asserts that the key names the executable under test, and the
// runtime directory alone keeps the two browsers on their own servers.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// The Chrome Web Store's public key for this extension: the store signs its build with the
// matching private key, so an unpacked copy whose manifest carries this key has the store build's
// ID (mbkacllnbffbadcajpkkpelifdkfgcbd) -- which is how a live run meets the store build.
const STORE_PUBLIC_KEY_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../browser/store-public-key.txt",
);

// The ID Chrome gives an extension whose manifest names @p key (base64 DER): the first 128 bits
// of the key's SHA-256, as the letters a to p.
export function extensionIdForKey(key) {
  const digest = crypto
    .createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest();
  let id = "";
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
  }
  return id;
}

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

// The registry key Chrome reads for this user, and the manifest it names. A dedicated browser on
// Windows runs against that registration rather than one of its own, so the run is only isolated
// when the registration points at the executable under test: a mismatch would quietly test the
// user's installed build instead of this one, and pass or fail for the wrong binary.
const WINDOWS_HOST_KEY =
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.chromecontrolmcp.browser";

function assertWindowsHostRegistration(executable) {
  const wanted = path.resolve(executable).toLowerCase();
  let manifestPath = null;
  try {
    const query = execFileSync("reg", ["query", WINDOWS_HOST_KEY, "/ve"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const value = query.match(/REG_SZ\s+(.+)/);
    manifestPath = value ? value[1].trim() : null;
  } catch {
    manifestPath = null;
  }
  const registered = manifestPath
    ? (() => {
        try {
          return path
            .resolve(JSON.parse(fs.readFileSync(manifestPath, "utf8")).path)
            .toLowerCase();
        } catch {
          return null;
        }
      })()
    : null;
  if (registered !== wanted) {
    throw new Error(
      "The dedicated browser needs this user's native-messaging registration to name the " +
        `executable under test. Registered: ${registered || "nothing"}. Under test: ${wanted}. ` +
        "Run: npm run extension -- install <executable>",
    );
  }
}

// Prepare the dedicated browser: its profile, its bridge directory, and the native-messaging
// registration. `scaleFactor` is the display scale (Windows 125%, a Retina panel's 2x),
// `windowSize` the browser window in DIPs, `zoomPercent` the browser zoom a user sets in Chrome's
// settings. `extension` loads another extension folder than the one staged beside the executable
// (a released one, to meet an older extension); `extensionVersion` loads that extension as if its
// manifest said another version (to meet one older or newer than the installed copy without
// building one); `stripPermissions` leaves those permissions out of the copy (to meet an
// extension older than a release that added them). A copy keeps the manifest's key, so it keeps the
// ID the native host allows -- unless `storeKey` gives it the Chrome Web Store's key, so the
// browser runs it under the store build's ID, the other one the native host allows. `headed` runs a real window -- under Xvfb on Linux -- which a second
// profile needs: `secondProfile` opens that profile in the same Chrome once it has started, and
// headless Chrome does not open one at all.
// Returns the environment the MCP server must run with to pair with it, and launch():
// start the server with that environment first, then launch -- which waits for the server's
// rendezvous record, so the extension's first connection at startup finds it rather than waiting
// out the reconnect alarm.
export async function prepareIsolatedChrome({
  chrome,
  executable,
  scaleFactor = 1,
  windowSize = [1280, 800],
  zoomPercent = 100,
  extraArgs = [],
  extension: extensionDir = null,
  extensionVersion = null,
  stripPermissions = [],
  storeKey = false,
  headed = false,
  secondProfile = null,
}) {
  // Windows registers native-messaging hosts in the registry, one key for the user, so this
  // browser cannot be given a registration of its own -- and does not need one. The user's key
  // already names an executable; when that is the executable under test, this browser reaches it
  // exactly as the user's would. What keeps the two apart is CHROME_CONTROL_MCP_RUNTIME_DIR: the
  // host inherits it from the browser that launched it, so this browser finds only this run's
  // server, and the user's Chrome, launched without it, cannot reach this server at all.
  if (process.platform === "win32") {
    assertWindowsHostRegistration(executable);
  }
  // A short root: the bridge's socket path must fit sockaddr_un (104 bytes on macOS). Windows
  // names a pipe instead, and has no /tmp.
  const root = await mkdtemp(
    path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "ccm-"),
  );
  const profile = path.join(root, "profile");
  const runtime = path.join(root, "run");
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(path.join(root, "installer-run"), { mode: 0o700 });
  await mkdir(path.join(profile, "Default"), { recursive: true });
  const env = {
    ...process.env,
    CHROME_CONTROL_MCP_RUNTIME_DIR: runtime,
    ...(process.platform === "win32"
      ? {}
      : {
          CHROME_CONTROL_MCP_NATIVE_HOST_DIR: path.join(
            profile,
            "NativeMessagingHosts",
          ),
        }),
  };
  // The installer runs an MCP server of its own for one call, and a server publishes a bridge
  // record: in this browser's runtime directory that record would make the suite's own server
  // stand down (one bridge to a user, by design) and the browser would find a dead endpoint. It
  // gets a runtime directory of its own, which nothing else ever looks in.
  try {
    if (process.platform !== "win32") {
      await installNativeHost(executable, {
        ...env,
        CHROME_CONTROL_MCP_RUNTIME_DIR: path.join(root, "installer-run"),
      });
    }
  } catch (error) {
    // Nothing owns this directory yet: without this it would outlive the run.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
    throw error;
  }
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
  let extension = extensionDir
    ? path.resolve(extensionDir)
    : path.join(path.dirname(executable), "extension");
  if (extensionVersion || stripPermissions.length > 0 || storeKey) {
    const staged = path.join(root, "extension");
    await cp(extension, staged, { recursive: true });
    const manifestPath = path.join(staged, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (extensionVersion) {
      manifest.version = extensionVersion;
    }
    manifest.permissions = (manifest.permissions || []).filter(
      (permission) => !stripPermissions.includes(permission),
    );
    if (storeKey) {
      manifest.key = (await readFile(STORE_PUBLIC_KEY_FILE, "utf8")).trim();
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    extension = staged;
  }
  // The ID this browser will give the extension, from the key its manifest names.
  const extensionId = extensionIdForKey(
    JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"))
      .key,
  );
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
    // Chrome writes to its profile as it shuts down, and a removal that starts in the middle of
    // that fails with ENOTEMPTY on Linux however long we waited for the process itself.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  };
  const launch = async () => {
    // Records are named for the process that published them, so the wait is for
    // any of them rather than for one known filename.
    const published_record = async () => {
      const entries = await readdir(runtime).catch(() => []);
      return entries.some(
        (name) => name.startsWith("browser_bridge-") && name.endsWith(".json"),
      );
    };
    let published = false;
    for (let attempt = 0; attempt < 120 && !published; attempt += 1) {
      published = await published_record();
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
      // Only when it differs from the display's own scale. A forced 1 alongside an emulated
      // fractional override is what the GPU-less CI runner never answered a capture under, and a
      // headless browser's display is 1x already.
      ...(scaleFactor === 1
        ? []
        : [`--force-device-scale-factor=${scaleFactor}`]),
      ...(headed ? [] : ["--headless=new"]),
      "--remote-debugging-port=0",
      // A CI image whose kernel forbids unprivileged user namespaces leaves Chrome with no usable
      // sandbox, and it refuses to start; --no-sandbox is passed there and nowhere else.
      ...extraArgs,
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
    // An unlistened spawn error is an uncaught event: it would end the run outside any try/catch.
    browser.on("error", (error) => {
      exited = true;
      stderr += `\n${error}`;
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
    await enableDeveloperMode(devtools);
    if (secondProfile) {
      await openSecondProfile(devtools, {
        chrome,
        profile,
        extension,
        extensionId,
        env,
        name: secondProfile,
        extraArgs,
      });
    }
    return devtools;
  };
  return {
    env,
    profile,
    extension,
    extensionId,
    launch,
    close,
    stderr: () => stderr,
  };
}

// Open profile @p name in the running Chrome: a second launch with the same user data directory
// hands its arguments to the running process through its singleton and exits. The extension loaded
// from the command line loads in that profile too -- measured: one service worker of this
// extension's ID per profile -- and its relay reaches the same server.
async function openSecondProfile(
  devtools,
  { chrome, profile, extension, extensionId, env, name, extraArgs },
) {
  const workers = async () => {
    const list = await (
      await fetch(`http://127.0.0.1:${devtools.port}/json/list`)
    ).json();
    return list.filter(
      (entry) =>
        entry.type === "service_worker" &&
        entry.url === `chrome-extension://${extensionId}/background.js`,
    ).length;
  };
  const launcher = spawn(
    chrome,
    [
      `--user-data-dir=${profile}`,
      `--profile-directory=${name}`,
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...extraArgs,
      "about:blank",
    ],
    { env, stdio: "ignore" },
  );
  launcher.on("error", () => {});
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await workers()) >= 2) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`The second profile (${name}) did not start its extension`);
}

// Developer mode on, as in every Chrome this extension runs in: Load unpacked needs it.
// --load-extension skips that check at launch but not on a reload, so without it the extension's
// own chrome.runtime.reload() left it disabled as an "unsupported developer extension" (measured on
// Chrome for Testing 153) and no reload could be tested. Turned on the way the toggle at
// chrome://extensions does it, through that page's own developerPrivate API: a value written into
// the profile's Preferences works on Linux, but Windows and macOS protect that preference and
// reset an edited one at startup.
async function enableDeveloperMode(devtools) {
  const base = `http://127.0.0.1:${devtools.port}`;
  const page = await (
    await fetch(`${base}/json/new?chrome://extensions`, { method: "PUT" })
  ).json();
  try {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () =>
        reject(new Error("chrome://extensions' DevTools socket failed"));
    });
    const call = (id, expression) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("chrome://extensions did not answer")),
          15000,
        );
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id === id) {
            clearTimeout(timer);
            resolve(message.result?.result?.value);
          }
        };
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
    // The page's script loads after the target opens; the API is there once it has.
    let on = false;
    for (let attempt = 0; attempt < 40 && !on; attempt += 1) {
      on = await call(
        attempt * 2 + 1,
        `new Promise((resolve) => {
           if (!globalThis.chrome || !chrome.developerPrivate) { resolve(false); return; }
           chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () =>
             chrome.developerPrivate.getProfileConfiguration((c) => resolve(Boolean(c && c.inDeveloperMode))));
         })`,
      );
      if (!on) {
        await sleep(250);
      }
    }
    socket.close();
    if (!on) {
      throw new Error("Developer mode could not be turned on");
    }
  } finally {
    await fetch(`${base}/json/close/${page.id}`).catch(() => {});
    // Closing answers before the tab is gone. A suite that reads the active tab straight away --
    // as the display matrix does, to check the user's tab stays in front -- has been handed this
    // one (measured once in 35 configurations), so wait until it has left the target list.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const open = await fetch(`${base}/json/list`)
        .then((response) => response.json())
        .catch(() => []);
      if (!open.some((target) => target.id === page.id)) {
        break;
      }
      await sleep(100);
    }
  }
}
