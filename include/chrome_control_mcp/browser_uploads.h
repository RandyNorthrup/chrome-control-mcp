// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QByteArray>
#include <QFile>
#include <QString>
#include <QStringList>
#include <QVector>

/// @file browser_uploads.h
/// @brief Reading the files browser_upload attaches, and the rules about which
/// files may be read at all.
///
/// browser_upload is the one tool that carries the user's own disk into a web
/// page. Everything that decides WHETHER a file may go lives here, in a pure
/// unit with no transport and no Chrome: a path must be absolute and name a
/// real file, a file must fit the cap, and, when the operator sets
/// CHROME_CONTROL_MCP_UPLOAD_ROOTS, a file must sit inside one of those roots.
/// The bytes go base64-encoded in bridge-sized pieces, because Chrome accepts
/// at most 1 MiB in one message from a native host.
namespace chrome_control_mcp::browser {

/// The largest file sent whole: a clipboard's, which the extension's worker
/// holds until a paste, and any file sent to an extension older than 1.11.0,
/// which holds every piece in its worker. Base64 inflates by a third, and the
/// extension refuses more than 24 MiB of it.
inline constexpr qint64 kMaxUploadFileBytes = 16 * 1024 * 1024;
/// browser_upload's cap when CHROME_CONTROL_MCP_UPLOAD_MAX_MB is unset. Its
/// pieces go straight into the page (1.11.0), so nothing holds a whole file.
inline constexpr qint64 kDefaultUploadCapBytes = 2LL * 1024 * 1024 * 1024;
/// The most CHROME_CONTROL_MCP_UPLOAD_MAX_MB may set, in MiB. The extension
/// refuses more than this for one file whatever it is sent.
inline constexpr int kMaxUploadCapMiB = 8192;
/// How many files one call may attach.
inline constexpr int kMaxUploadFiles = 8;
/// Base64 characters per chunk frame. One native-messaging message from a host
/// to Chrome may not exceed 1 MiB, and the frame carries JSON around this.
inline constexpr int kUploadChunkBase64Chars = 512 * 1024;
/// The bytes one piece carries: what kUploadChunkBase64Chars of base64 holds.
inline constexpr qint64 kUploadPieceBytes = kUploadChunkBase64Chars / 4 * 3;

/// One file, read and ready to send.
struct UploadFile {
  QString name;       ///< The file's own name, as the page will see it.
  QString mime;       ///< Guessed from the suffix; empty when unknown.
  qint64 size{0};     ///< Bytes on disk.
  QStringList chunks; ///< base64 of the contents, in order.
};

/// The outcome of reading a call's files: either every file, or the first
/// reason none of them may be sent.
struct UploadBatch {
  QVector<UploadFile> files;
  bool ok{false};
  QString error;
};

/// browser_upload's cap, from CHROME_CONTROL_MCP_UPLOAD_MAX_MB.
struct UploadCap {
  qint64 bytes{kDefaultUploadCapBytes};
  /// Why the variable was not used, when it was set to something that is not
  /// a whole number of MiB from 1 to kMaxUploadCapMiB; empty otherwise.
  QString problem;
};

/// The cap that @p value, the variable's text (empty when unset), sets. A
/// value that is not a whole number of MiB in range fails closed to
/// kMaxUploadFileBytes, the bound before the cap existed, and says why.
[[nodiscard]] UploadCap uploadCapFromValue(const QString &value);

/// One file checked but not read.
struct UploadSource {
  QString path; ///< Canonical; it stops here and never reaches the browser.
  QString name; ///< The file's own name, as the page will see it.
  QString mime; ///< Guessed from the suffix; empty when unknown.
  qint64 size{0};
};

/// The outcome of checking a call's files: either every file, or the first
/// reason none of them may be sent.
struct UploadPlan {
  QVector<UploadSource> files;
  bool ok{false};
  QString error;
};

/// Check @p paths for one call of @p tool without reading them: absolute, a
/// real file, inside @p roots when that is set, at most kMaxUploadFiles, and
/// none larger than @p max_bytes. @p over_cap says, after the sizes, what the
/// cap is and how to change it, so a refusal tells the caller what to do.
[[nodiscard]] UploadPlan planUploadFiles(const QStringList &paths,
                                         const QString &roots, qint64 max_bytes,
                                         const QString &over_cap,
                                         const QString &tool);

/// A checked file's pieces, read from disk one at a time as they are sent, so
/// no more than one piece of it is ever in memory here.
class UploadPieceReader {
public:
  explicit UploadPieceReader(const UploadSource &source);

  /// How many pieces the file goes as: at least one, since the extension
  /// counts the pieces it was promised and zero would never assemble.
  [[nodiscard]] int total() const { return total_; }

  /// The next piece as base64, or false with @p error saying why: the file
  /// could not be read, or it changed size after it was checked -- sending a
  /// file that is not the one checked would be worse than sending none.
  bool next(QString *base64, QString *error);

private:
  QFile file_;
  QString name_;
  qint64 size_{0};
  qint64 read_{0};
  int total_{1};
  int sent_{0};
};

/// Read @p paths for one call of @p tool (browser_upload, or browser_clipboard
/// writing files), which its refusals name. @p roots is the value of
/// CHROME_CONTROL_MCP_UPLOAD_ROOTS: when non-empty, a file outside every root
/// is refused. Symlinks and `..` are resolved before that test, so a path
/// cannot point inside a root and read outside it. Every file is read whole,
/// so each is bounded at @p max_bytes (kMaxUploadFileBytes unless the caller
/// knows better); @p over_cap explains that bound in a refusal.
[[nodiscard]] UploadBatch
readUploadFiles(const QStringList &paths, const QString &roots,
                const QString &tool = QStringLiteral("browser_upload"),
                qint64 max_bytes = kMaxUploadFileBytes,
                const QString &over_cap = {});

/// True when @p canonical_path sits inside one of @p roots (or roots is
/// empty, which means the operator set no restriction). Exposed for tests.
[[nodiscard]] bool uploadPathAllowed(const QString &canonical_path,
                                     const QString &roots);

/// The MIME type for a file name's suffix, or an empty string when unknown. The
/// page is told what the file is, the same way a browser's own file picker
/// would tell it.
[[nodiscard]] QString uploadMimeForName(const QString &name);

} // namespace chrome_control_mcp::browser
