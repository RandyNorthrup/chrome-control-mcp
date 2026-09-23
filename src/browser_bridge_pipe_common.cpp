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
#include <QStringList>

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

bool ancestorChainContainsImage(quint64 pid,
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
      return true;
    }
    current = it.value();
  }
  return false;
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
  return connected_;
}

quint64 BrowserBridgePipeServer::connectionGeneration() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return generation_;
}

} // namespace chrome_control_mcp
