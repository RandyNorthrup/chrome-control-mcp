// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// Uploads the store package to the Chrome Web Store item and submits it for review.
//
// It signs in as the publisher's service account: a JSON Web Token signed (RS256) with the
// account's private key is exchanged at Google's token endpoint for an access token with the
// chromewebstore scope. Then, through the Chrome Web Store API (v2), it uploads the package to the
// item, waits while the store is still processing an upload, and publishes, which submits the
// version for review. Google's own message is reported for any refusal.
//
// The item, its listing and its privacy answers are made in the developer dashboard; the API has no
// call for them, and a publish before they are complete is refused.
//
// Usage:
//   CWS_SERVICE_ACCOUNT_JSON="$(cat key.json)" node scripts/cws_publish.mjs --package pkg.zip
//   CWS_SERVICE_ACCOUNT_JSON=... node scripts/cws_publish.mjs --dry-run
//   CWS_SERVICE_ACCOUNT_JSON=... node scripts/cws_publish.mjs --package pkg.zip --upload-only
//
// --dry-run signs in and reads the item's status, and checks that the item's public key gives the
// item's ID and is the key in browser/store-public-key.txt (compared without its PEM armour or line
// breaks): proof the credentials and IDs are right, with nothing changed.
// --upload-only uploads and waits for the store to accept the package, without submitting it.
//
// CWS_PUBLISHER_ID and CWS_ITEM_ID override the IDs below; CWS_API_BASE overrides the API's
// address (the tests point it at a recorded API).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLISHER_ID = "044c8e44-968f-4e22-9d7a-0aa172fb492d";
export const ITEM_ID = "mbkacllnbffbadcajpkkpelifdkfgcbd";
export const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
export const API_BASE = "https://chromewebstore.googleapis.com";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_LIFETIME_S = 3600;
const REQUEST_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60_000;
// The API's own spelling varies between its enum and its prose; both mean "still processing".
const IN_PROGRESS = new Set(["IN_PROGRESS", "UPLOAD_IN_PROGRESS"]);

export class CwsError extends Error {}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

// The service-account key, from its JSON: the account's address, private key and token endpoint.
export function parseServiceAccount(json) {
  let account;
  try {
    account = JSON.parse(json);
  } catch {
    throw new CwsError("the service-account key is not JSON");
  }
  if (
    typeof account.client_email !== "string" ||
    typeof account.private_key !== "string"
  ) {
    throw new CwsError(
      "the service-account key has no client_email or private_key",
    );
  }
  return {
    clientEmail: account.client_email,
    privateKey: account.private_key,
    tokenUri: account.token_uri ?? DEFAULT_TOKEN_URI,
  };
}

// A signed assertion asking for @p scope as @p account, valid for an hour from @p now (seconds).
export function signAssertion(
  account,
  scope,
  now = Math.floor(Date.now() / 1000),
) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope,
      aud: account.tokenUri,
      iat: now,
      exp: now + TOKEN_LIFETIME_S,
    }),
  );
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${claims}`),
    account.privateKey,
  );
  return `${header}.${claims}.${base64url(signature)}`;
}

// Google's words for a refusal: the JSON error's message (and status), else the body as sent.
export function googleMessage(status, text) {
  try {
    const body = JSON.parse(text);
    if (typeof body.error === "object" && body.error !== null) {
      const parts = [body.error.status, body.error.message].filter(Boolean);
      if (parts.length > 0) {
        return `HTTP ${status}: ${parts.join(": ")}`;
      }
    }
    if (typeof body.error === "string") {
      return `HTTP ${status}: ${body.error}${body.error_description ? `: ${body.error_description}` : ""}`;
    }
  } catch {
    // Not JSON: the raw body is the best account of what was refused.
  }
  return `HTTP ${status}: ${text.trim().slice(0, 2000) || "(empty body)"}`;
}

async function call(fetchImpl, what, url, init) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CwsError(`${what} failed: ${error.message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new CwsError(
      `${what} was refused: ${googleMessage(response.status, text)}`,
    );
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new CwsError(
      `${what} answered with something that is not JSON: ${text.slice(0, 200)}`,
    );
  }
}

// An access token for @p scope, from the token endpoint the key names.
export async function accessToken(fetchImpl, account, scope = SCOPE) {
  const body = new URLSearchParams({
    grant_type: JWT_GRANT,
    assertion: signAssertion(account, scope),
  });
  const reply = await call(fetchImpl, "Signing in", account.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (typeof reply.access_token !== "string") {
    throw new CwsError("Signing in returned no access token");
  }
  return reply.access_token;
}

// The Chrome Web Store API (v2) for one item.
export class StoreItem {
  constructor({
    fetchImpl,
    token,
    publisher = PUBLISHER_ID,
    item = ITEM_ID,
    base = API_BASE,
  }) {
    this.fetchImpl = fetchImpl;
    this.token = token;
    this.name = `publishers/${publisher}/items/${item}`;
    this.base = base.replace(/\/$/, "");
  }

  headers(extra = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  upload(bytes) {
    return call(
      this.fetchImpl,
      "The upload",
      `${this.base}/upload/v2/${this.name}:upload`,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/zip" }),
        body: bytes,
      },
    );
  }

  fetchStatus() {
    return call(
      this.fetchImpl,
      "Reading the item's status",
      `${this.base}/v2/${this.name}:fetchStatus`,
      {
        method: "GET",
        headers: this.headers(),
      },
    );
  }

  publish() {
    return call(
      this.fetchImpl,
      "Submitting for review",
      `${this.base}/v2/${this.name}:publish`,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }),
      },
    );
  }
}

function uploadFailure(reply) {
  return new CwsError(
    `The store did not accept the package: ${JSON.stringify(reply)}`,
  );
}

// Uploads @p bytes and waits until the store has processed them; returns the version it took.
export async function uploadPackage(
  item,
  bytes,
  { sleep, pollIntervalMs = POLL_INTERVAL_MS, pollTimeoutMs = POLL_TIMEOUT_MS },
) {
  const reply = await item.upload(bytes);
  if (reply.uploadState === "SUCCEEDED") {
    return reply.crxVersion ?? null;
  }
  if (!IN_PROGRESS.has(reply.uploadState)) {
    throw uploadFailure(reply);
  }
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new CwsError(
        `The store was still processing the upload after ${Math.round(pollTimeoutMs / 1000)} s`,
      );
    }
    await sleep(pollIntervalMs);
    const status = await item.fetchStatus();
    if (status.lastAsyncUploadState === "SUCCEEDED") {
      return null;
    }
    if (!IN_PROGRESS.has(status.lastAsyncUploadState)) {
      throw uploadFailure(status);
    }
  }
}

// The base64 body of a public key, whether it comes PEM-armoured or bare, without whitespace.
export function keyBody(key) {
  return String(key)
    .replace(/-----(BEGIN|END)[^-]*-----/g, "")
    .replace(/\s+/g, "");
}

// The ID Chrome gives an extension signed with @p key: the first 128 bits of the SHA-256 of the
// key's DER bytes, as the letters a to p.
export function extensionIdForKey(key) {
  const digest = crypto
    .createHash("sha256")
    .update(Buffer.from(keyBody(key), "base64"))
    .digest();
  let id = "";
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
  }
  return id;
}

// A one-line account of fetchStatus's reply.
export function describeStatus(status) {
  const revision = (label, value) => {
    if (!value) {
      return `${label}: none`;
    }
    const versions = (value.distributionChannels ?? [])
      .map((channel) => channel.crxVersion)
      .filter(Boolean);
    return `${label}: ${value.state}${versions.length ? ` (${versions.join(", ")})` : ""}`;
  };
  return [
    `item ${status.itemId ?? "?"}`,
    revision("published", status.publishedItemRevisionStatus),
    revision("submitted", status.submittedItemRevisionStatus),
    `last upload: ${status.lastAsyncUploadState ?? "none in 24 h"}`,
    status.takenDown ? "TAKEN DOWN" : null,
    status.warned ? "warned" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

// The whole run: sign in, then a dry run, an upload, or an upload and a submission.
export async function run({
  fetchImpl = fetch,
  serviceAccountJson,
  packageBytes = null,
  mode = "publish",
  publisher = PUBLISHER_ID,
  item = ITEM_ID,
  base = API_BASE,
  expectedPublicKey = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs,
  pollTimeoutMs,
  log = console.log,
}) {
  const account = parseServiceAccount(serviceAccountJson);
  const token = await accessToken(fetchImpl, account);
  const store = new StoreItem({ fetchImpl, token, publisher, item, base });
  if (mode === "dry-run") {
    const status = await store.fetchStatus();
    let keyNote = "";
    if (status.publicKey) {
      // The ID the item's own key gives it is what Chrome and the native host see, so that is
      // what is checked; the key's wrapping (PEM armour, line breaks) is not.
      const derived = extensionIdForKey(status.publicKey);
      if (derived !== item) {
        throw new CwsError(
          `The item's public key gives the ID ${derived}, not ${item}: these credentials reach a different item`,
        );
      }
      if (
        expectedPublicKey &&
        keyBody(status.publicKey) !== keyBody(expectedPublicKey)
      ) {
        throw new CwsError(
          "The item's public key is not the one in browser/store-public-key.txt",
        );
      }
      keyNote = `; its key gives ${derived}`;
    }
    log(
      `Signed in as ${account.clientEmail}; ${describeStatus(status)}${keyNote}`,
    );
    return { status };
  }
  if (!packageBytes) {
    throw new CwsError("No package to upload");
  }
  const version = await uploadPackage(store, packageBytes, {
    sleep,
    pollIntervalMs,
    pollTimeoutMs,
  });
  log(`Uploaded${version ? ` version ${version}` : ""} to ${item}`);
  if (mode === "upload-only") {
    return { version };
  }
  const published = await store.publish();
  const warnings = published.warningInfo?.warnings ?? [];
  for (const warning of warnings) {
    log(`Store warning: ${warning.reason}: ${warning.description}`);
  }
  log(`Submitted: ${published.state ?? "no state given"}`);
  return { version, state: published.state, warnings };
}

function argument(flag) {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const serviceAccountJson = process.env.CWS_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new CwsError("CWS_SERVICE_ACCOUNT_JSON is not set");
  }
  let mode = "publish";
  if (process.argv.includes("--dry-run")) {
    mode = "dry-run";
  } else if (process.argv.includes("--upload-only")) {
    mode = "upload-only";
  }
  const packagePath = argument("--package");
  if (mode !== "dry-run" && !packagePath) {
    throw new CwsError(
      "usage: cws_publish.mjs --package FILE.zip [--upload-only] | --dry-run",
    );
  }
  const keyPath = path.join(root, "browser/store-public-key.txt");
  await run({
    serviceAccountJson,
    packageBytes: packagePath ? fs.readFileSync(packagePath) : null,
    mode,
    publisher: process.env.CWS_PUBLISHER_ID || PUBLISHER_ID,
    item: process.env.CWS_ITEM_ID || ITEM_ID,
    base: process.env.CWS_API_BASE || API_BASE,
    expectedPublicKey: fs.existsSync(keyPath)
      ? fs.readFileSync(keyPath, "utf8").trim()
      : null,
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    if (error instanceof CwsError) {
      console.error(`chrome web store: ${error.message}`);
      process.exit(1);
    }
    throw error;
  });
}
