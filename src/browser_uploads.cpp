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

UploadCap uploadCapFromValue(const QString &value) {
  UploadCap cap;
  const QString trimmed = value.trimmed();
  if (trimmed.isEmpty()) {
    return cap; // unset: the default
  }
  bool whole = false;
  const int mib = trimmed.toInt(&whole);
  if (whole && mib >= 1 && mib <= kMaxUploadCapMiB) {
    cap.bytes = static_cast<qint64>(mib) * 1024 * 1024;
    return cap;
  }
  // Not understood: the bound from before the cap existed, never a larger one
  // or none, and the refusal says why.
  cap.bytes = kMaxUploadFileBytes;
  cap.problem =
      QStringLiteral("CHROME_CONTROL_MCP_UPLOAD_MAX_MB is \"%1\", which is not "
                     "a whole number of MiB from 1 to %2, so the 16 MiB bound "
                     "applies")
          .arg(trimmed.left(32))
          .arg(kMaxUploadCapMiB);
  return cap;
}

UploadPlan planUploadFiles(const QStringList &paths, const QString &roots,
                           qint64 max_bytes, const QString &over_cap,
                           const QString &tool) {
  UploadPlan plan;
  if (paths.isEmpty()) {
    plan.error = QStringLiteral("%1 needs at least one path.").arg(tool);
    return plan;
  }
  if (paths.size() > kMaxUploadFiles) {
    plan.error = QStringLiteral("%1 takes at most %2 files.")
                     .arg(tool)
                     .arg(kMaxUploadFiles);
    return plan;
  }
  for (const QString &raw : paths) {
    const QString path = raw.trimmed();
    const QFileInfo info(path);
    // Absolute only: a relative path would resolve against whatever directory
    // this server happens to run in, which the caller cannot see and did not
    // choose.
    if (!info.isAbsolute()) {
      plan.error =
          QStringLiteral("%1 needs an absolute path: %2").arg(tool, path);
      return plan;
    }
    const QString canonical = info.canonicalFilePath();
    if (canonical.isEmpty() || !info.exists() || !info.isFile()) {
      plan.error = QStringLiteral("No such file: %1").arg(path);
      return plan;
    }
    if (!uploadPathAllowed(canonical, roots)) {
      plan.error =
          QStringLiteral(
              "That file is outside CHROME_CONTROL_MCP_UPLOAD_ROOTS: %1")
              .arg(canonical);
      return plan;
    }
    QFile file(canonical);
    if (!file.open(QIODevice::ReadOnly)) {
      plan.error = QStringLiteral("Cannot read %1: %2")
                       .arg(canonical, file.errorString());
      return plan;
    }
    const qint64 size = file.size();
    if (size > max_bytes) {
      plan.error =
          QStringLiteral("%1 is %2 bytes; %3 carries at most %4.%5")
              .arg(canonical)
              .arg(size)
              .arg(tool)
              .arg(max_bytes)
              .arg(over_cap.isEmpty() ? QString()
                                      : QStringLiteral(" ") + over_cap);
      return plan;
    }
    plan.files.append({.path = canonical,
                       .name = info.fileName(),
                       .mime = uploadMimeForName(info.fileName()),
                       .size = size});
  }
  plan.ok = true;
  return plan;
}

UploadPieceReader::UploadPieceReader(const UploadSource &source)
    : file_(source.path), name_(source.name), size_(source.size),
      total_(static_cast<int>(std::max<qint64>(
          1, (source.size + kUploadPieceBytes - 1) / kUploadPieceBytes))) {}

bool UploadPieceReader::next(QString *base64, QString *error) {
  if (sent_ >= total_) {
    *error = QStringLiteral("%1 has no more pieces.").arg(name_);
    return false;
  }
  if (!file_.isOpen() && !file_.open(QIODevice::ReadOnly)) {
    *error =
        QStringLiteral("Cannot read %1: %2").arg(name_, file_.errorString());
    return false;
  }
  const qint64 want = std::min(kUploadPieceBytes, size_ - read_);
  const QByteArray piece = file_.read(want);
  // The last piece must end the file exactly: a short read, or bytes past the
  // size that was checked, mean this is no longer the file that was checked.
  const bool last = sent_ + 1 == total_;
  if (piece.size() != want || (last && !file_.atEnd())) {
    *error = QStringLiteral("%1 changed while it was being sent; nothing was "
                            "assigned.")
                 .arg(name_);
    return false;
  }
  read_ += piece.size();
  ++sent_;
  *base64 = QString::fromLatin1(piece.toBase64());
  return true;
}

UploadBatch readUploadFiles(const QStringList &paths, const QString &roots,
                            const QString &tool, qint64 max_bytes,
                            const QString &over_cap) {
  UploadBatch batch;
  const UploadPlan plan =
      planUploadFiles(paths, roots, max_bytes, over_cap, tool);
  if (!plan.ok) {
    batch.error = plan.error;
    return batch;
  }
  for (const UploadSource &source : plan.files) {
    QFile file(source.path);
    if (!file.open(QIODevice::ReadOnly)) {
      batch.error = QStringLiteral("Cannot read %1: %2")
                        .arg(source.path, file.errorString());
      return batch;
    }
    const QByteArray contents = file.readAll();
    if (contents.size() != source.size) {
      batch.error =
          QStringLiteral("Could not read all of %1.").arg(source.path);
      return batch;
    }
    const QByteArray encoded = contents.toBase64();
    UploadFile upload;
    upload.name = source.name;
    upload.mime = source.mime;
    upload.size = source.size;
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
