// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const args = new Set(process.argv.slice(2));
const configuration =
  process.argv
    .find((arg) => arg.startsWith("--configuration="))
    ?.split("=")[1] || "Release";
const buildDirectory = path.resolve(
  repoRoot,
  process.argv.find((arg) => arg.startsWith("--build-dir="))?.split("=")[1] ||
    "build",
);

const spawnOptions = {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
};

function requireSuccess(result) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const configureArgs = [
  "-S",
  repoRoot,
  "-B",
  buildDirectory,
  "-DBUILD_TESTING=ON",
];
if (process.platform === "win32") {
  configureArgs.push("-A", "x64");
} else {
  configureArgs.push(`-DCMAKE_BUILD_TYPE=${configuration}`);
}

requireSuccess(spawnSync("cmake", configureArgs, spawnOptions));
requireSuccess(
  spawnSync(
    "cmake",
    ["--build", buildDirectory, "--config", configuration, "--parallel"],
    spawnOptions,
  ),
);
if (!args.has("--skip-tests")) {
  requireSuccess(
    spawnSync(
      "ctest",
      [
        "--test-dir",
        buildDirectory,
        "-C",
        configuration,
        "--output-on-failure",
      ],
      spawnOptions,
    ),
  );
}

const executable =
  process.platform === "win32"
    ? path.join(buildDirectory, configuration, "chrome_control_mcp.exe")
    : path.join(buildDirectory, "chrome_control_mcp");
console.log(`MCP server: ${executable}`);
