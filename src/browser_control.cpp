// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_control.h"

#include "chrome_control_mcp/browser_contract.h"
#include "chrome_control_mcp/browser_extension_installer.h"
#include "chrome_control_mcp/browser_uploads.h"

#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonValue>
#include <QSet>
#include <QStringList>
#include <QVersionNumber>

#include <iterator>
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

// What an extension answers a command its own table does not have -- a command
// newer than it is, from a newer server.
constexpr QLatin1StringView kUnknownCommandMarker{"Unknown command: "};

QString serverVersionText() {
  return QString::fromLatin1(kBrowserExtensionVersion);
}

// "1.8.2", or a description for an extension older than 1.9.0, which does not
// say.
QString extensionVersionText(const BridgePeerVersions &peer) {
  return peer.extension.isEmpty() ? QStringLiteral("older than 1.9.0")
                                  : peer.extension;
}

// Whether the running extension is behind this server: older, or too old to
// say.
bool extensionBehind(const BridgePeerVersions &peer) {
  return peer.extension.isEmpty() ||
         QVersionNumber::fromString(peer.extension) <
             QVersionNumber::fromString(serverVersionText());
}

} // namespace

QString bridgeVersionNotice(const QString &server,
                            const BridgePeerVersions &peer) {
  const QVersionNumber running = QVersionNumber::fromString(server);
  const QVersionNumber extension = QVersionNumber::fromString(peer.extension);
  const QVersionNumber installed = QVersionNumber::fromString(peer.installed);
  // A relay that says nothing is older than 1.9.0, and it is the program
  // Chrome starts from the installed copy: what is installed is older than
  // this server, and its relay did not pass the extension's version on either.
  if (peer.installed.isEmpty()) {
    return QStringLiteral(
               "Note: Chrome starts a copy of Chrome Control MCP older than "
               "1.9.0 for this browser, behind this %1 server, so the "
               "extension may be older too. Install this version where Chrome "
               "starts it (run this server's executable with --install, or "
               "browser_update_apply), then reload the extension at "
               "chrome://extensions.")
        .arg(server);
  }
  QStringList said;
  const bool server_behind = installed > running;
  if (server_behind) {
    said << QStringLiteral(
                "Note: Chrome Control MCP %1 is installed, but this server is "
                "still %2. Restart the server in your MCP client (in Claude "
                "Code: /mcp, then reconnect) so it runs %1.")
                .arg(peer.installed, server);
  }
  if (peer.extension.isEmpty()) {
    said << QStringLiteral(
                "Note: Chrome is running a Chrome Control MCP extension older "
                "than 1.9.0, beside this %1 server. Reload it at "
                "chrome://extensions (or restart Chrome). Until then "
                "browser_clipboard is unavailable, and copy and paste keys use "
                "the system clipboard, which the user and every agent share.")
                .arg(server);
  } else if (extension < running && installed < running) {
    said << QStringLiteral(
                "Note: this server (%1) is newer than the installed copy (%2) "
                "Chrome loads the extension from, and Chrome is running "
                "extension %3. Install this version (run this server's "
                "executable with --install), then reload the extension at "
                "chrome://extensions.")
                .arg(server, peer.installed, peer.extension);
  } else if (extension < running) {
    said << QStringLiteral(
                "Note: Chrome is running Chrome Control MCP extension %1, "
                "older than this server (%2), so what %2 changed in the "
                "extension is missing. It reloads itself once no agent has "
                "used it for a few seconds; to pick %2 up now, reload it at "
                "chrome://extensions (or restart Chrome).")
                .arg(peer.extension, server);
  } else if (extension > running && !server_behind) {
    said << QStringLiteral(
                "Note: Chrome is running Chrome Control MCP extension %1, "
                "newer than this server (%2). Restart the server in your MCP "
                "client, or update it with browser_update_apply, so the two "
                "match.")
                .arg(peer.extension, server);
  }
  return said.join(QLatin1Char(' '));
}

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

// Reconcile with the pipe server's connections -- one per Chrome profile whose
// extension reached this server. A new connection is a new profile (or the same
// one back after a reload): nothing is known of its tabs yet. A connection that
// has gone takes the refs and routing of its own tabs with it, and of any tab
// no remaining connection is known to hold -- which, with one profile, is
// every tab, exactly as a reconnect always cleared them. Called on the MCP
// thread immediately before each tool call, so the session never acts on a
// connection it has not accounted for.
void BrowserControl::syncConnections() {
  const QList<BridgeConnectionInfo> live = pipe_.connections();
  if (!live.isEmpty()) {
    last_connected_at_ = Clock::now();
  }
  QSet<quint64> present;
  bool changed = false;
  for (const BridgeConnectionInfo &info : live) {
    present.insert(info.id);
    if (!known_.contains(info.id)) {
      known_.emplace(info.id, Known{.info = info,
                                    .name = info.profile.name,
                                    .email = info.profile.email,
                                    .notice_due = true});
      changed = true;
    }
  }
  bool lost = false;
  for (auto it = known_.begin(); it != known_.end();) {
    if (present.contains(it->first)) {
      ++it;
      continue;
    }
    if (current_connection_ == it->first) {
      current_connection_ = 0;
    }
    it = known_.erase(it);
    lost = true;
    changed = true;
  }
  if (lost) {
    QSet<qint64> forget;
    for (const qint64 tab : session_.trackedTabs()) {
      if (!present.contains(tab_owner_.value(tab, 0))) {
        forget.insert(tab);
      }
    }
    session_.forgetTabs(forget);
    for (auto it = tab_owner_.begin(); it != tab_owner_.end();) {
      it = present.contains(it.value()) ? std::next(it) : tab_owner_.erase(it);
    }
    for (auto it = window_owner_.begin(); it != window_owner_.end();) {
      it = present.contains(it.value()) ? std::next(it)
                                        : window_owner_.erase(it);
    }
  }
  if (changed || session_.connected() != !live.isEmpty()) {
    session_.onConnectionsChanged(!live.isEmpty());
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
  last_route_ = 0;
  ToolResult result = dispatch(name, arguments);
  if (result.is_error && result.text.contains(kProtocolMismatchMarker)) {
    result.text += protocolMismatchGuidance();
  }
  // The extension's own words say only that it does not know the command;
  // that this server is newer than it, and what to do, is known only here.
  const auto route = known_.find(last_route_);
  if (result.is_error && result.text.startsWith(kUnknownCommandMarker) &&
      route != known_.end() && extensionBehind(route->second.info.versions)) {
    result.text +=
        QStringLiteral(". Chrome is running Chrome Control MCP extension %1, "
                       "older than this server (%2), which added it: reload "
                       "the extension at chrome://extensions (or restart "
                       "Chrome).")
            .arg(extensionVersionText(route->second.info.versions),
                 serverVersionText());
  }
  return result;
}

QString BrowserControl::takeVersionNotice() {
  QStringList told;
  for (auto &[id, known] : known_) {
    if (!known.notice_due) {
      continue;
    }
    known.notice_due = false;
    const QString notice =
        bridgeVersionNotice(serverVersionText(), known.info.versions);
    if (notice.isEmpty()) {
      continue;
    }
    told << (known_.size() > 1 ? QStringLiteral("In Chrome profile %1: %2")
                                     .arg(profileName(id), notice)
                               : notice);
  }
  return told.join(QLatin1Char(' '));
}

QJsonObject BrowserControl::connectionVersions() const {
  const bool connected = pipe_.clientConnected();
  const BridgePeerVersions peer = pipe_.peerVersions();
  const auto versionOrNull = [](const QString &version) {
    return version.isEmpty() ? QJsonValue(QJsonValue::Null)
                             : QJsonValue(version);
  };
  QJsonArray profiles;
  for (const BridgeConnectionInfo &info : pipe_.connections()) {
    const auto known = known_.find(info.id);
    const QString name =
        known != known_.end() && !known->second.name.isEmpty()
            ? known->second.name
            : (info.profile.name.isEmpty() ? QStringLiteral("unnamed")
                                           : info.profile.name);
    const QString email =
        known != known_.end() ? known->second.email : info.profile.email;
    profiles.append(
        QJsonObject{{QStringLiteral("name"), name},
                    {QStringLiteral("email"), versionOrNull(email)},
                    {QStringLiteral("extension_version"),
                     versionOrNull(info.versions.extension)},
                    {QStringLiteral("installed_version"),
                     versionOrNull(info.versions.installed)},
                    {QStringLiteral("notice"),
                     bridgeVersionNotice(serverVersionText(), info.versions)}});
  }
  return QJsonObject{
      {QStringLiteral("connected"), connected},
      // How many times a browser has attached to this server: a count that
      // keeps climbing is a bridge that keeps dropping, and one that moved is
      // a new connection -- after an extension reload, say.
      {QStringLiteral("connections"),
       static_cast<double>(pipe_.connectionGeneration())},
      {QStringLiteral("server_version"), serverVersionText()},
      {QStringLiteral("extension_version"), versionOrNull(peer.extension)},
      {QStringLiteral("installed_version"), versionOrNull(peer.installed)},
      {QStringLiteral("notice"),
       connected ? bridgeVersionNotice(serverVersionText(), peer) : QString()},
      {QStringLiteral("profiles"), profiles}};
}

QString BrowserControl::profileName(quint64 id) const {
  const auto known = known_.find(id);
  if (known == known_.end() || known->second.name.isEmpty()) {
    return QStringLiteral("unnamed");
  }
  return known->second.name;
}

QJsonObject BrowserControl::askProfile(quint64 id) {
  QJsonObject payload;
  const ToolResult asked = exchange(
      id, session_.beginInternalCommand(QStringLiteral("profileState"), {}),
      &payload);
  if (asked.is_error) {
    return {}; // an extension older than profiles: it cannot say
  }
  return payload;
}

quint64 BrowserControl::connectionForProfile(const QString &profile,
                                             QString *error) {
  const QString wanted = profile.trimmed();
  QStringList names;
  for (auto &[id, known] : known_) {
    (void)askProfile(id); // refreshes the name: it may have been renamed
    names << profileName(id);
    if (known.name.compare(wanted, Qt::CaseInsensitive) == 0 ||
        (!known.email.isEmpty() &&
         known.email.compare(wanted, Qt::CaseInsensitive) == 0)) {
      return id;
    }
  }
  *error = QStringLiteral("No Chrome profile named \"%1\" is connected to "
                          "this server; connected: %2.")
               .arg(wanted, names.isEmpty() ? QStringLiteral("none")
                                            : names.join(QStringLiteral(", ")));
  return 0;
}

quint64 BrowserControl::lastFocusedConnection() {
  if (known_.empty()) {
    return 0;
  }
  if (known_.size() == 1) {
    return known_.begin()->first;
  }
  quint64 best = 0;
  double best_at = -1;
  for (const auto &[id, known] : known_) {
    const QJsonObject state = askProfile(id);
    if (state.value(QStringLiteral("focused")).toBool()) {
      return id; // the user is in this profile's window right now
    }
    const double at = state.value(QStringLiteral("focused_at")).toDouble();
    // Ties -- nothing ever focused -- go to the oldest connection, which is
    // the first one met.
    if (at > best_at) {
      best = id;
      best_at = at;
    }
  }
  return best;
}

quint64 BrowserControl::currentConnection() {
  if (current_connection_ != 0 && known_.contains(current_connection_)) {
    return current_connection_;
  }
  return lastFocusedConnection();
}

quint64 BrowserControl::ownerOfTab(qint64 tab_id) {
  const auto known = tab_owner_.find(tab_id);
  if (known != tab_owner_.end() && known_.contains(known.value())) {
    return known.value();
  }
  for (const auto &[id, connection] : known_) {
    QJsonObject payload;
    const ToolResult asked =
        exchange(id,
                 session_.beginInternalCommand(
                     QStringLiteral("findTab"),
                     QJsonObject{{QStringLiteral("tab_id"), tab_id}}),
                 &payload);
    if (!asked.is_error && payload.value(QStringLiteral("exists")).toBool()) {
      tab_owner_.insert(tab_id, id);
      return id;
    }
  }
  return 0;
}

quint64 BrowserControl::ownerOfWindow(qint64 window_id) {
  const auto known = window_owner_.find(window_id);
  if (known != window_owner_.end() && known_.contains(known.value())) {
    return known.value();
  }
  for (const auto &[id, connection] : known_) {
    (void)exchange(
        id, session_.beginCommand(QStringLiteral("browser_windows"), {}));
    const auto found = window_owner_.find(window_id);
    if (found != window_owner_.end()) {
      return found.value();
    }
  }
  return 0;
}

bool BrowserControl::fansOut(const QString &name,
                             const QJsonObject &arguments) const {
  if (known_.size() < 2) {
    return false; // one profile: the call goes to it, exactly as before
  }
  return name == QLatin1String("browser_tabs") ||
         name == QLatin1String("browser_windows") ||
         (name == QLatin1String("browser_release") &&
          !arguments.contains(QStringLiteral("tab_id")));
}

quint64 BrowserControl::routeOne(const QString &name,
                                 const QJsonObject &arguments, QString *error) {
  if (known_.empty()) {
    return 0; // nothing connected: the session refuses as it always has
  }
  const QString profile = arguments.value(QStringLiteral("profile")).toString();
  const bool takes_profile = name == QLatin1String("browser_new_tab") ||
                             name == QLatin1String("browser_window") ||
                             name == QLatin1String("browser_cookies") ||
                             name == QLatin1String("browser_permission");
  if (takes_profile && !profile.trimmed().isEmpty()) {
    return connectionForProfile(profile, error);
  }
  if (known_.size() == 1) {
    return known_.begin()->first;
  }
  // A tab named outright, or through a ref bound to it.
  qint64 tab_id = 0;
  if (arguments.value(QStringLiteral("tab_id")).isDouble()) {
    tab_id = arguments.value(QStringLiteral("tab_id")).toInteger();
  } else {
    for (const QString &key :
         {QStringLiteral("ref"), QStringLiteral("to_ref")}) {
      const QString ref = arguments.value(key).toString();
      if (!ref.isEmpty()) {
        tab_id = session_.refIndex()
                     .value(ref)
                     .toObject()
                     .value(QStringLiteral("tabId"))
                     .toInteger();
        break;
      }
    }
  }
  if (tab_id > 0) {
    const quint64 owner = ownerOfTab(tab_id);
    // Not found anywhere: the agent's current profile answers, as the one
    // browser always did, that it has no such tab.
    return owner != 0 ? owner : currentConnection();
  }
  if (name == QLatin1String("browser_window") &&
      arguments.value(QStringLiteral("window_id")).isDouble()) {
    const quint64 owner =
        ownerOfWindow(arguments.value(QStringLiteral("window_id")).toInteger());
    return owner != 0 ? owner : currentConnection();
  }
  if (name == QLatin1String("browser_new_tab") ||
      (name == QLatin1String("browser_window") &&
       arguments.value(QStringLiteral("action"))
               .toString()
               .compare(QStringLiteral("new"), Qt::CaseInsensitive) == 0)) {
    return lastFocusedConnection();
  }
  return currentConnection();
}

void BrowserControl::learnFromReply(quint64 id, const QJsonObject &reply) {
  if (reply.value(QStringLiteral("tabId")).isDouble()) {
    tab_owner_.insert(reply.value(QStringLiteral("tabId")).toInteger(), id);
  }
  const QJsonObject payload = reply.value(QStringLiteral("payload")).toObject();
  if (payload.value(QStringLiteral("tab_id")).isDouble()) {
    tab_owner_.insert(payload.value(QStringLiteral("tab_id")).toInteger(), id);
  }
  if (payload.value(QStringLiteral("window_id")).isDouble()) {
    window_owner_.insert(payload.value(QStringLiteral("window_id")).toInteger(),
                         id);
  }
  for (const QString &list :
       {QStringLiteral("tabs"), QStringLiteral("your_tabs")}) {
    for (const auto &entry : payload.value(list).toArray()) {
      const QJsonObject tab = entry.toObject();
      const QJsonValue tab_id = tab.contains(QStringLiteral("tab_id"))
                                    ? tab.value(QStringLiteral("tab_id"))
                                    : tab.value(QStringLiteral("id"));
      if (tab_id.isDouble()) {
        tab_owner_.insert(tab_id.toInteger(), id);
      }
      if (tab.value(QStringLiteral("window_id")).isDouble()) {
        window_owner_.insert(tab.value(QStringLiteral("window_id")).toInteger(),
                             id);
      }
    }
  }
  for (const auto &entry : payload.value(QStringLiteral("windows")).toArray()) {
    const QJsonValue window_id =
        entry.toObject().value(QStringLiteral("window_id"));
    if (window_id.isDouble()) {
      window_owner_.insert(window_id.toInteger(), id);
    }
  }
  // The profile's name as the extension says it now: renamed on the options
  // page since it attached, or first known now.
  const auto known = known_.find(id);
  if (known == known_.end()) {
    return;
  }
  const QJsonValue name = payload.contains(QStringLiteral("profile_name"))
                              ? payload.value(QStringLiteral("profile_name"))
                              : payload.value(QStringLiteral("profile"));
  const BridgePeerProfile said =
      peerProfileFromJson(name, payload.value(QStringLiteral("profile_email")));
  if (!said.name.isEmpty()) {
    known->second.name = said.name;
  }
  if (!said.email.isEmpty()) {
    known->second.email = said.email;
  }
}

ToolResult BrowserControl::fanOut(const QString &name,
                                  const QJsonObject &arguments) {
  QJsonArray tabs;
  QJsonArray your_tabs;
  QJsonArray windows;
  QJsonArray closed;
  QJsonArray handed_back;
  QJsonArray kept_open;
  QJsonArray not_closed;
  QJsonArray profiles;
  QJsonArray failed;
  qint64 count = 0;
  qint64 still_held = 0;
  bool capped = false;
  const auto withProfile = [](const QJsonValue &entry, const QString &profile) {
    QJsonObject object = entry.toObject();
    object.insert(QStringLiteral("profile"), profile);
    return object;
  };
  const auto append = [](QJsonArray &into, const QJsonArray &from,
                         const auto &transform) {
    for (const auto &entry : from) {
      into.append(transform(entry));
    }
  };
  for (const auto &[id, known] : known_) {
    QJsonObject payload;
    const ToolResult one =
        exchange(id, session_.beginCommand(name, arguments), &payload);
    const QString profile = profileName(id);
    if (one.is_error) {
      failed.append(QJsonObject{{QStringLiteral("profile"), profile},
                                {QStringLiteral("error"), one.text}});
      continue;
    }
    profiles.append(profile);
    const auto tag = [&](const QJsonValue &entry) {
      return withProfile(entry, profile);
    };
    const auto keep = [](const QJsonValue &entry) { return entry; };
    append(tabs, payload.value(QStringLiteral("tabs")).toArray(), tag);
    append(your_tabs, payload.value(QStringLiteral("your_tabs")).toArray(),
           tag);
    append(windows, payload.value(QStringLiteral("windows")).toArray(), tag);
    append(closed, payload.value(QStringLiteral("closed")).toArray(), keep);
    append(handed_back, payload.value(QStringLiteral("handed_back")).toArray(),
           keep);
    append(kept_open, payload.value(QStringLiteral("kept_open")).toArray(),
           keep);
    append(not_closed, payload.value(QStringLiteral("not_closed")).toArray(),
           keep);
    count += payload.value(QStringLiteral("count")).toInteger();
    still_held += payload.value(QStringLiteral("tabs_still_held")).toInteger();
    capped = capped || payload.value(QStringLiteral("capped")).toBool();
  }
  if (profiles.isEmpty() && !failed.isEmpty()) {
    return {
        .text =
            failed.first().toObject().value(QStringLiteral("error")).toString(),
        .is_error = true,
        .image_base64 = {},
        .image_mime = {}};
  }
  QJsonObject merged{{QStringLiteral("profiles"), profiles}};
  if (name == QLatin1String("browser_tabs")) {
    merged.insert(QStringLiteral("tabs"), tabs);
    merged.insert(QStringLiteral("your_tabs"), your_tabs);
    merged.insert(QStringLiteral("count"), static_cast<double>(count));
    merged.insert(QStringLiteral("capped"), capped);
  } else if (name == QLatin1String("browser_windows")) {
    merged.insert(QStringLiteral("windows"), windows);
  } else {
    merged.insert(QStringLiteral("ok"), failed.isEmpty());
    merged.insert(QStringLiteral("closed"), closed);
    merged.insert(QStringLiteral("handed_back"), handed_back);
    merged.insert(QStringLiteral("kept_open"), kept_open);
    if (!not_closed.isEmpty()) {
      merged.insert(QStringLiteral("not_closed"), not_closed);
    }
    merged.insert(QStringLiteral("tabs_still_held"),
                  static_cast<double>(still_held));
  }
  if (!failed.isEmpty()) {
    merged.insert(QStringLiteral("failed"), failed);
  }
  return {.text = QString::fromUtf8(
              QJsonDocument(merged).toJson(QJsonDocument::Compact)),
          .is_error = false,
          .image_base64 = {},
          .image_mime = {}};
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
  syncConnections();
  if (fansOut(name, arguments)) {
    return fanOut(name, arguments);
  }
  QString route_error;
  const quint64 target = routeOne(name, arguments, &route_error);
  if (!route_error.isEmpty()) {
    return {.text = route_error,
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  last_route_ = target;
  if (target != 0) {
    current_connection_ = target;
  }
  // The calls that are not one command: their files go first, in pieces the
  // bridge can carry, and the command that uses them follows.
  if (name == QLatin1String("browser_upload") ||
      (name == QLatin1String("browser_clipboard") &&
       arguments.contains(QStringLiteral("paths")))) {
    return invokeWithFiles(target, name, arguments);
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
  return exchange(target, outgoing);
}

ToolResult BrowserControl::exchange(
    quint64 id, const browser::BrowserBridgeSession::Outgoing &outgoing,
    QJsonObject *reply_payload) {
  if (!outgoing.ok) {
    return {.text = outgoing.error,
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  const BrowserBridgePipeServer::Exchange exchange =
      id != 0 ? pipe_.sendCommandAwaitReply(id, outgoing.frame)
              : pipe_.sendCommandAwaitReply(outgoing.frame);
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
  if (id != 0) {
    learnFromReply(id, exchange.reply);
  }
  if (reply_payload != nullptr) {
    *reply_payload = exchange.reply.value(QStringLiteral("payload")).toObject();
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

ToolResult BrowserControl::invokeWithFiles(quint64 id, const QString &name,
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
  // and match each piece to the file it belongs to. Every piece goes to the
  // profile the command itself goes to, which holds the files it names.
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
      const ToolResult sent = exchange(id, chunk);
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
  return exchange(id, apply);
}

} // namespace chrome_control_mcp
