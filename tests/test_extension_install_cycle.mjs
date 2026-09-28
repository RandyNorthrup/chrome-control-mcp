// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// browser_extension_install / _status / _uninstall, driven through the real MCP server against a
// real registration.
//
// WHY THIS EXISTS
// These three tools write and delete the one thing that makes the whole bridge reachable: the
// native-messaging registration Chrome reads to find this program. Until now nothing had ever run
// browser_extension_uninstall -- not the live suite, which cannot uninstall the registration it is
// using, and not a unit test, which stops at the installer class and never reaches the tool. A run
// on a clean Windows VM tried it and was blocked by the agent's own safety check, so it stayed
// unexercised on the one path that matters: the tool a model actually calls.
//
// What made it untestable was the registration being a single fixed location per user. POSIX had
// CHROME_CONTROL_MCP_NATIVE_HOST_DIR from the beginning; Windows had no equivalent, so the only
// key to test against was the user's own. CHROME_CONTROL_MCP_NATIVE_HOST_KEY is that missing half.
// Chrome still reads only the fixed key -- this buys a way to run install and uninstall for real
// without touching it.
//
// Every assertion below is about a real registration in a real registry or a real directory. The
// guard rails at the top are what keep it out of the user's.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HOST_NAME = "com.chromecontrolmcp.browser";
const REAL_KEY = `Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
// Named in the environment, not on argv: `node --test` reads every positional argument as
// another test file to run, and a path to an .exe fails the run with ERR_UNKNOWN_FILE_EXTENSION
// before this suite's own result is even reported.
const executable = path.resolve(
  process.env.CHROME_CONTROL_MCP_TEST_EXECUTABLE ||
    (process.platform === "win32"
      ? path.join(repoRoot, "build", "Release", "chrome_control_mcp.exe")
      : path.join(repoRoot, "build", "chrome_control_mcp")),
);

// -- the real registration, read directly ------------------------------------
//
// Read through the operating system rather than through the code under test: a bug that makes the
// installer agree with itself about a registration that is not there is exactly what this is
// looking for.

function windowsKeyValue(subkey) {
  const shown = spawnSync("reg", ["query", `HKCU\\${subkey}`, "/ve"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (shown.status !== 0) {
    return null; // absent, which is a fact and not a failure
  }
  const match = shown.stdout.match(/REG_SZ\s+(.+?)\s*$/m);
  return match ? match[1] : "";
}

const registrationOf = (env) =>
  process.platform === "win32"
    ? windowsKeyValue(env.CHROME_CONTROL_MCP_NATIVE_HOST_KEY)
    : existsSync(
          path.join(
            env.CHROME_CONTROL_MCP_NATIVE_HOST_DIR,
            `${HOST_NAME}.json`,
          ),
        )
      ? "present"
      : null;

const realRegistration = () =>
  process.platform === "win32"
    ? windowsKeyValue(REAL_KEY)
    : "not read on this platform";

// -- one MCP session ---------------------------------------------------------

async function callTools(env, calls) {
  const child = spawn(executable, [], {
    env: { ...process.env, ...env, CHROME_CONTROL_MCP_MODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const responses = [];
  readline
    .createInterface({ input: child.stdout })
    .on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "install-cycle", version: "1" },
      },
    })}\n`,
  );
  calls.forEach((name, index) => {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: index + 2,
        method: "tools/call",
        params: { name, arguments: {} },
      })}\n`,
    );
  });
  child.stdin.end();

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, `the server failed: ${stderr}`);
  return calls.map((name, index) => {
    const response = responses.find(({ id }) => id === index + 2);
    assert.ok(response, `no response for ${name}: ${stderr}`);
    const text = response.result.content[0].text;
    try {
      return { name, isError: response.result.isError, ...JSON.parse(text) };
    } catch {
      return { name, isError: response.result.isError, text };
    }
  });
}

// -- the isolated registration this test owns --------------------------------

function isolatedEnvironment(root) {
  const env = {
    // A runtime directory of its own. A server publishes a bridge record when it starts, and one
    // published into the user's would make their running server stand down.
    CHROME_CONTROL_MCP_RUNTIME_DIR: path.join(root, "run"),
    CHROME_CONTROL_MCP_DATA_DIR: path.join(root, "data"),
  };
  if (process.platform === "win32") {
    env.CHROME_CONTROL_MCP_NATIVE_HOST_KEY = `Software\\ChromeControlMCPTests\\${path.basename(root)}\\${HOST_NAME}`;
  } else {
    env.CHROME_CONTROL_MCP_NATIVE_HOST_DIR = path.join(root, "hosts");
  }
  // The guard rail. This test deletes a registration for real, and the one thing it must never
  // delete is the one Chrome is using. Asserted rather than assumed, because the cost of being
  // wrong is the user's install.
  if (process.platform === "win32") {
    assert.notEqual(
      env.CHROME_CONTROL_MCP_NATIVE_HOST_KEY.toLowerCase(),
      REAL_KEY.toLowerCase(),
      "this test must never point at the key Chrome reads",
    );
    assert.match(
      env.CHROME_CONTROL_MCP_NATIVE_HOST_KEY,
      /ChromeControlMCPTests/,
    );
  } else {
    assert.ok(
      env.CHROME_CONTROL_MCP_NATIVE_HOST_DIR.startsWith(root),
      "this test must never point at the user's host directory",
    );
  }
  return env;
}

function removeIsolatedKey(env) {
  if (process.platform !== "win32") {
    return;
  }
  const parts = env.CHROME_CONTROL_MCP_NATIVE_HOST_KEY.split("\\");
  const runKey = parts.slice(0, -1).join("\\"); // ...\ChromeControlMCPTests\<this run>
  const testRoot = parts.slice(0, -2).join("\\"); // ...\ChromeControlMCPTests
  const del = (key) =>
    spawnSync("reg", ["delete", `HKCU\\${key}`, "/f"], {
      encoding: "utf8",
      windowsHide: true,
    });
  del(runKey);
  // And the shared root, but ONLY once it is empty: deleting it wholesale would take a
  // concurrent run's registration with it. `reg query` lists subkeys as full paths, so a line
  // naming anything below the root is another run still using it.
  const remaining = spawnSync("reg", ["query", `HKCU\\${testRoot}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  const stillInUse = remaining.stdout
    .split(/\r?\n/)
    .some((line) =>
      line
        .trim()
        .toLowerCase()
        .startsWith(`hkey_current_user\\${testRoot.toLowerCase()}\\`),
    );
  if (remaining.status === 0 && !stillInUse) {
    del(testRoot);
  }
}

test("install, status and uninstall drive a real registration end to end", async (t) => {
  if (!existsSync(executable)) {
    t.skip(`no server binary at ${executable}`);
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "ccm-install-cycle-"));
  const env = isolatedEnvironment(root);
  // What the user's own registration says now, so this can prove it was left alone.
  const realBefore = realRegistration();
  try {
    // 1. Nothing registered yet. Removing a registration that was never there succeeds at the
    // system-call level on both platforms -- a missing key and a missing file are not errors --
    // and the reply used to say "unregistered" for a machine it had not touched. A caller
    // checking whether the bridge was still wired up would read that as proof it had just been
    // taken apart.
    assert.equal(
      registrationOf(env),
      null,
      "the isolated registration starts absent",
    );
    const [empty] = await callTools(env, ["browser_extension_uninstall"]);
    assert.equal(empty.isError, false);
    assert.equal(empty.ok, true);
    assert.equal(empty.summary, "Nothing to unregister");
    assert.match(empty.detail, /nothing was changed/i);

    // 2. Install for real, and read the registration back through the operating system.
    const [installed] = await callTools(env, ["browser_extension_install"]);
    assert.equal(installed.isError, false, JSON.stringify(installed));
    assert.equal(installed.ok, true);
    const registration = registrationOf(env);
    assert.notEqual(
      registration,
      null,
      "install must leave a registration behind",
    );
    if (process.platform === "win32") {
      // The key names the manifest, and the manifest lives in the data directory this run owns.
      // Compared with the separators levelled: Qt writes the path with forward slashes and
      // path.join builds it with backslashes, and the same directory must not read as two.
      const flat = (p) => p.toLowerCase().replaceAll("\\", "/");
      assert.ok(
        flat(registration).startsWith(flat(path.join(root, "data"))),
        `the registration points outside this run: ${registration}`,
      );
    }

    // 3. The status tool agrees with the machine.
    const [status] = await callTools(env, ["browser_extension_status"]);
    assert.equal(status.isError, false);
    assert.equal(status.extension_present, true);
    // "prepared" is the fully-wired state: the extension is staged AND the native host is
    // registered to this very executable. "partial" means one of the two is missing.
    assert.equal(status.state, "prepared");

    // 4. Uninstall, and check the registration is GONE rather than merely reported gone.
    const [removed] = await callTools(env, ["browser_extension_uninstall"]);
    assert.equal(removed.isError, false, JSON.stringify(removed));
    assert.equal(removed.ok, true);
    assert.equal(removed.summary, "Browser extension bridge unregistered");
    // The state the tool reports has to follow the machine: the extension is still staged, the
    // registration is not, which is exactly "partial".
    assert.equal(removed.state, "partial");
    assert.equal(
      registrationOf(env),
      null,
      "the registration is still there after a successful uninstall",
    );

    // 5. And again on the now-empty machine: an uninstall is repeatable and says what it did.
    const [again] = await callTools(env, ["browser_extension_uninstall"]);
    assert.equal(again.summary, "Nothing to unregister");
  } finally {
    removeIsolatedKey(env);
    rmSync(root, { recursive: true, force: true, maxRetries: 20 });
  }
  // The whole point of the guard rails: the user's registration is exactly as it was.
  assert.deepEqual(
    realRegistration(),
    realBefore,
    "this test changed the registration Chrome actually reads",
  );
});
