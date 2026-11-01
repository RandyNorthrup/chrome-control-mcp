// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The parts of the bridge pipe server that do not depend on whether the
// endpoint is a Windows named pipe or a POSIX socket: publishing and defending
// the rendezvous record, reporting connection state, and the bounded
// ancestor-chain walk.
//
// Accepting, handshaking, verifying the peer, and serving an exchange DO
// differ, and stay in browser_bridge_pipe.cpp and browser_bridge_pipe_posix.cpp
// beside the I/O primitives they are written in terms of.

#include "chrome_control_mcp/browser_bridge_pipe.h"

#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/error_out.h"
#include "chrome_control_mcp/native_ipc.h"

#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>
#include <QStringList>
#include <QVersionNumber>

#include <algorithm>
#include <utility>

namespace chrome_control_mcp {
namespace {

// Windows compares paths case-insensitively; everywhere else "Record.json" and
// "record.json" are different files. Telling our own advertisement from a
// rival's has to follow the platform's own rule.
constexpr Qt::CaseSensitivity kRendezvousPathCase =
#ifdef Q_OS_WIN
    Qt::CaseInsensitive;
#else
    Qt::CaseSensitive;
#endif

} // namespace

quint64 nearestAncestorWithImage(quint64 pid,
                                 const QHash<quint64, quint64> &parent,
                                 const QHash<quint64, QString> &image,
                                 const QString &target_basename_lower,
                                 int max_depth) {
  quint64 current = pid;
  for (int depth = 0; depth < max_depth && current != 0; ++depth) {
    const auto it = parent.constFind(current);
    if (it == parent.constEnd()) {
      break;
    }
    if (image.value(it.value()) == target_basename_lower) {
      return it.value();
    }
    current = it.value();
  }
  return 0;
}

bool ancestorChainContainsImage(quint64 pid,
                                const QHash<quint64, quint64> &parent,
                                const QHash<quint64, QString> &image,
                                const QString &target_basename_lower,
                                int max_depth) {
  return nearestAncestorWithImage(pid, parent, image, target_basename_lower,
                                  max_depth) != 0;
}

BrowserBridgePipeServer::BrowserBridgePipeServer()
    : BrowserBridgePipeServer(Options{}) {}

BrowserBridgePipeServer::BrowserBridgePipeServer(Options options)
    : options_(std::move(options)) {
  rendezvous_path_ = options_.rendezvous_path.isEmpty()
                         ? browserBridgeRendezvousPath(&rendezvous_error_)
                         : options_.rendezvous_path;
}

BrowserBridgePipeServer::~BrowserBridgePipeServer() { stop(); }

namespace {

// The records sitting beside @p own_path, which is where a server's peers are.
// Looking in the default location instead would make an injected path -- the
// seam every pipe test uses -- see the real per-user directory.
QStringList peerRecords(const QString &own_path) {
  return browserBridgeRendezvousRecordsIn(QFileInfo(own_path).absolutePath());
}

} // namespace

int sweepStaleRendezvousRecords(const QString &own_path) {
  int removed = 0;
  for (const QString &record : peerRecords(own_path)) {
    if (record.compare(own_path, kRendezvousPathCase) == 0) {
      continue;
    }
    if (liveBridgeOwnerExists(record)) {
      continue; // still somebody's; only its owner may withdraw it
    }
    if (QFile::remove(record)) {
      ++removed;
    }
  }
  return removed;
}

bool BrowserBridgePipeServer::ensurePublished(QString *error) {
  const std::lock_guard<std::mutex> lifecycle(lifecycle_mutex_);
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (!running_) {
      setError(error, QStringLiteral("Bridge IPC server is not running"));
      return false;
    }
  }
  const qint64 self = currentProcessId();
  RendezvousRecord current;
  const bool present =
      readRendezvousRecord(rendezvous_path_, &current, nullptr);
  if (present && current.app_pid == self && current.pipe_name == pipe_name_ &&
      current.token == token_) {
    return true; // still ours, word for word
  }
  // Missing, ours but rewritten, or left by a server that has exited: publish
  // this server's endpoint so the extension's next relay can find it.
  const RendezvousRecord record{pipe_name_, token_, options_.protocol, self};
  return writeRendezvousRecord(rendezvous_path_, record, error);
}

bool BrowserBridgePipeServer::clientConnected() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return newestLive() != nullptr;
}

quint64 BrowserBridgePipeServer::connectionGeneration() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return generation_;
}

BridgePeerVersions BrowserBridgePipeServer::peerVersions() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  const ConnectionPtr newest = newestLive();
  return newest ? newest->versions : BridgePeerVersions{};
}

QList<BridgeConnectionInfo> BrowserBridgePipeServer::connections() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  QList<BridgeConnectionInfo> live;
  for (const ConnectionPtr &connection : connections_) {
    if (connection->live) {
      live.append({.id = connection->id,
                   .versions = connection->versions,
                   .profile = connection->profile,
                   .browser_pid = connection->browser_pid});
    }
  }
  return live;
}

BrowserBridgePipeServer::ConnectionPtr
BrowserBridgePipeServer::newestLive() const {
  const auto newest = std::find_if(
      connections_.rbegin(), connections_.rend(),
      [](const ConnectionPtr &connection) { return connection->live; });
  return newest != connections_.rend() ? *newest : nullptr;
}

QString BrowserBridgePipeServer::admit(const ConnectionPtr &connection) {
  int live = 0;
  QList<quint64> serving;
  for (const ConnectionPtr &other : connections_) {
    if (other->live) {
      ++live;
      serving.append(other->browser_pid);
    }
  }
  if (live >= kMaxBridgeConnections) {
    return QStringLiteral("too many connections: this server already serves "
                          "%1 Chrome profiles, the most it takes")
        .arg(kMaxBridgeConnections);
  }
  QString other = otherBrowserRefusal(connection->browser_pid, serving,
                                      &browserProcessAlive);
  if (!other.isEmpty()) {
    return other;
  }
  QString older = olderRelayRefusal(connection->browser_pid,
                                    connection->versions.installed, serving);
  if (!older.isEmpty()) {
    return older;
  }
  connection->live = true;
  ++generation_;
  return {};
}

void BrowserBridgePipeServer::reapFinished() {
  std::vector<ConnectionPtr> done;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    for (auto it = connections_.begin(); it != connections_.end();) {
      if ((*it)->finished) {
        done.push_back(*it);
        it = connections_.erase(it);
      } else {
        ++it;
      }
    }
  }
  for (const ConnectionPtr &connection : done) {
    if (connection->thread.joinable()) {
      connection->thread.join();
    }
  }
}

BrowserBridgePipeServer::Exchange
BrowserBridgePipeServer::sendCommandAwaitReply(const QJsonObject &frame) {
  quint64 id = 0;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    const ConnectionPtr newest = newestLive();
    if (newest) {
      id = newest->id;
    }
  }
  return sendCommandAwaitReply(id, frame);
}

BrowserBridgePipeServer::Exchange
BrowserBridgePipeServer::sendCommandAwaitReply(quint64 connection_id,
                                               const QJsonObject &frame) {
  std::unique_lock<std::mutex> lock(mutex_);
  const auto found =
      std::find_if(connections_.cbegin(), connections_.cend(),
                   [connection_id](const ConnectionPtr &candidate) {
                     return candidate->id == connection_id && candidate->live;
                   });
  const ConnectionPtr connection =
      found != connections_.cend() ? *found : nullptr;
  if (!connection || !running_) {
    return {.ok = false,
            .reply = {},
            .error = QStringLiteral("Browser not connected.")};
  }
  if (connection->has_request) {
    return {.ok = false,
            .reply = {},
            .error =
                QStringLiteral("A browser action is already in progress.")};
  }
  // Ask the extension to report progress while it works. The deadline belongs
  // to this transport, so the request for the beats that hold it open belongs
  // here too. An extension older than this server ignores the flag and is
  // simply held to the plain silence budget, as it always was.
  connection->request_frame = frame;
  connection->request_frame.insert(QStringLiteral("progress"), true);
  connection->has_request = true;
  connection->has_response = false;
  cv_.notify_all();
  // Wake on the reply, or on any sign the connection has ended: its thread
  // drops an idle connection whose relay has gone, possibly just after this
  // request was posted. A reconnecting profile is a NEW connection, so a
  // request can never be served by a relay it was not sent to.
  cv_.wait(lock, [this, &connection] {
    return connection->has_response || !running_ || !connection->live;
  });
  // Always clear the slot on the way out: a request left set would be served
  // later by a connection that has moved on.
  const bool got_response = connection->has_response;
  Exchange result{};
  // has_response is set by the connection's own thread in serveConnected();
  // cppcheck's single-threaded flow cannot see that cross-thread write.
  // cppcheck-suppress knownConditionTrueFalse
  if (got_response) {
    result = connection->response;
  } else {
    result = Exchange{.ok = false,
                      .reply = {},
                      .error = QStringLiteral(
                          "Browser connection closed before it replied.")};
  }
  connection->has_request = false;
  connection->has_response = false;
  return result;
}

QString bridgeLabelOrEmpty(const QJsonValue &value, int max_chars) {
  const QString raw = value.toString();
  QString kept;
  kept.reserve(raw.size());
  for (const QChar ch : raw) {
    // As for client names: isPrint refuses control and format characters
    // (bidi overrides that would reorder what an agent reads) and lone
    // surrogates; line and paragraph separators are "printable" and still
    // break a one-line label.
    const QChar::Category category = ch.category();
    if (ch.isPrint() && category != QChar::Separator_Line &&
        category != QChar::Separator_Paragraph) {
      kept.append(ch);
    }
  }
  return kept.simplified().left(max_chars).trimmed();
}

BridgePeerProfile peerProfileFromJson(const QJsonValue &name,
                                      const QJsonValue &email) {
  BridgePeerProfile profile{
      .name = bridgeLabelOrEmpty(name, kMaxProfileNameChars),
      .email = bridgeLabelOrEmpty(email, kMaxProfileEmailChars)};
  // An address, or nothing: one '@' with text either side and no spaces.
  static const QRegularExpression kEmail(
      QRegularExpression::anchoredPattern(QStringLiteral("[^@\\s]+@[^@\\s]+")));
  if (!kEmail.match(profile.email).hasMatch()) {
    profile.email.clear();
  }
  return profile;
}

QString otherBrowserRefusal(quint64 incoming, const QList<quint64> &serving,
                            const std::function<bool(quint64)> &alive) {
  if (incoming == 0) {
    return {};
  }
  const auto other =
      std::find_if(serving.cbegin(), serving.cend(), [&](quint64 pid) {
        return pid != 0 && pid != incoming && alive(pid);
      });
  if (other == serving.cend()) {
    return {};
  }
  return QStringLiteral("another Chrome (process %1) is already being served; "
                        "this server serves the profiles of one Chrome at a "
                        "time")
      .arg(*other);
}

QString olderRelayRefusal(quint64 incoming, const QString &relay_version,
                          const QList<quint64> &serving) {
  // A 1.10.0 relay connects nowhere for a port with no server, so it is
  // never one of these; nor is a relay whose Chrome is not known.
  static const QVersionNumber kRelayKnowsNoWork(1, 10, 0);
  if (incoming == 0 ||
      QVersionNumber::fromString(relay_version) >= kRelayKnowsNoWork ||
      !serving.contains(incoming)) {
    return {};
  }
  return QStringLiteral(
      "this Chrome is already being served, and a relay older than 1.10.0 "
      "serves only one connection per Chrome; update Chrome Control MCP to "
      "serve several Chrome profiles");
}

QString bridgeVersionOrEmpty(const QJsonValue &value) {
  // Three short numbers and nothing else: what every release has been called,
  // and nothing a peer could smuggle text into an agent's reply through.
  // Anchored as a whole: `$` alone would also accept a trailing newline.
  static const QRegularExpression kVersion(QRegularExpression::anchoredPattern(
      QStringLiteral("[0-9]{1,5}\\.[0-9]{1,5}\\.[0-9]{1,5}")));
  const QString text = value.toString();
  return kVersion.match(text).hasMatch() ? text : QString();
}

BridgePeerVersions peerVersionsFromHello(const QJsonObject &hello) {
  return {.extension = bridgeVersionOrEmpty(
              hello.value(QStringLiteral("extension_version"))),
          .installed = bridgeVersionOrEmpty(
              hello.value(QStringLiteral("relay_version")))};
}

} // namespace chrome_control_mcp
