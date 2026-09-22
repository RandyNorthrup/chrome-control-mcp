// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QByteArray>
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
/// real file, a file must fit the bridge, and, when the operator sets
/// CHROME_CONTROL_MCP_UPLOAD_ROOTS, a file must sit inside one of those roots.
/// The bytes come back base64-encoded and already cut into bridge-sized pieces,
/// because Chrome accepts at most 1 MiB in one message from a native host.
namespace chrome_control_mcp::browser {

/// The largest single file browser_upload will read, in bytes. Base64 inflates
/// by a third, and the extension refuses more than 24 MiB of it.
inline constexpr qint64 kMaxUploadFileBytes = 16 * 1024 * 1024;
/// How many files one call may attach.
inline constexpr int kMaxUploadFiles = 8;
/// Base64 characters per chunk frame. One native-messaging message from a host
/// to Chrome may not exceed 1 MiB, and the frame carries JSON around this.
inline constexpr int kUploadChunkBase64Chars = 512 * 1024;

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

/// Read @p paths for one browser_upload call. @p roots is the value of
/// CHROME_CONTROL_MCP_UPLOAD_ROOTS: when non-empty, a file outside every root
/// is refused. Symlinks and `..` are resolved before that test, so a path
/// cannot point inside a root and read outside it.
[[nodiscard]] UploadBatch readUploadFiles(const QStringList &paths,
                                          const QString &roots);

/// True when @p canonical_path sits inside one of @p roots (or roots is
/// empty, which means the operator set no restriction). Exposed for tests.
[[nodiscard]] bool uploadPathAllowed(const QString &canonical_path,
                                     const QString &roots);

/// The MIME type for a file name's suffix, or an empty string when unknown. The
/// page is told what the file is, the same way a browser's own file picker
/// would tell it.
[[nodiscard]] QString uploadMimeForName(const QString &name);

} // namespace chrome_control_mcp::browser
