// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_uploads.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QMimeDatabase>
#include <QMimeType>

#include <algorithm>

namespace chrome_control_mcp::browser {
namespace {

// The separator an operator writes between roots: what the platform already
// uses for lists of paths, so the variable reads like PATH does.
constexpr QChar rootsSeparator() {
#ifdef Q_OS_WIN
  return QLatin1Char(';');
#else
  return QLatin1Char(':');
#endif
}

// A directory prefix test that cannot be fooled by a name that merely starts
// with the root's characters: "C:/work-secrets" is not inside "C:/work".
bool insideRoot(const QString &canonical_path, const QString &root) {
  const QString canonical_root = QFileInfo(root).canonicalFilePath();
  if (canonical_root.isEmpty()) {
    return false; // a root that does not exist admits nothing
  }
  const Qt::CaseSensitivity sensitivity =
#ifdef Q_OS_WIN
      Qt::CaseInsensitive;
#else
      Qt::CaseSensitive;
#endif
  if (canonical_path.compare(canonical_root, sensitivity) == 0) {
    return true;
  }
  QString prefix = canonical_root;
  if (!prefix.endsWith(QLatin1Char('/'))) {
    prefix.append(QLatin1Char('/'));
  }
  return canonical_path.startsWith(prefix, sensitivity);
}

} // namespace

bool uploadPathAllowed(const QString &canonical_path, const QString &roots) {
  const QString trimmed = roots.trimmed();
  if (trimmed.isEmpty()) {
    return true; // no restriction configured
  }
  const QStringList entries =
      trimmed.split(rootsSeparator(), Qt::SkipEmptyParts);
  return std::ranges::any_of(entries, [&canonical_path](const QString &entry) {
    const QString root = entry.trimmed();
    return !root.isEmpty() && insideRoot(canonical_path, root);
  });
}

QString uploadMimeForName(const QString &name) {
  static const QMimeDatabase database;
  const QMimeType type =
      database.mimeTypeForFile(name, QMimeDatabase::MatchExtension);
  if (!type.isValid() || type.isDefault()) {
    return QString();
  }
  return type.name();
}

UploadBatch readUploadFiles(const QStringList &paths, const QString &roots) {
  UploadBatch batch;
  if (paths.isEmpty()) {
    batch.error = QStringLiteral("browser_upload needs at least one path.");
    return batch;
  }
  if (paths.size() > kMaxUploadFiles) {
    batch.error = QStringLiteral("browser_upload takes at most %1 files.")
                      .arg(kMaxUploadFiles);
    return batch;
  }
  for (const QString &raw : paths) {
    const QString path = raw.trimmed();
    const QFileInfo info(path);
    // Absolute only: a relative path would resolve against whatever directory
    // this server happens to run in, which the caller cannot see and did not
    // choose.
    if (!info.isAbsolute()) {
      batch.error =
          QStringLiteral("browser_upload needs an absolute path: %1").arg(path);
      return batch;
    }
    const QString canonical = info.canonicalFilePath();
    if (canonical.isEmpty() || !info.exists() || !info.isFile()) {
      batch.error = QStringLiteral("No such file: %1").arg(path);
      return batch;
    }
    if (!uploadPathAllowed(canonical, roots)) {
      batch.error =
          QStringLiteral(
              "That file is outside CHROME_CONTROL_MCP_UPLOAD_ROOTS: %1")
              .arg(canonical);
      return batch;
    }
    QFile file(canonical);
    if (!file.open(QIODevice::ReadOnly)) {
      batch.error = QStringLiteral("Cannot read %1: %2")
                        .arg(canonical, file.errorString());
      return batch;
    }
    const qint64 size = file.size();
    if (size > kMaxUploadFileBytes) {
      batch.error =
          QStringLiteral("%1 is %2 bytes; browser_upload carries at most %3.")
              .arg(canonical)
              .arg(size)
              .arg(kMaxUploadFileBytes);
      return batch;
    }
    const QByteArray contents = file.readAll();
    if (contents.size() != size) {
      batch.error = QStringLiteral("Could not read all of %1.").arg(canonical);
      return batch;
    }
    const QByteArray encoded = contents.toBase64();
    UploadFile upload;
    upload.name = info.fileName();
    upload.mime = uploadMimeForName(info.fileName());
    upload.size = size;
    // An empty file still needs one (empty) piece: the extension counts the
    // pieces it was promised, and zero of them would never assemble.
    for (qsizetype offset = 0; offset < encoded.size();
         offset += kUploadChunkBase64Chars) {
      upload.chunks.append(
          QString::fromLatin1(encoded.mid(offset, kUploadChunkBase64Chars)));
    }
    if (upload.chunks.isEmpty()) {
      upload.chunks.append(QString());
    }
    batch.files.append(upload);
  }
  batch.ok = true;
  return batch;
}

} // namespace chrome_control_mcp::browser
