// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

const PROVIDER_ID = "chrome-control-mcp";
const SERVER_LABEL = "Chrome Control MCP";

/** What `chrome_control_mcp --install` prints on its single output line. */
interface InstallReport {
  ok: boolean;
  error?: string;
  version?: string;
  command?: string;
  extension_path?: string;
  native_host?: string;
}

/**
 * The binary shipped inside this extension, for the platform this VSIX targets.
 *
 * The marketplace serves a platform-specific VSIX, so exactly one binary is
 * present and there is nothing to choose between. A universal VSIX installed by
 * hand on the wrong platform has none, which is worth a clear message rather
 * than a spawn failure.
 */
function bundledExecutable(context: vscode.ExtensionContext): string {
  const name =
    process.platform === "win32"
      ? "chrome_control_mcp.exe"
      : "chrome_control_mcp";
  return path.join(context.extensionUri.fsPath, "bin", name);
}

/**
 * A VSIX is a zip, and the executable bit does not reliably survive the trip
 * through it on Linux and macOS. Setting it is cheap and idempotent; failing to
 * set it is not fatal on its own, because the file may already be executable.
 */
function ensureExecutable(file: string): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    // Reported later by the spawn itself, with a message that names the cause.
  }
}

/**
 * Put the bundled build into the managed install layout and return where it
 * landed.
 *
 * The extension deliberately does not compute the install root itself. That
 * root, the version directory under it, and the stable link are the server's
 * own rules, and a second copy of those rules here would be free to drift from
 * them without anything failing loudly. Asking the binary keeps one answer.
 *
 * Installing is idempotent: when the bundled version is already installed and
 * already current, the server says so without copying anything, so this is
 * cheap enough to run on every activation.
 */
async function ensureInstalled(
  executable: string,
  log: vscode.LogOutputChannel,
): Promise<InstallReport> {
  ensureExecutable(executable);
  try {
    const { stdout } = await execFileAsync(executable, ["--install"], {
      timeout: 120000,
      windowsHide: true,
    });
    const report = JSON.parse(stdout.trim()) as InstallReport;
    if (report.ok) {
      log.info(
        `Chrome Control MCP ${report.version} ready at ${report.command}`,
      );
    } else {
      log.error(`Install failed: ${report.error ?? "no reason given"}`);
    }
    return report;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error(`Could not run ${executable}: ${reason}`);
    return { ok: false, error: reason };
  }
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const log = vscode.window.createOutputChannel("Chrome Control MCP", {
    log: true,
  });
  context.subscriptions.push(log);

  const executable = bundledExecutable(context);
  if (!fs.existsSync(executable)) {
    log.error(
      `No server binary is bundled for ${process.platform}. Install the ` +
        `Chrome Control MCP extension from the marketplace, which serves a ` +
        `build for your platform.`,
    );
    return;
  }

  let installed = await ensureInstalled(executable, log);
  const didChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(didChange);

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: didChange.event,
      provideMcpServerDefinitions: () => {
        if (!installed.ok || !installed.command) {
          return [];
        }
        // The command is the stable link, never a version directory, so this
        // definition keeps naming the right binary after the server updates
        // itself. `version` changes when it does, which is the editor's cue to
        // refresh the tool list.
        return [
          new vscode.McpStdioServerDefinition(
            SERVER_LABEL,
            installed.command,
            [],
            {},
            installed.version,
          ),
        ];
      },
      resolveMcpServerDefinition: (server) => server,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("chromeControlMcp.repair", async () => {
      installed = await ensureInstalled(executable, log);
      didChange.fire();
      if (installed.ok) {
        void vscode.window.showInformationMessage(
          `Chrome Control MCP ${installed.version} is installed at ${installed.command}.`,
        );
      } else {
        void vscode.window.showErrorMessage(
          `Chrome Control MCP could not be installed: ${installed.error ?? "no reason given"}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "chromeControlMcp.openExtensionFolder",
      async () => {
        if (!installed.ok || !installed.extension_path) {
          void vscode.window.showErrorMessage(
            "Chrome Control MCP is not installed yet. Run “Chrome Control MCP: Repair install” first.",
          );
          return;
        }
        // Chrome cannot be made to load an unpacked extension from the outside:
        // branded Chrome 137 and later ignore --load-extension, and policy
        // installation needs a Web Store listing. Opening the folder and saying
        // the three clicks is the whole of what can be done from here.
        await vscode.env.clipboard.writeText(installed.extension_path);
        void vscode.window.showInformationMessage(
          `Folder path copied. In Chrome open chrome://extensions, turn on Developer mode, choose Load unpacked, and pick ${installed.extension_path}. This is a one-time step; updates reuse the same folder.`,
        );
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(path.join(installed.extension_path, "manifest.json")),
        );
      },
    ),
  );
}

export function deactivate(): void {
  // The server is a child of the editor's MCP host, which stops it. Nothing
  // installed on disk is removed here: an uninstall of this extension should
  // not take away a server the user may also have configured by hand.
}
