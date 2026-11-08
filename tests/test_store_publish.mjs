// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The Chrome Web Store package and its publishing, against a recorded API.
//
// The package has to be what the store accepts -- the extension's files with the manifest's `key`
// removed, the release's version, the icons, a description within 132 characters -- and refuse a
// manifest that would be refused after the upload. The publisher has to sign in the way Google's
// token endpoint checks (an RS256 assertion for the chromewebstore scope), upload, wait out an
// upload the store is still processing, submit, and pass on Google's own words when it refuses.
// The API here is a local HTTP server that checks what a real one checks: the assertion's
// signature against the key pair the test made, the bearer token, the item's path.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CwsError,
  SCOPE,
  googleMessage,
  run,
} from "../scripts/cws_publish.mjs";
import {
  DESCRIPTION_MAX,
  StorePackageError,
  buildStorePackage,
  readZip,
} from "../scripts/store_package.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = path.join(ROOT, "browser/extension");
const PUBLISHER = "pub-0000";
const ITEM = "mbkacllnbffbadcajpkkpelifdkfgcbd";
const TOKEN = "token-for-tests";

function extensionVersion() {
  return JSON.parse(
    fs.readFileSync(path.join(EXTENSION, "manifest.json"), "utf8"),
  ).version;
}

// A copy of the extension folder whose manifest @p change rewrites.
function extensionCopy(t, change) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccm-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(EXTENSION, dir, { recursive: true });
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  change?.(manifest, dir);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

function filesUnder(dir, relative = "") {
  return fs
    .readdirSync(path.join(dir, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory() ? filesUnder(dir, child) : [child];
    });
}

test("the store package is the extension's files with the manifest's key removed", () => {
  const version = extensionVersion();
  const { bytes } = buildStorePackage({ extensionDir: EXTENSION, version });
  const entries = readZip(bytes);
  const names = entries.map((entry) => entry.name).sort();
  assert.deepEqual(names, filesUnder(EXTENSION).sort());

  const original = JSON.parse(
    fs.readFileSync(path.join(EXTENSION, "manifest.json"), "utf8"),
  );
  assert.equal(
    typeof original.key,
    "string",
    "the unpacked manifest keeps its key",
  );
  const packaged = JSON.parse(
    entries.find((entry) => entry.name === "manifest.json").data,
  );
  assert.equal(packaged.key, undefined);
  const { key: _key, ...rest } = original;
  assert.deepEqual(packaged, rest);
  assert.equal(packaged.version, version);
  assert.ok(packaged.description.length <= DESCRIPTION_MAX);
  for (const size of ["16", "32", "48", "128"]) {
    assert.ok(names.includes(packaged.icons[size]), `${size}px icon`);
  }
  // Every other file goes in byte for byte.
  for (const entry of entries.filter((item) => item.name !== "manifest.json")) {
    assert.ok(
      entry.data.equals(fs.readFileSync(path.join(EXTENSION, entry.name))),
      entry.name,
    );
  }
  // The same folder gives the same bytes.
  assert.ok(
    bytes.equals(buildStorePackage({ extensionDir: EXTENSION, version }).bytes),
  );
});

test("the store package is a zip another reader accepts", (t) => {
  const { bytes, files } = buildStorePackage({
    extensionDir: EXTENSION,
    version: extensionVersion(),
  });
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccm-zip-")),
    "store.zip",
  );
  t.after(() =>
    fs.rmSync(path.dirname(file), { recursive: true, force: true }),
  );
  fs.writeFileSync(file, bytes);
  const check =
    "import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(len(z.namelist()))";
  for (const python of ["python3", "python"]) {
    const result = spawnSync(python, ["-I", "-c", check, file], {
      encoding: "utf8",
    });
    if (result.status === 0) {
      assert.equal(Number(result.stdout.trim()), files.length);
      return;
    }
  }
  t.skip("no Python on this machine to read the zip independently");
});

test("a manifest the store would refuse is refused before the upload", async (t) => {
  const version = extensionVersion();
  const refusals = [
    [
      "a description over 132 characters",
      (m) => (m.description = "x".repeat(DESCRIPTION_MAX + 1)),
      /133 characters/,
    ],
    ["no description", (m) => delete m.description, /no description/],
    ["another version", (m) => (m.version = "0.0.1"), /version is 0\.0\.1/],
    [
      "an icon missing from the manifest",
      (m) => delete m.icons["48"],
      /no 48px icon/,
    ],
    [
      "an icon file missing from the folder",
      (m, dir) => fs.rmSync(path.join(dir, m.icons["128"])),
      /128px icon .* is not in the folder/,
    ],
    [
      "manifest version 2",
      (m) => (m.manifest_version = 2),
      /manifest_version is 2/,
    ],
  ];
  for (const [what, change, message] of refusals) {
    await t.test(what, (sub) => {
      const dir = extensionCopy(sub, change);
      assert.throws(
        () => buildStorePackage({ extensionDir: dir, version }),
        (error) => {
          assert.ok(error instanceof StorePackageError);
          assert.match(error.message, message);
          return true;
        },
      );
    });
  }
  // Exactly 132 characters is within the limit.
  const dir = extensionCopy(
    t,
    (m) => (m.description = "x".repeat(DESCRIPTION_MAX)),
  );
  assert.equal(
    JSON.parse(
      readZip(buildStorePackage({ extensionDir: dir, version }).bytes).find(
        (e) => e.name === "manifest.json",
      ).data,
    ).description.length,
    DESCRIPTION_MAX,
  );
});

// A recorded Chrome Web Store API and token endpoint. @p script says what each call answers.
async function recordedApi(t, script) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = request.url;
      const call = {
        method: request.method,
        url,
        headers: request.headers,
        body,
      };
      calls.push(call);
      const reply = (status, json) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(typeof json === "string" ? json : JSON.stringify(json));
      };
      if (url === "/token") {
        const form = new URLSearchParams(body.toString());
        const [header, claims, signature] = (form.get("assertion") ?? "").split(
          ".",
        );
        const valid = crypto.verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          publicKey,
          Buffer.from(signature ?? "", "base64url"),
        );
        call.assertion = {
          valid,
          header: JSON.parse(Buffer.from(header, "base64url")),
          claims: JSON.parse(Buffer.from(claims, "base64url")),
          grant: form.get("grant_type"),
        };
        if (!valid) {
          reply(400, {
            error: "invalid_grant",
            error_description: "Invalid JWT Signature.",
          });
          return;
        }
        const answer = script.token?.();
        if (answer) {
          reply(...answer);
          return;
        }
        reply(200, {
          access_token: TOKEN,
          expires_in: 3600,
          token_type: "Bearer",
        });
        return;
      }
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        reply(401, {
          error: {
            code: 401,
            message: "Request is missing required authentication credential.",
            status: "UNAUTHENTICATED",
          },
        });
        return;
      }
      const name = `publishers/${PUBLISHER}/items/${ITEM}`;
      const routes = {
        [`POST /upload/v2/${name}:upload`]: script.upload,
        [`GET /v2/${name}:fetchStatus`]: script.status,
        [`POST /v2/${name}:publish`]: script.publish,
      };
      const handler = routes[`${request.method} ${url}`];
      if (!handler) {
        reply(404, {
          error: {
            code: 404,
            message: `No route ${request.method} ${url}`,
            status: "NOT_FOUND",
          },
        });
        return;
      }
      reply(...handler(call));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const serviceAccountJson = JSON.stringify({
    type: "service_account",
    client_email: "publisher@chrome-control-mcp.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    token_uri: `${base}/token`,
  });
  return { base, calls, serviceAccountJson };
}

function runAgainst(api, options) {
  const lines = [];
  return run({
    serviceAccountJson: api.serviceAccountJson,
    publisher: PUBLISHER,
    item: ITEM,
    base: api.base,
    sleep: async () => {},
    pollIntervalMs: 1,
    log: (line) => lines.push(line),
    ...options,
  }).then((result) => ({ ...result, lines }));
}

test("a release signs in, uploads, waits out processing and submits", async (t) => {
  let polls = 0;
  const api = await recordedApi(t, {
    upload: () => [
      200,
      { name: "x", itemId: ITEM, uploadState: "IN_PROGRESS" },
    ],
    status: () => {
      polls += 1;
      return [
        200,
        {
          itemId: ITEM,
          lastAsyncUploadState: polls < 3 ? "IN_PROGRESS" : "SUCCEEDED",
        },
      ];
    },
    publish: () => [
      200,
      { itemId: ITEM, state: "PENDING_REVIEW", warningInfo: { warnings: [] } },
    ],
  });
  const packageBytes = buildStorePackage({
    extensionDir: EXTENSION,
    version: extensionVersion(),
  }).bytes;
  const result = await runAgainst(api, { packageBytes });
  assert.equal(result.state, "PENDING_REVIEW");
  assert.equal(polls, 3);

  const [signIn, upload, ...rest] = api.calls;
  assert.equal(signIn.url, "/token");
  assert.equal(signIn.assertion.valid, true);
  assert.equal(
    signIn.assertion.grant,
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  assert.deepEqual(signIn.assertion.header, { alg: "RS256", typ: "JWT" });
  assert.equal(signIn.assertion.claims.scope, SCOPE);
  assert.equal(signIn.assertion.claims.aud, `${api.base}/token`);
  assert.equal(
    signIn.assertion.claims.iss,
    "publisher@chrome-control-mcp.iam.gserviceaccount.com",
  );
  assert.equal(signIn.assertion.claims.exp - signIn.assertion.claims.iat, 3600);
  assert.ok(
    upload.body.equals(packageBytes),
    "the package goes up byte for byte",
  );
  assert.equal(upload.headers["content-type"], "application/zip");
  const submit = rest.at(-1);
  assert.equal(submit.url, `/v2/publishers/${PUBLISHER}/items/${ITEM}:publish`);
  assert.deepEqual(JSON.parse(submit.body), { publishType: "DEFAULT_PUBLISH" });
});

test("an upload the store finishes at once is submitted without polling", async (t) => {
  const api = await recordedApi(t, {
    upload: () => [
      200,
      { itemId: ITEM, crxVersion: "1.13.0", uploadState: "SUCCEEDED" },
    ],
    status: () => assert.fail("no poll is needed"),
    publish: () => [
      200,
      {
        itemId: ITEM,
        state: "PENDING_REVIEW",
        warningInfo: {
          warnings: [{ reason: "BROAD_HOST", description: "<all_urls>" }],
        },
      },
    ],
  });
  const result = await runAgainst(api, { packageBytes: Buffer.from("zip") });
  assert.equal(result.version, "1.13.0");
  assert.deepEqual(result.warnings, [
    { reason: "BROAD_HOST", description: "<all_urls>" },
  ]);
  assert.ok(result.lines.some((line) => line.includes("BROAD_HOST")));
});

test("--upload-only uploads and does not submit", async (t) => {
  const api = await recordedApi(t, {
    upload: () => [
      200,
      { itemId: ITEM, crxVersion: "1.13.0", uploadState: "SUCCEEDED" },
    ],
    publish: () => assert.fail("upload-only must not submit"),
  });
  const result = await runAgainst(api, {
    packageBytes: Buffer.from("zip"),
    mode: "upload-only",
  });
  assert.equal(result.version, "1.13.0");
  assert.equal(api.calls.length, 2);
});

test("a refusal is reported in Google's own words", async (t) => {
  await t.test("the submission", async (sub) => {
    const message =
      "Publish condition not met: You must provide a privacy policy.";
    const api = await recordedApi(sub, {
      upload: () => [200, { itemId: ITEM, uploadState: "SUCCEEDED" }],
      publish: () => [
        400,
        { error: { code: 400, message, status: "FAILED_PRECONDITION" } },
      ],
    });
    await assert.rejects(
      runAgainst(api, { packageBytes: Buffer.from("zip") }),
      (error) => {
        assert.ok(error instanceof CwsError);
        assert.match(error.message, /Submitting for review was refused/);
        assert.ok(error.message.includes(message));
        assert.ok(error.message.includes("FAILED_PRECONDITION"));
        return true;
      },
    );
  });
  await t.test("the upload", async (sub) => {
    const api = await recordedApi(sub, {
      upload: () => [
        200,
        {
          itemId: ITEM,
          uploadState: "FAILED",
          itemError: [{ error_detail: "Bad manifest" }],
        },
      ],
      publish: () => assert.fail("a failed upload must not be submitted"),
    });
    await assert.rejects(
      runAgainst(api, { packageBytes: Buffer.from("zip") }),
      /did not accept the package.*Bad manifest/,
    );
  });
  await t.test("processing that fails", async (sub) => {
    const api = await recordedApi(sub, {
      upload: () => [200, { itemId: ITEM, uploadState: "IN_PROGRESS" }],
      status: () => [200, { itemId: ITEM, lastAsyncUploadState: "FAILED" }],
      publish: () => assert.fail("a failed upload must not be submitted"),
    });
    await assert.rejects(
      runAgainst(api, { packageBytes: Buffer.from("zip") }),
      /did not accept the package.*FAILED/,
    );
  });
  await t.test("signing in", async (sub) => {
    const api = await recordedApi(sub, {
      token: () => [
        400,
        {
          error: "unauthorized_client",
          error_description: "Client is unauthorized.",
        },
      ],
    });
    await assert.rejects(
      runAgainst(api, { mode: "dry-run" }),
      /Signing in was refused: HTTP 400: unauthorized_client: Client is unauthorized\./,
    );
  });
  await t.test("a key that is not the account's", async (sub) => {
    const api = await recordedApi(sub, {});
    const other = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey;
    const account = JSON.parse(api.serviceAccountJson);
    account.private_key = other.export({ type: "pkcs8", format: "pem" });
    await assert.rejects(
      runAgainst(api, {
        serviceAccountJson: JSON.stringify(account),
        mode: "dry-run",
      }),
      /invalid_grant: Invalid JWT Signature/,
    );
  });
});

test("processing that never ends gives up with a reason", async (t) => {
  const api = await recordedApi(t, {
    upload: () => [200, { itemId: ITEM, uploadState: "IN_PROGRESS" }],
    status: () => [200, { itemId: ITEM, lastAsyncUploadState: "IN_PROGRESS" }],
  });
  await assert.rejects(
    runAgainst(api, {
      packageBytes: Buffer.from("zip"),
      pollTimeoutMs: 20,
      sleep: () => new Promise((r) => setTimeout(r, 5)),
    }),
    /still processing the upload/,
  );
});

test("--dry-run signs in and reads the status, and changes nothing", async (t) => {
  const publicKey = fs
    .readFileSync(path.join(ROOT, "browser/store-public-key.txt"), "utf8")
    .trim();
  const status = {
    itemId: ITEM,
    publicKey,
    submittedItemRevisionStatus: {
      state: "PENDING_REVIEW",
      distributionChannels: [{ crxVersion: "1.13.0" }],
    },
  };
  const api = await recordedApi(t, {
    status: () => [200, status],
    upload: () => assert.fail("a dry run uploads nothing"),
    publish: () => assert.fail("a dry run submits nothing"),
  });
  const result = await runAgainst(api, {
    mode: "dry-run",
    expectedPublicKey: publicKey,
  });
  assert.deepEqual(result.status, status);
  assert.deepEqual(
    api.calls.map((call) => `${call.method} ${call.url}`),
    [
      "POST /token",
      `GET /v2/publishers/${PUBLISHER}/items/${ITEM}:fetchStatus`,
    ],
  );
  assert.match(
    result.lines[0],
    /published: none; submitted: PENDING_REVIEW \(1\.13\.0\)/,
  );

  // Credentials that reach some other item are caught before a release relies on them.
  const elsewhere = await recordedApi(t, {
    status: () => [200, { ...status, publicKey: "MIIB-other" }],
  });
  await assert.rejects(
    runAgainst(elsewhere, { mode: "dry-run", expectedPublicKey: publicKey }),
    /reach a different item/,
  );
});

test("Google's error bodies are read in each of their shapes", () => {
  assert.equal(
    googleMessage(
      403,
      JSON.stringify({
        error: {
          code: 403,
          message: "The caller does not have permission",
          status: "PERMISSION_DENIED",
        },
      }),
    ),
    "HTTP 403: PERMISSION_DENIED: The caller does not have permission",
  );
  assert.equal(
    googleMessage(400, JSON.stringify({ error: "invalid_grant" })),
    "HTTP 400: invalid_grant",
  );
  assert.equal(
    googleMessage(502, "<html>Bad Gateway</html>"),
    "HTTP 502: <html>Bad Gateway</html>",
  );
  assert.equal(googleMessage(500, ""), "HTTP 500: (empty body)");
});
