// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_control.h"

#include "chrome_control_mcp/browser_contract.h"
#include "chrome_control_mcp/browser_extension_installer.h"
#include "chrome_control_mcp/browser_uploads.h"

#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonValue>
#include <QStringList>

#include <thread>

namespace chrome_control_mcp {

namespace {

// What an extension reports when the bridge it was handed speaks another
// protocol version -- matched by text because it arrives as the extension's
// own error message, not as a field.
constexpr QLatin1StringView kProtocolMismatchMarker{"Bridge protocol mismatch"};

// The one thing that fixes a protocol mismatch. Chrome does not reload an
// unpacked extension when its files change, so after an update the copy
// Chrome is running is routinely older (or newer) than the server talking to
// it, and the mismatch text alone names the versions without saying what to
// do about them.
QString protocolMismatchGuidance() {
  return QStringLiteral(
      " Reload the Chrome Control MCP extension at chrome://extensions (or "
      "restart Chrome) so Chrome loads the copy installed with this server.");
}

} // namespace

bool BrowserControl::start(QString *error) {
  started_ = pipe_.start(error);
  if (started_) {
    // start() publishes the rendezvous record: an extension that is running
    // will find it within one of its retry periods, so a call made in the next
    // little while is worth holding for that rather than refusing.
    published_at_ = Clock::now();
  }
  return started_;
}

void BrowserControl::stop() {
  pipe_.stop();
  started_ = false;
}

QJsonArray BrowserControl::toolCatalog() {
  return browser::browserToolCatalog();
}

bool BrowserControl::handles(const QString &name) {
  // The browser_* tools drive the live extension through the bridge. Two
  // families share the prefix but are native tools served by invokeTool, and
  // routing either here would fail with "browser not connected" for a call that
  // never needed a browser: browser_extension_* sets Chrome up in the first
  // place, and browser_update_* inspects and replaces this program's own
  // install, which has to work whether or not a browser is attached.
  return name.startsWith(QStringLiteral("browser_")) &&
         !name.startsWith(QStringLiteral("browser_extension_")) &&
         !name.startsWith(QStringLiteral("browser_update_"));
}

// Reconcile the single-threaded session with the pipe server's async connection
// state. The server bumps its generation on every newly verified relay;
// observing a new generation means a fresh browser session (the old ref_index
// is dead), and losing the connection means no browser is reachable. Called on
// the MCP thread immediately before each tool call, so the session never acts
// on a connection it has not accounted for.
void BrowserControl::syncSessionToConnection() {
  const bool connected = pipe_.clientConnected();
  const quint64 generation = pipe_.connectionGeneration();
  if (connected) {
    last_connected_at_ = Clock::now();
  }
  if (connected && generation != observed_generation_) {
    session_.onHostConnected();
    observed_generation_ = generation;
  } else if (!connected && session_.connected()) {
    session_.onHostDisconnected();
  }
}

bool BrowserControl::relayPlausiblyAttaching() const {
  const Clock::time_point now = Clock::now();
  const auto recent = [now](const std::optional<Clock::time_point> &when) {
    return when.has_value() && now - *when < kRelayAttachGrace;
  };
  return recent(published_at_) || recent(last_connected_at_);
}

void BrowserControl::awaitAttachingRelay() const {
  const Clock::time_point deadline = Clock::now() + relay_attach_wait_;
  while (!pipe_.clientConnected() && Clock::now() < deadline) {
    std::this_thread::sleep_for(kRelayAttachPoll);
  }
}

ToolResult BrowserControl::invoke(const QString &name,
                                  const QJsonObject &arguments) {
  ToolResult result = dispatch(name, arguments);
  if (result.is_error && result.text.contains(kProtocolMismatchMarker)) {
    result.text += protocolMismatchGuidance();
  }
  return result;
}

ToolResult BrowserControl::dispatch(const QString &name,
                                    const QJsonObject &arguments) {
  // A server that stood down at launch (another instance owned the bridge at
  // that instant) tries again on demand: the owner may have been a short-lived
  // tool listing that has long since exited, and a browser tool call is the
  // moment the bridge is wanted.
  if (!started_) {
    QString why;
    if (!start(&why)) {
      return {.text = QStringLiteral("Browser control is unavailable: %1")
                          .arg(why.isEmpty()
                                   ? QStringLiteral(
                                         "the bridge pipe failed to start.")
                                   : why),
              .is_error = true,
              .image_base64 = {},
              .image_mime = {}};
    }
  }
  // No relay yet: make sure the extension can still find this server. The
  // rendezvous record can be lost to a concurrent short-lived instance that
  // wrote it last and removed it on exit; re-publishing it here means the
  // extension's next reconnect lands on this session without a restart.
  if (!pipe_.clientConnected()) {
    QString why;
    if (!pipe_.ensurePublished(&why)) {
      return {.text = QStringLiteral("Browser not connected: %1").arg(why),
              .is_error = true,
              .image_base64 = {},
              .image_mime = {}};
    }
    // The first call of a newly started agent routinely lands before the
    // extension has found this server, and a call just after an extension
    // reload lands while it reattaches. Refusing those sends the agent off to
    // diagnose a browser that is seconds from working, so they wait a little
    // -- but only when an attachment is plausibly on its way, so a server with
    // no browser at all still answers at once.
    if (relayPlausiblyAttaching()) {
      awaitAttachingRelay();
    }
  }
  syncSessionToConnection();
  // The calls that are not one command: their files go first, in pieces the
  // bridge can carry, and the command that uses them follows.
  if (name == QLatin1String("browser_upload") ||
      (name == QLatin1String("browser_clipboard") &&
       arguments.contains(QStringLiteral("paths")))) {
    return invokeWithFiles(name, arguments);
  }
  const browser::BrowserBridgeSession::Outgoing outgoing =
      session_.beginCommand(name, arguments);
  // "The extension is not attached" is true but unhelpful when the reason is
  // that Chrome starts a DIFFERENT copy of this program: the relay it launches
  // refuses a bridge served by another image, correctly, and the operator is
  // left with nothing to act on. Say which executable is registered and which
  // one is serving.
  if (!outgoing.ok && !pipe_.clientConnected()) {
    const BrowserExtensionInstaller installer;
    const QString note =
        nativeHostRegistrationNote(installer.registeredHostExecutable(),
                                   QCoreApplication::applicationFilePath());
    if (!note.isEmpty()) {
      return {.text = outgoing.error + QStringLiteral(" ") + note,
              .is_error = true,
              .image_base64 = {},
              .image_mime = {}};
    }
  }
  return exchange(outgoing);
}

ToolResult BrowserControl::exchange(
    const browser::BrowserBridgeSession::Outgoing &outgoing) {
  if (!outgoing.ok) {
    return {.text = outgoing.error,
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  const BrowserBridgePipeServer::Exchange exchange =
      pipe_.sendCommandAwaitReply(outgoing.frame);
  if (!exchange.ok) {
    // The transport failed (no relay, or a deadline/reset). Retire the
    // outstanding op so a late-arriving reply for it can never be mis-paired to
    // the next call.
    session_.retireOutstanding();
    return {.text = exchange.error,
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  const browser::BrowserBridgeSession::Incoming incoming =
      session_.onReply(exchange.reply);
  if (!incoming.matched) {
    return {.text = QStringLiteral(
                "The browser reply did not correlate to the request."),
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  if (incoming.is_error) {
    return {.text = incoming.error,
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  return {.text = incoming.text,
          .is_error = false,
          .image_base64 = incoming.image_base64,
          .image_mime = incoming.image_mime};
}

ToolResult BrowserControl::invokeWithFiles(const QString &name,
                                           const QJsonObject &arguments) {
  // Refuse a malformed call before any file is read or sent: chunks that went
  // ahead of a command the contract then rejects would sit in the extension's
  // buffer, which holds only a few uploads, until the session ended.
  const QString refused = session_.argumentsError(name, arguments);
  if (!refused.isEmpty()) {
    return {.text = refused,
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  // Read and bound the files BEFORE anything is sent: a refusal that arrives
  // after half a file is on the wire has already spent the bridge on bytes the
  // page was never going to get.
  QStringList paths;
  const QJsonArray requested =
      arguments.value(QStringLiteral("paths")).toArray();
  // `const auto &`: a QJsonArray's iterator hands back QJsonValueConstRef, and
  // binding that to a QJsonValue reference converts through a temporary on
  // every element.
  for (const auto &value : requested) {
    paths.append(value.toString());
  }
  const browser::UploadBatch batch = browser::readUploadFiles(
      paths, QString::fromLocal8Bit(qgetenv("CHROME_CONTROL_MCP_UPLOAD_ROOTS")),
      name);
  if (!batch.ok) {
    return {.text = batch.error,
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  // Every file gets an id of its own so the extension can hold several at once
  // and match each piece to the file it belongs to.
  QJsonArray manifest;
  int index = 0;
  for (const browser::UploadFile &file : batch.files) {
    const QString upload_id =
        QStringLiteral("u-%1-%2").arg(++upload_counter_).arg(index++);
    const int total = static_cast<int>(file.chunks.size());
    for (int seq = 0; seq < total; ++seq) {
      const browser::BrowserBridgeSession::Outgoing chunk =
          session_.beginInternalCommand(
              QStringLiteral("uploadChunk"),
              QJsonObject{{QStringLiteral("upload_id"), upload_id},
                          {QStringLiteral("seq"), seq},
                          {QStringLiteral("total"), total},
                          {QStringLiteral("data"), file.chunks.at(seq)}});
      const ToolResult sent = exchange(chunk);
      if (sent.is_error) {
        // Say which file and where it stopped: "the upload failed" leaves a
        // caller with several files and no idea which one to look at.
        return {.text =
                    QStringLiteral("Sending %1 failed at piece %2 of %3: %4")
                        .arg(file.name)
                        .arg(seq + 1)
                        .arg(total)
                        .arg(sent.text),
                .is_error = true,
                .image_base64 = {},
                .image_mime = {}};
      }
    }
    manifest.append(QJsonObject{{QStringLiteral("upload_id"), upload_id},
                                {QStringLiteral("name"), file.name},
                                {QStringLiteral("mime"), file.mime},
                                {QStringLiteral("size"), file.size}});
  }
  // The element is resolved the way every other by-ref tool resolves it, and
  // the manifest is added to that translated command: the paths themselves stop
  // here, so nothing downstream ever learns where on the disk a file came from.
  browser::BrowserBridgeSession::Outgoing apply =
      session_.beginCommand(name, arguments);
  if (apply.ok) {
    apply.frame.insert(QStringLiteral("files"), manifest);
  }
  return exchange(apply);
}

} // namespace chrome_control_mcp
