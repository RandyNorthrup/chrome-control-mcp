// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/install_layout.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QStandardPaths>
#include <QVersionNumber>

#ifdef Q_OS_WIN
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
// FSCTL_SET_REPARSE_POINT, which windows.h alone does not declare.
#include <winioctl.h>

#include <vector>
#else
#include <cerrno>
// rename() is declared in <cstdio>, not <unistd.h>; relying on the latter to
// pull it in transitively builds on some libcs and not others.
#include <cstdio>
#include <string>
#include <system_error>
#include <unistd.h>
#endif

#include <algorithm>

namespace chrome_control_mcp {
namespace {

// Windows compares paths case-insensitively, so a directory named "Current" is
// the same directory as "current" there and a different one everywhere else.
// Recognizing the layout has to follow the platform's own rule or an install
// under a differently-cased path would look unmanaged.
Qt::CaseSensitivity pathCaseSensitivity() {
#ifdef Q_OS_WIN
  return Qt::CaseInsensitive;
#else
  return Qt::CaseSensitive;
#endif
}

bool sameDirectoryName(const QString &name, const char *expected) {
  return name.compare(QLatin1String(expected), pathCaseSensitivity()) == 0;
}

QString cleaned(const QString &path) {
  if (path.isEmpty()) {
    return {};
  }
  return QDir::cleanPath(
      QFileInfo(QDir::fromNativeSeparators(path)).absoluteFilePath());
}

// The directory containing @p path, as text only, or an empty string once the
// walk reaches a filesystem root and there is no parent left to name.
QString parentPath(const QString &path) {
  const QString parent = QFileInfo(path).path();
  if (parent.isEmpty() || parent == path) {
    return {};
  }
  return QDir::cleanPath(parent);
}

} // namespace

InstallLayout InstallLayout::forRoot(const QString &root) {
  if (root.isEmpty()) {
    return {};
  }
  const QString clean = cleaned(root);
  const QDir directory(clean);
  return InstallLayout{
      .root = clean,
      .current = QDir::cleanPath(directory.filePath(
          QString::fromLatin1(kInstallCurrentDirectoryName))),
      .versions = QDir::cleanPath(directory.filePath(
          QString::fromLatin1(kInstallVersionsDirectoryName)))};
}

InstallLayout InstallLayout::resolved(const QString &executable_path) {
  const QString override_root =
      qEnvironmentVariable(kInstallRootEnvironmentVariable);
  if (!override_root.isEmpty()) {
    return forRoot(override_root);
  }
  const QString inferred = installRootForExecutable(executable_path);
  if (!inferred.isEmpty()) {
    return forRoot(inferred);
  }
  return forRoot(defaultInstallRoot());
}

QString InstallLayout::versionDirectory(const QString &version) const {
  if (versions.isEmpty() || !isSafeVersionName(version)) {
    return {};
  }
  return QDir::cleanPath(QDir(versions).filePath(version));
}

QString defaultInstallRoot() {
  QString base =
      QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
  if (base.isEmpty()) {
    base = QDir::homePath();
  }
#ifdef Q_OS_WIN
  // %LOCALAPPDATA%\Programs is where per-user, non-elevated applications
  // install on Windows; following it keeps the install out of the roaming
  // profile and out of Program Files, so no update ever needs elevation.
  return QDir::cleanPath(
      QDir(base).filePath(QStringLiteral("Programs/ChromeControlMCP")));
#else
  // Linux and macOS have no equivalent convention, so the install sits under
  // the same per-user data directory this program already writes to, in its own
  // subdirectory so program files and program data never mix.
  return QDir::cleanPath(
      QDir(base).filePath(QStringLiteral("ChromeControlMCP/app")));
#endif
}

bool isSafeVersionName(const QString &name) {
  if (name.isEmpty() || name.size() > 64) {
    return false;
  }
  // A leading dot is reserved. It rules out "." and ".." -- which are made of
  // otherwise allowed characters but name the versions directory and its parent
  // -- and it is what keeps this function from mistaking the updater's own
  // scratch directories (".staging-1.3.2", ".removing-1.0.0") for installed
  // versions while an update is in flight or a prune is retrying.
  if (name.startsWith(QLatin1Char('.'))) {
    return false;
  }
  return std::all_of(name.cbegin(), name.cend(), [](const QChar character) {
    const bool allowed =
        character.isLetterOrNumber() || character == QLatin1Char('.') ||
        character == QLatin1Char('-') || character == QLatin1Char('_');
    return allowed && character.isPrint() && character.unicode() <= 0x7F;
  });
}

QString installRootForExecutable(const QString &executable_path) {
  if (executable_path.isEmpty()) {
    return {};
  }
  // Walk the path as text. QDir::cd and QDir::cdUp consult the filesystem and
  // refuse a directory that does not exist, which would make this answer depend
  // on whether the install happens to be mounted -- the one thing a pure
  // path-shape question must not depend on.
  const QString directory = parentPath(cleaned(executable_path));
  if (directory.isEmpty()) {
    return {};
  }
  if (sameDirectoryName(QFileInfo(directory).fileName(),
                        kInstallCurrentDirectoryName)) {
    return parentPath(directory);
  }
  // A launch through `current/` can be reported by the operating system as the
  // versioned directory the link resolved to, so that shape names the same
  // install and must be recognized too.
  const QString parent = parentPath(directory);
  if (parent.isEmpty() || !sameDirectoryName(QFileInfo(parent).fileName(),
                                             kInstallVersionsDirectoryName)) {
    return {};
  }
  return parentPath(parent);
}

QString stableExecutablePath(const QString &executable_path) {
  const QString root = installRootForExecutable(executable_path);
  if (root.isEmpty()) {
    return executable_path;
  }
  const InstallLayout layout = InstallLayout::forRoot(root);
  return QDir::cleanPath(
      QDir(layout.current)
          .filePath(QFileInfo(cleaned(executable_path)).fileName()));
}

QStringList installedVersions(const InstallLayout &layout) {
  if (layout.isEmpty()) {
    return {};
  }
  const QDir directory(layout.versions);
  if (!directory.exists()) {
    return {};
  }
  QStringList names =
      directory.entryList(QDir::Dirs | QDir::NoDotAndDotDot, QDir::NoSort);
  names.erase(std::remove_if(
                  names.begin(), names.end(),
                  [](const QString &name) { return !isSafeVersionName(name); }),
              names.end());
  // Version order, not lexical order: sorting "1.10.0" as text puts it below
  // "1.9.0", which would make the newest install look like the oldest and let
  // pruning delete it.
  std::sort(names.begin(), names.end(),
            [](const QString &left, const QString &right) {
              const QVersionNumber left_version =
                  QVersionNumber::fromString(left);
              const QVersionNumber right_version =
                  QVersionNumber::fromString(right);
              if (left_version != right_version) {
                return right_version < left_version;
              }
              return left > right;
            });
  return names;
}

QString currentLinkTarget(const InstallLayout &layout) {
  if (layout.isEmpty()) {
    return {};
  }
  const QFileInfo info(layout.current);
#ifdef Q_OS_WIN
  if (info.isJunction()) {
    return QDir::cleanPath(QDir::fromNativeSeparators(info.junctionTarget()));
  }
#endif
  if (!info.isSymLink()) {
    return {};
  }
  return QDir::cleanPath(QDir::fromNativeSeparators(info.symLinkTarget()));
}

QString currentVersion(const InstallLayout &layout) {
  const QString target = currentLinkTarget(layout);
  if (target.isEmpty()) {
    return {};
  }
  const QString name = QFileInfo(target).fileName();
  return isSafeVersionName(name) ? name : QString{};
}
namespace {

#ifdef Q_OS_WIN

// The user-mode Windows SDK does not publish the reparse-point layout, so the
// mount-point (junction) form is spelled out here. A junction is used rather
// than a symbolic link because creating a symbolic link on Windows needs either
// administrator rights or Developer Mode, and requiring either would make
// updating a privileged operation.
struct MountPointReparseBuffer {
  DWORD ReparseTag;
  WORD ReparseDataLength;
  WORD Reserved;
  WORD SubstituteNameOffset;
  WORD SubstituteNameLength;
  WORD PrintNameOffset;
  WORD PrintNameLength;
  wchar_t PathBuffer[1];
};

// Bytes preceding the span that ReparseDataLength measures: the tag, the
// length itself, and the reserved word.
constexpr DWORD kReparseHeaderBytes = 8;
// The four WORD offsets and lengths that precede PathBuffer and are counted by
// ReparseDataLength.
constexpr WORD kMountPointFixedBytes = 8;

QString lastWindowsError(const QString &action) {
  const DWORD code = GetLastError();
  return QStringLiteral("%1 failed (Windows error %2)")
      .arg(action)
      .arg(static_cast<qulonglong>(code));
}

bool writeJunction(const QString &link, const QString &target, QString *error) {
  const std::wstring link_native =
      QDir::toNativeSeparators(link).toStdWString();
  const std::wstring target_native =
      QDir::toNativeSeparators(target).toStdWString();
  // A junction stores an NT object path as its substitute name; the print name
  // is the ordinary path tools show the user.
  const std::wstring substitute = L"\\??\\" + target_native;

  if (CreateDirectoryW(link_native.c_str(), nullptr) == 0) {
    if (error != nullptr) {
      *error = lastWindowsError(QStringLiteral("Creating the current link"));
    }
    return false;
  }

  const size_t path_characters =
      substitute.size() + 1 + target_native.size() + 1;
  const size_t path_bytes = path_characters * sizeof(wchar_t);
  const WORD data_length =
      static_cast<WORD>(kMountPointFixedBytes + path_bytes);
  const DWORD total_bytes = kReparseHeaderBytes + data_length;

  std::vector<char> storage(total_bytes, '\0');
  auto *reparse = reinterpret_cast<MountPointReparseBuffer *>(storage.data());
  reparse->ReparseTag = IO_REPARSE_TAG_MOUNT_POINT;
  reparse->ReparseDataLength = data_length;
  reparse->Reserved = 0;
  reparse->SubstituteNameOffset = 0;
  reparse->SubstituteNameLength =
      static_cast<WORD>(substitute.size() * sizeof(wchar_t));
  reparse->PrintNameOffset =
      static_cast<WORD>((substitute.size() + 1) * sizeof(wchar_t));
  reparse->PrintNameLength =
      static_cast<WORD>(target_native.size() * sizeof(wchar_t));
  std::copy(substitute.begin(), substitute.end(), reparse->PathBuffer);
  std::copy(target_native.begin(), target_native.end(),
            reparse->PathBuffer + substitute.size() + 1);

  const HANDLE handle = CreateFileW(
      link_native.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    if (error != nullptr) {
      *error = lastWindowsError(QStringLiteral("Opening the current link"));
    }
    RemoveDirectoryW(link_native.c_str());
    return false;
  }

  DWORD returned = 0;
  const BOOL ok =
      DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, storage.data(),
                      total_bytes, nullptr, 0, &returned, nullptr);
  if (ok == 0 && error != nullptr) {
    *error = lastWindowsError(QStringLiteral("Pointing the current link"));
  }
  CloseHandle(handle);
  if (ok == 0) {
    RemoveDirectoryW(link_native.c_str());
    return false;
  }
  return true;
}

#endif // Q_OS_WIN

#ifndef Q_OS_WIN
// std::strerror shares one buffer across threads, so two failures racing in a
// long-lived server can each read the other's message. std::generic_category
// resolves an errno through the thread-safe path the standard library provides
// for exactly this.
QString describeErrno(int value) {
  return QString::fromStdString(std::generic_category().message(value));
}
#endif

// Refuse to touch a current entry that is a real directory rather than a link.
// That is a hand-made install or an extraction into the wrong place, and its
// contents are not this code to delete.
bool currentIsReplaceable(const InstallLayout &layout, QString *error) {
  const QFileInfo info(layout.current);
  if (!info.exists() && !info.isSymLink()) {
    return true; // Nothing there yet, not even a dangling link.
  }
#ifdef Q_OS_WIN
  if (info.isJunction()) {
    return true;
  }
#endif
  if (info.isSymLink()) {
    return true;
  }
  if (error != nullptr) {
    *error = QStringLiteral("%1 exists and is not a link; move it aside before "
                            "installing into this root")
                 .arg(QDir::toNativeSeparators(layout.current));
  }
  return false;
}

} // namespace

bool pointCurrentAtVersion(const InstallLayout &layout, const QString &version,
                           QString *error) {
  if (layout.isEmpty()) {
    if (error != nullptr) {
      *error = QStringLiteral("No install root to point at");
    }
    return false;
  }
  const QString target = layout.versionDirectory(version);
  if (target.isEmpty()) {
    if (error != nullptr) {
      *error = QStringLiteral("Refusing to point the current link at an unsafe "
                              "version name: %1")
                   .arg(version);
    }
    return false;
  }
  if (!QFileInfo(target).isDir()) {
    if (error != nullptr) {
      *error = QStringLiteral("Version %1 is not installed at %2")
                   .arg(version, QDir::toNativeSeparators(target));
    }
    return false;
  }
  if (!currentIsReplaceable(layout, error)) {
    return false;
  }
  if (!QDir().mkpath(layout.root)) {
    if (error != nullptr) {
      *error = QStringLiteral("Could not create the install root at %1")
                   .arg(QDir::toNativeSeparators(layout.root));
    }
    return false;
  }

#ifdef Q_OS_WIN
  // Windows cannot replace one directory entry with another in a single
  // operation, so the old junction is removed first. RemoveDirectoryW deletes
  // the junction itself and never the directory it points at.
  const std::wstring link_native =
      QDir::toNativeSeparators(layout.current).toStdWString();
  const QFileInfo existing(layout.current);
  if (existing.isJunction() || existing.isSymLink() || existing.exists()) {
    if (RemoveDirectoryW(link_native.c_str()) == 0) {
      if (error != nullptr) {
        *error = lastWindowsError(
            QStringLiteral("Removing the previous current link"));
      }
      return false;
    }
  }
  return writeJunction(layout.current, target, error);
#else
  // POSIX can replace a symbolic link atomically: build the new one beside it
  // and rename over the old, so a reader sees either the previous version or
  // the new one and never a missing link.
  const QString staged = layout.current + QStringLiteral(".swap");
  const QByteArray staged_native = staged.toLocal8Bit();
  const QByteArray target_native = target.toLocal8Bit();
  const QByteArray current_native = layout.current.toLocal8Bit();
  ::unlink(staged_native.constData());
  if (::symlink(target_native.constData(), staged_native.constData()) != 0) {
    const int failure = errno;
    if (error != nullptr) {
      *error = QStringLiteral("Creating the current link failed: %1")
                   .arg(describeErrno(failure));
    }
    return false;
  }
  if (::rename(staged_native.constData(), current_native.constData()) != 0) {
    const int failure = errno;
    if (error != nullptr) {
      *error = QStringLiteral("Pointing the current link failed: %1")
                   .arg(describeErrno(failure));
    }
    ::unlink(staged_native.constData());
    return false;
  }
  return true;
#endif
}

int pruneInstalledVersions(const InstallLayout &layout,
                           const QString &keep_version, int keep_recent) {
  if (layout.isEmpty()) {
    return 0;
  }
  QStringList candidates = installedVersions(layout);
  candidates.removeAll(keep_version);
  const qsizetype keep =
      std::max(qsizetype{0}, static_cast<qsizetype>(keep_recent));
  if (candidates.size() <= keep) {
    return 0;
  }
  QDir versions_directory(layout.versions);
  int removed = 0;
  for (qsizetype i = keep; i < candidates.size(); ++i) {
    const QString &name = candidates.at(i);
    // Renaming the directory first is the busy test. A directory holding a file
    // some process still has open cannot be renamed on Windows, so a version
    // still in use is skipped whole rather than half-deleted; on POSIX the
    // rename always succeeds and unlinking an open file is safe anyway.
    // The parked name starts with a dot so a prune that cannot finish leaves
    // behind something installedVersions will not mistake for a version.
    const QString parked = QStringLiteral(".removing-") + name;
    if (!versions_directory.rename(name, parked)) {
      continue;
    }
    if (QDir(versions_directory.filePath(parked)).removeRecursively()) {
      ++removed;
    }
  }
  return removed;
}

} // namespace chrome_control_mcp
