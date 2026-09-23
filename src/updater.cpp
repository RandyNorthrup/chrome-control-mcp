// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/updater.h"

#include "chrome_control_mcp/browser_extension_installer.h"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QStandardPaths>
#include <QStringList>
#include <QTimer>
#include <QVersionNumber>

#ifndef CHROME_CONTROL_MCP_VERSION
#define CHROME_CONTROL_MCP_VERSION "0.0.0"
#endif

namespace chrome_control_mcp {
namespace {

constexpr char kDefaultApiBase[] = "https://api.github.com";
constexpr char kDefaultRepository[] = "RandyNorthrup/chrome-control-mcp";
constexpr char kChecksumsAssetName[] = "SHA256SUMS.txt";

// A release archive for this project is a few megabytes. The ceiling is far
// above that and exists so a redirect to something enormous cannot fill the
// user's disk before the checksum ever gets a chance to reject it.
constexpr qint64 kMaxDownloadBytes = qint64{256} * 1024 * 1024;

// Archive extraction shells out to the system tar, which reads both the zip
// this project ships on Windows and the gzipped tar it ships elsewhere. Give it
// a bound: a hostile archive must not be able to hold the server open forever.
constexpr int kExtractTimeoutMs = 180000;

QString platformPackageName() {
#if defined(Q_OS_WIN)
  return QStringLiteral("windows-x64");
#elif defined(Q_OS_MACOS)
#if defined(__aarch64__) || defined(_M_ARM64)
  return QStringLiteral("macos-arm64");
#else
  return QStringLiteral("macos-x64");
#endif
#else
  return QStringLiteral("linux-x64");
#endif
}

QString platformArchiveSuffix() {
#if defined(Q_OS_WIN)
  return QStringLiteral(".zip");
#else
  return QStringLiteral(".tar.gz");
#endif
}

QString userAgent() {
  return QStringLiteral("chrome-control-mcp/%1")
      .arg(QString::fromLatin1(CHROME_CONTROL_MCP_VERSION));
}

QString versionFromTag(const QString &tag) {
  return tag.startsWith(QLatin1Char('v')) ? tag.mid(1) : tag;
}

UpdateApplyResult applyFailure(const QString &error) {
  UpdateApplyResult result;
  result.ok = false;
  result.error = error;
  return result;
}

UpdateCheckResult checkFailure(const UpdaterConfig &config,
                               const QString &error) {
  UpdateCheckResult result;
  result.ok = false;
  result.error = error;
  result.current_version = config.current_version;
  result.install_root = config.layout.root;
  result.managed_install =
      !installRootForExecutable(config.executable_path).isEmpty();
  return result;
}

// One bounded HTTPS GET, run to completion on a local event loop because the
// MCP server itself is synchronous and has no loop of its own.
//
// @param sink when non-null, response bytes are streamed to it rather than
//        collected, so a release archive never has to be held in memory.
bool fetchUrl(const QUrl &url, const UpdaterConfig &config,
              const QByteArray &accept, QIODevice *sink, QByteArray *collected,
              QString *error) {
  if (url.scheme() != QLatin1String("https")) {
    // Plain HTTP would let anyone on the path choose which build gets
    // installed, and the checksum would be chosen by the same party.
    *error = QStringLiteral("Refusing a non-HTTPS release URL: %1")
                 .arg(url.toString());
    return false;
  }

  QNetworkAccessManager manager;
  QNetworkRequest request(url);
  request.setHeader(QNetworkRequest::UserAgentHeader, userAgent());
  request.setRawHeader("Accept", accept);
  // Release assets answer with a redirect to a storage host. Following only
  // no-less-safe redirects keeps every hop on HTTPS.
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                       QNetworkRequest::NoLessSafeRedirectPolicy);

  QNetworkReply *reply = manager.get(request);
  QEventLoop loop;
  QTimer timer;
  timer.setSingleShot(true);
  bool timed_out = false;
  bool too_large = false;
  qint64 received = 0;

  QObject::connect(&timer, &QTimer::timeout, reply, [&timed_out, reply]() {
    timed_out = true;
    reply->abort();
  });
  QObject::connect(reply, &QNetworkReply::readyRead, reply, [&]() {
    const QByteArray chunk = reply->readAll();
    received += chunk.size();
    if (received > kMaxDownloadBytes) {
      too_large = true;
      reply->abort();
      return;
    }
    if (sink != nullptr) {
      sink->write(chunk);
    } else if (collected != nullptr) {
      collected->append(chunk);
    }
    // Progress is proof of life: restart the clock so a large but healthy
    // download is not killed by a deadline meant for a stalled one.
    timer.start(config.timeout_ms);
  });
  QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);

  timer.start(config.timeout_ms);
  loop.exec();
  timer.stop();

  const QNetworkReply::NetworkError network_error = reply->error();
  const int status =
      reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
  const QString network_message = reply->errorString();
  reply->deleteLater();

  if (too_large) {
    *error = QStringLiteral("Release download exceeded %1 bytes and was "
                            "stopped")
                 .arg(kMaxDownloadBytes);
    return false;
  }
  if (timed_out) {
    *error = QStringLiteral("Release request timed out after %1 ms: %2")
                 .arg(config.timeout_ms)
                 .arg(url.toString());
    return false;
  }
  if (network_error != QNetworkReply::NoError) {
    *error = QStringLiteral("Release request failed (%1): %2")
                 .arg(network_message, url.toString());
    return false;
  }
  if (status != 0 && (status < 200 || status >= 300)) {
    *error = QStringLiteral("Release host answered HTTP %1 for %2")
                 .arg(status)
                 .arg(url.toString());
    return false;
  }
  return true;
}

bool fetchBytes(const QUrl &url, const UpdaterConfig &config,
                const QByteArray &accept, QByteArray *out, QString *error) {
  return fetchUrl(url, config, accept, nullptr, out, error);
}

bool fetchToFile(const QUrl &url, const UpdaterConfig &config,
                 const QString &path, QString *error) {
  QFile file(path);
  if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
    *error = QStringLiteral("Could not write the download to %1")
                 .arg(QDir::toNativeSeparators(path));
    return false;
  }
  const bool ok =
      fetchUrl(url, config, QByteArrayLiteral("application/octet-stream"),
               &file, nullptr, error);
  file.close();
  if (!ok) {
    file.remove();
  }
  return ok;
}

QString fileSha256(const QString &path, QString *error) {
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly)) {
    *error = QStringLiteral("Could not read the download at %1")
                 .arg(QDir::toNativeSeparators(path));
    return {};
  }
  QCryptographicHash hash(QCryptographicHash::Sha256);
  if (!hash.addData(&file)) {
    *error = QStringLiteral("Could not hash the download at %1")
                 .arg(QDir::toNativeSeparators(path));
    return {};
  }
  return QString::fromLatin1(hash.result().toHex());
}

// The tar to unpack with. Windows has shipped bsdtar at a known path since
// Windows 10 1803, and naming it beats searching PATH: a developer machine can
// easily have a POSIX tar from another toolchain first on PATH, and those read
// a Windows absolute path as a remote host specification.
QString tarProgram() {
#ifdef Q_OS_WIN
  const QString system_tar = QDir::cleanPath(
      QDir(qEnvironmentVariable("SystemRoot", QStringLiteral("C:/Windows")))
          .filePath(QStringLiteral("System32/tar.exe")));
  if (QFileInfo(system_tar).isExecutable()) {
    return system_tar;
  }
#endif
  return QStandardPaths::findExecutable(QStringLiteral("tar"));
}

// Unpack @p archive_name into @p destination_name, both named relative to
// @p working_directory. Relative names are not a convenience here: an absolute
// Windows path handed to a POSIX-flavoured tar is parsed as `host:path` and the
// unpack fails trying to reach a machine called C.
bool extractArchive(const QString &working_directory,
                    const QString &archive_name,
                    const QString &destination_name, QString *error) {
  const QString tar = tarProgram();
  if (tar.isEmpty()) {
    *error = QStringLiteral(
        "No 'tar' program was found; it is needed to unpack the release "
        "archive. Windows 10 1803 and later ship one, as do Linux and macOS.");
    return false;
  }
  QProcess process;
  process.setProgram(tar);
  process.setWorkingDirectory(working_directory);
  process.setArguments({QStringLiteral("-xf"), archive_name,
                        QStringLiteral("-C"), destination_name});
  process.setProcessChannelMode(QProcess::MergedChannels);
  process.start();
  if (!process.waitForStarted(kExtractTimeoutMs)) {
    *error = QStringLiteral("Could not start '%1' to unpack the release")
                 .arg(QDir::toNativeSeparators(tar));
    return false;
  }
  if (!process.waitForFinished(kExtractTimeoutMs)) {
    process.kill();
    process.waitForFinished(5000);
    *error = QStringLiteral("Unpacking the release did not finish within %1 ms")
                 .arg(kExtractTimeoutMs);
    return false;
  }
  if (process.exitStatus() != QProcess::NormalExit || process.exitCode() != 0) {
    *error = QStringLiteral("Unpacking the release with %1 failed: %2")
                 .arg(QDir::toNativeSeparators(tar),
                      QString::fromLocal8Bit(process.readAll()).trimmed());
    return false;
  }
  return true;
}

// A release archive holds one top-level directory named after the package. Use
// it when it is there, and fall back to the extraction directory itself so an
// archive packed without that wrapper still installs.
QString extractedReleaseRoot(const QString &extraction_directory) {
  const QDir directory(extraction_directory);
  const QStringList children =
      directory.entryList(QDir::Dirs | QDir::NoDotAndDotDot);
  const QStringList files =
      directory.entryList(QDir::Files | QDir::NoDotAndDotDot);
  if (children.size() == 1 && files.isEmpty()) {
    return QDir::cleanPath(directory.filePath(children.first()));
  }
  return QDir::cleanPath(extraction_directory);
}

// Move a directory out of the way and delete it, so a half-written previous
// attempt can be replaced without ever deleting files in place. Returns false
// when the directory is busy, which on Windows means some process still has a
// file inside it open.
bool discardDirectory(const QString &path) {
  const QFileInfo info(path);
  if (!info.exists()) {
    return true;
  }
  QDir parent(info.absolutePath());
  // Dot-prefixed so installedVersions never counts a discard that could not be
  // deleted as an installed version.
  const QString parked = QStringLiteral(".discard-") + info.fileName();
  QDir(parent.filePath(parked)).removeRecursively();
  if (!parent.rename(info.fileName(), parked)) {
    return false;
  }
  QDir(parent.filePath(parked)).removeRecursively();
  return true;
}

// Copy a directory tree file by file. Qt has no recursive copy, and the two
// alternatives are both wrong here: a move would tear the source out from under
// a running process, and shelling out to a platform copy tool would add a
// dependency for something this small.
bool copyDirectory(const QString &source, const QString &destination,
                   QString *error) {
  const QDir source_directory(source);
  if (!QDir().mkpath(destination)) {
    *error = QStringLiteral("Could not create %1")
                 .arg(QDir::toNativeSeparators(destination));
    return false;
  }
  const QFileInfoList entries = source_directory.entryInfoList(
      QDir::Files | QDir::Dirs | QDir::NoDotAndDotDot | QDir::Hidden);
  for (const QFileInfo &entry : entries) {
    const QString target =
        QDir::cleanPath(QDir(destination).filePath(entry.fileName()));
    if (entry.isDir()) {
      if (!copyDirectory(entry.absoluteFilePath(), target, error)) {
        return false;
      }
      continue;
    }
    QFile::remove(target);
    if (!QFile::copy(entry.absoluteFilePath(), target)) {
      *error = QStringLiteral("Could not copy %1 to %2")
                   .arg(QDir::toNativeSeparators(entry.absoluteFilePath()),
                        QDir::toNativeSeparators(target));
      return false;
    }
  }
  return true;
}

QString executableFileName() {
#ifdef Q_OS_WIN
  return QStringLiteral("chrome_control_mcp.exe");
#else
  return QStringLiteral("chrome_control_mcp");
#endif
}

} // namespace

UpdaterConfig UpdaterConfig::withDefaults(UpdaterConfig config) {
  if (config.api_base_url.isEmpty()) {
    config.api_base_url = QString::fromLatin1(kDefaultApiBase);
  }
  if (config.repository.isEmpty()) {
    config.repository = QString::fromLatin1(kDefaultRepository);
  }
  if (config.current_version.isEmpty()) {
    config.current_version = QString::fromLatin1(CHROME_CONTROL_MCP_VERSION);
  }
  if (config.executable_path.isEmpty()) {
    config.executable_path =
        QDir::cleanPath(QCoreApplication::applicationFilePath());
  }
  if (config.layout.isEmpty()) {
    config.layout = InstallLayout::resolved(config.executable_path);
  }
  if (config.timeout_ms <= 0) {
    config.timeout_ms = 60000;
  }
  return config;
}

QString releaseAssetName(const QString &version) {
  if (version.isEmpty()) {
    return {};
  }
  return QStringLiteral("chrome-control-mcp-v%1-%2%3")
      .arg(version, platformPackageName(), platformArchiveSuffix());
}

QString checksumForAsset(const QString &sums_text, const QString &asset_name) {
  if (asset_name.isEmpty()) {
    return {};
  }
  const QStringList lines = sums_text.split(QLatin1Char('\n'));
  for (const QString &raw_line : lines) {
    const QString line = raw_line.trimmed();
    if (line.isEmpty()) {
      continue;
    }
    const qsizetype separator = line.indexOf(QLatin1Char(' '));
    if (separator <= 0) {
      continue;
    }
    QString name = line.mid(separator).trimmed();
    // sha256sum writes "hash  name" for text mode and "hash *name" for binary.
    if (name.startsWith(QLatin1Char('*'))) {
      name = name.mid(1);
    }
    if (name != asset_name) {
      continue;
    }
    const QString hash = line.left(separator).trimmed().toLower();
    static constexpr qsizetype kSha256HexLength = 64;
    if (hash.size() != kSha256HexLength) {
      return {};
    }
    for (const QChar character : hash) {
      if (!character.isDigit() &&
          (character < QLatin1Char('a') || character > QLatin1Char('f'))) {
        return {};
      }
    }
    return hash;
  }
  return {};
}

bool isNewerVersion(const QString &candidate, const QString &current) {
  const QVersionNumber candidate_version =
      QVersionNumber::fromString(candidate);
  const QVersionNumber current_version = QVersionNumber::fromString(current);
  if (candidate_version.isNull() || current_version.isNull()) {
    return false;
  }
  return current_version < candidate_version;
}

UpdateCheckResult checkForUpdate(const UpdaterConfig &raw_config) {
  const UpdaterConfig config = UpdaterConfig::withDefaults(raw_config);
  const QUrl url(QStringLiteral("%1/repos/%2/releases/latest")
                     .arg(config.api_base_url, config.repository));
  QByteArray body;
  QString error;
  if (!fetchBytes(url, config, QByteArrayLiteral("application/vnd.github+json"),
                  &body, &error)) {
    return checkFailure(config, error);
  }

  QJsonParseError parse_error{};
  const QJsonDocument document = QJsonDocument::fromJson(body, &parse_error);
  if (parse_error.error != QJsonParseError::NoError || !document.isObject()) {
    return checkFailure(
        config, QStringLiteral("Release metadata was not valid JSON: %1")
                    .arg(parse_error.errorString()));
  }
  const QJsonObject release = document.object();
  const QString tag = release.value(QStringLiteral("tag_name")).toString();
  const QString version = versionFromTag(tag);
  if (!isSafeVersionName(version)) {
    return checkFailure(
        config,
        QStringLiteral("Release tag %1 is not a usable version").arg(tag));
  }

  UpdateCheckResult result;
  result.ok = true;
  result.current_version = config.current_version;
  result.latest_version = version;
  result.update_available = isNewerVersion(version, config.current_version);
  result.notes_url = release.value(QStringLiteral("html_url")).toString();
  result.install_root = config.layout.root;
  result.managed_install =
      !installRootForExecutable(config.executable_path).isEmpty();
  return result;
}

UpdateApplyResult installStagedRelease(const UpdaterConfig &raw_config,
                                       const QString &version,
                                       const QString &staged_directory) {
  const UpdaterConfig config = UpdaterConfig::withDefaults(raw_config);
  if (!isSafeVersionName(version)) {
    return applyFailure(
        QStringLiteral("Refusing to install an unsafe version name: %1")
            .arg(version));
  }
  if (!QFileInfo(staged_directory).isDir()) {
    return applyFailure(QStringLiteral("Nothing staged at %1")
                            .arg(QDir::toNativeSeparators(staged_directory)));
  }
  const InstallLayout &layout = config.layout;
  if (!QDir().mkpath(layout.versions)) {
    return applyFailure(QStringLiteral("Could not create %1")
                            .arg(QDir::toNativeSeparators(layout.versions)));
  }

  const QString previous_version = currentVersion(layout);
  const QString target = layout.versionDirectory(version);
  if (!discardDirectory(target)) {
    return applyFailure(
        QStringLiteral("Version %1 is already installed and is in use, so it "
                       "cannot be replaced. Close the running server and try "
                       "again.")
            .arg(version));
  }
  if (!QDir().rename(staged_directory, target)) {
    return applyFailure(
        QStringLiteral("Could not move the staged release into %1. The staging "
                       "directory and the install must be on the same volume.")
            .arg(QDir::toNativeSeparators(target)));
  }

  QString link_error;
  if (!pointCurrentAtVersion(layout, version, &link_error)) {
    return applyFailure(link_error);
  }

  UpdateApplyResult result;
  result.ok = true;
  result.previous_version = previous_version;
  result.installed_version = version;
  result.executable_path =
      QDir::cleanPath(QDir(layout.current).filePath(executableFileName()));
  result.extension_path = QDir::cleanPath(
      QDir(layout.current)
          .filePath(QString::fromLatin1(kBrowserExtensionDirectoryName)));
  // The running process keeps the files it already opened. The new version is
  // what the client will launch next time, not what is answering right now.
  result.restart_required = version != config.current_version;
  result.pruned_versions =
      pruneInstalledVersions(layout, version, config.keep_recent_versions);
  return result;
}

UpdateApplyResult adoptRunningInstall(const UpdaterConfig &raw_config) {
  const UpdaterConfig config = UpdaterConfig::withDefaults(raw_config);
  const QString version = config.current_version;
  if (!isSafeVersionName(version)) {
    return applyFailure(
        QStringLiteral("This build reports version %1, which cannot name a "
                       "directory, so it cannot be installed.")
            .arg(version));
  }
  const QString source =
      QDir::cleanPath(QFileInfo(config.executable_path).absolutePath());
  if (!QFileInfo(QDir(source).filePath(executableFileName())).isFile()) {
    return applyFailure(
        QStringLiteral("%1 does not hold %2")
            .arg(QDir::toNativeSeparators(source), executableFileName()));
  }
  const InstallLayout &layout = config.layout;
  if (source.startsWith(layout.root, Qt::CaseInsensitive)) {
    return applyFailure(
        QStringLiteral("This copy already lives under the install root at %1")
            .arg(QDir::toNativeSeparators(layout.root)));
  }
  if (!QDir().mkpath(layout.versions)) {
    return applyFailure(QStringLiteral("Could not create %1")
                            .arg(QDir::toNativeSeparators(layout.versions)));
  }

  // Build the copy under a reserved name and hand the finished tree to the same
  // install step a downloaded release uses, so a copy interrupted halfway never
  // becomes a version the link can point at.
  const QString staging = QDir::cleanPath(
      QDir(layout.versions)
          .filePath(QStringLiteral(".adopting-%1").arg(version)));
  QDir(staging).removeRecursively();
  QString error;
  if (!copyDirectory(source, staging, &error)) {
    QDir(staging).removeRecursively();
    return applyFailure(error);
  }

  UpdateApplyResult result = installStagedRelease(config, version, staging);
  QDir(staging).removeRecursively();
  if (result.ok) {
    result.adopted = true;
    result.adopted_from = source;
    // The client is still launching the old path, so it has to be repointed
    // once even though the version did not change.
    result.restart_required = true;
  }
  return result;
}

UpdateApplyResult applyUpdate(const UpdaterConfig &raw_config) {
  const UpdaterConfig config = UpdaterConfig::withDefaults(raw_config);
  const UpdateCheckResult check = checkForUpdate(config);
  if (!check.ok) {
    return applyFailure(check.error);
  }
  if (!check.update_available) {
    UpdateApplyResult result;
    result.ok = true;
    result.previous_version = currentVersion(config.layout);
    result.installed_version = config.current_version;
    result.executable_path = stableExecutablePath(config.executable_path);
    result.restart_required = false;
    return result;
  }

  const QString version = check.latest_version;
  const QString asset_name = releaseAssetName(version);
  const QString download_base =
      QStringLiteral("https://github.com/%1/releases/download/v%2")
          .arg(config.repository, version);
  const QUrl asset_url(QStringLiteral("%1/%2").arg(download_base, asset_name));
  const QUrl checksums_url(QStringLiteral("%1/%2").arg(
      download_base, QString::fromLatin1(kChecksumsAssetName)));

  // Stage inside the install's own versions directory so the finished release
  // is moved, not copied, onto the volume it will live on.
  const InstallLayout &layout = config.layout;
  if (!QDir().mkpath(layout.versions)) {
    return applyFailure(QStringLiteral("Could not create %1")
                            .arg(QDir::toNativeSeparators(layout.versions)));
  }
  const QString staging = QDir::cleanPath(
      QDir(layout.versions)
          .filePath(QStringLiteral(".staging-%1").arg(version)));
  QDir(staging).removeRecursively();
  if (!QDir().mkpath(staging)) {
    return applyFailure(QStringLiteral("Could not create the staging directory "
                                       "at %1")
                            .arg(QDir::toNativeSeparators(staging)));
  }

  QString error;
  QByteArray sums;
  if (!fetchBytes(checksums_url, config, QByteArrayLiteral("text/plain"), &sums,
                  &error)) {
    QDir(staging).removeRecursively();
    return applyFailure(error);
  }
  const QString expected =
      checksumForAsset(QString::fromUtf8(sums), asset_name);
  if (expected.isEmpty()) {
    QDir(staging).removeRecursively();
    return applyFailure(
        QStringLiteral("Release %1 publishes no SHA-256 for %2, so the "
                       "download cannot be verified and was not installed.")
            .arg(version, asset_name));
  }

  const QString archive = QDir::cleanPath(QDir(staging).filePath(asset_name));
  if (!fetchToFile(asset_url, config, archive, &error)) {
    QDir(staging).removeRecursively();
    return applyFailure(error);
  }
  const QString actual = fileSha256(archive, &error);
  if (actual.isEmpty()) {
    QDir(staging).removeRecursively();
    return applyFailure(error);
  }
  if (actual != expected) {
    QDir(staging).removeRecursively();
    return applyFailure(
        QStringLiteral("The downloaded %1 does not match the SHA-256 published "
                       "with release v%2 and was discarded.")
            .arg(asset_name, version));
  }

  const QString extraction =
      QDir::cleanPath(QDir(staging).filePath(QStringLiteral("unpacked")));
  if (!QDir().mkpath(extraction)) {
    QDir(staging).removeRecursively();
    return applyFailure(QStringLiteral("Could not create %1")
                            .arg(QDir::toNativeSeparators(extraction)));
  }
  if (!extractArchive(staging, asset_name, QStringLiteral("unpacked"),
                      &error)) {
    QDir(staging).removeRecursively();
    return applyFailure(error);
  }

  const QString release_root = extractedReleaseRoot(extraction);
  if (!QFileInfo(QDir(release_root).filePath(executableFileName())).isFile()) {
    QDir(staging).removeRecursively();
    return applyFailure(
        QStringLiteral("The release archive did not contain %1, so nothing was "
                       "installed.")
            .arg(executableFileName()));
  }

  UpdateApplyResult result =
      installStagedRelease(config, version, release_root);
  QDir(staging).removeRecursively();
  if (result.ok) {
    result.restart_required = true;
  }
  return result;
}

} // namespace chrome_control_mcp
