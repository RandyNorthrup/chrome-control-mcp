// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The live suites' MCP client: newline-delimited JSON-RPC over the server's stdio, with a
// deadline on every request and every pending request failed when the server exits.

import { spawn } from "node:child_process";
import readline from "node:readline";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class McpClient {
  constructor(executable, env = process.env) {
    this.child = spawn(executable, [], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.exited = false;
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    // Without a listener, a spawn error (an executable that is not there) is an uncaught event
    // that takes the whole run down where no try/catch can see it.
    this.child.on("error", (error) => {
      this.exited = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
    this.child.stdin.on("error", () => {
      // A server that died mid-write: the exit handler below fails every pending request with
      // its stderr, which says more than EPIPE does.
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        for (const pending of this.pending.values()) {
          pending.reject(
            new Error(
              `Invalid MCP JSON: ${error.message}: ${line.slice(0, 500)}`,
            ),
          );
        }
        this.pending.clear();
        return;
      }
      const pending = this.pending.get(response.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        pending.resolve(response);
      }
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      const error = new Error(
        `MCP exited code=${code} signal=${signal}; stderr=${this.stderr}`,
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  request(method, params = {}, timeoutMs = 45000) {
    if (this.exited) {
      return Promise.reject(new Error(`MCP already exited: ${this.stderr}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    }).then((response) => {
      if (response.error) {
        throw new Error(
          `MCP ${method} error ${response.error.code}: ${response.error.message}`,
        );
      }
      return response.result;
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  // A tool call's outcome as data: a tool error is an answer, not an exception.
  async tool(name, args = {}, timeoutMs = 45000) {
    const result = await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    );
    return {
      isError: Boolean(result.isError),
      text: textContent(result),
      result,
    };
  }

  async json(name, args = {}, timeoutMs = 45000) {
    const outcome = await this.tool(name, args, timeoutMs);
    if (outcome.isError) {
      throw new Error(`${name} failed: ${outcome.text}`);
    }
    return JSON.parse(outcome.text);
  }

  async close() {
    if (!this.exited) {
      this.child.stdin.end();
      await Promise.race([
        new Promise((resolve) => this.child.once("exit", resolve)),
        sleep(5000),
      ]);
    }
    if (!this.exited) {
      this.child.kill();
      await Promise.race([
        new Promise((resolve) => this.child.once("exit", resolve)),
        sleep(5000),
      ]);
    }
    if (!this.exited) {
      // A server that ignored both is killed outright: this runs in a suite's cleanup, and
      // waiting on it for ever would hold up every configuration behind it.
      this.child.kill("SIGKILL");
      await new Promise((resolve) => this.child.once("exit", resolve));
    }
  }
}

export function textContent(result) {
  const block = Array.isArray(result.content)
    ? result.content.find((item) => item && item.type === "text")
    : null;
  return block && typeof block.text === "string" ? block.text : "";
}

export function jsonContent(result) {
  const text = textContent(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Expected JSON tool content, received: ${text.slice(0, 800)}`,
    );
  }
}

export function refFor(snapshot, accessibleName) {
  const lines = snapshot
    .split(/\r?\n/)
    .filter(
      (candidate) =>
        candidate.includes(`"${accessibleName}"`) &&
        candidate.includes("[ref="),
    );
  if (lines.length > 1) {
    // Two elements answer to this name: whichever came first would bind silently, and the test
    // would be driving an element nobody chose.
    throw new Error(
      `"${accessibleName}" matches ${lines.length} elements in the snapshot; name one of them.`,
    );
  }
  const line = lines[0];
  if (!line) {
    throw new Error(
      `No ref found for accessible name "${accessibleName}". Snapshot: ${snapshot.slice(0, 6000)}`,
    );
  }
  const match = line.match(/\[ref=(e\d+)\]/);
  if (!match) {
    throw new Error(`Malformed ref line for "${accessibleName}": ${line}`);
  }
  return match[1];
}
