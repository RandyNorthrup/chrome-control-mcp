// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The rules about which of the user's files may reach a web page, and how a
// file that may is carried there.
//
// browser_upload is the only tool that reads the user's disk, so these are the
// tests that matter most about it: that a path must be absolute and real, that
// an operator's CHROME_CONTROL_MCP_UPLOAD_ROOTS is honoured and cannot be
// escaped by a path that merely looks like it starts inside a root, and that a
// file arrives whole -- chunked for the bridge, and reassembling to exactly the
// bytes on disk.

#include "chrome_control_mcp/browser_uploads.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <QtTest>

using chrome_control_mcp::browser::kMaxUploadFiles;
using chrome_control_mcp::browser::kUploadChunkBase64Chars;
using chrome_control_mcp::browser::readUploadFiles;
using chrome_control_mcp::browser::UploadBatch;
using chrome_control_mcp::browser::UploadFile;
using chrome_control_mcp::browser::uploadMimeForName;
using chrome_control_mcp::browser::uploadPathAllowed;

namespace {

QString writeFile(const QDir &dir, const QString &name,
                  const QByteArray &contents) {
  const QString path = dir.filePath(name);
  QFile file(path);
  if (!file.open(QIODevice::WriteOnly)) {
    return QString();
  }
  file.write(contents);
  file.close();
  return QFileInfo(path).canonicalFilePath();
}

QByteArray rejoin(const UploadFile &file) {
  QString joined;
  for (const QString &chunk : file.chunks) {
    joined.append(chunk);
  }
  return QByteArray::fromBase64(joined.toLatin1());
}

} // namespace

class BrowserUploadsTests : public QObject {
  Q_OBJECT

private slots:
  void read_returnsTheFileWhole();
  void read_cutsALargeFileIntoBridgeSizedPieces();
  void read_refusesRelativeAndMissingPaths();
  void read_refusesMoreFilesThanTheLimit();
  void roots_confineUploadsAndCannotBeEscaped();
  void mime_namesCommonTypesAndAdmitsWhenItCannot();
};

void BrowserUploadsTests::read_returnsTheFileWhole() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  // Embedded NULs and high bytes: a file is bytes, not text, and base64 must
  // carry it back byte for byte.
  const QByteArray contents =
      QByteArray("hello upload", 12) + QByteArray("\x00\x01\xFE", 3);
  const QString path =
      writeFile(QDir(dir.path()), QStringLiteral("note.txt"), contents);
  QVERIFY(!path.isEmpty());

  const UploadBatch batch = readUploadFiles({path}, QString());
  QVERIFY2(batch.ok, qPrintable(batch.error));
  QCOMPARE(batch.files.size(), 1);
  QCOMPARE(batch.files.at(0).name, QStringLiteral("note.txt"));
  QCOMPARE(batch.files.at(0).size, static_cast<qint64>(contents.size()));
  // The bytes the page will see are the bytes on disk, not a lossy re-encoding.
  QCOMPARE(rejoin(batch.files.at(0)), contents);
}

void BrowserUploadsTests::read_cutsALargeFileIntoBridgeSizedPieces() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  // Comfortably more than one chunk, so the ordering and the rejoin are
  // actually exercised rather than trivially satisfied by a single piece.
  QByteArray contents;
  contents.resize(3 * 1024 * 1024);
  for (qsizetype i = 0; i < contents.size(); ++i) {
    contents[i] = static_cast<char>(i % 251);
  }
  const QString path =
      writeFile(QDir(dir.path()), QStringLiteral("big.bin"), contents);
  QVERIFY(!path.isEmpty());

  const UploadBatch batch = readUploadFiles({path}, QString());
  QVERIFY2(batch.ok, qPrintable(batch.error));
  const UploadFile &file = batch.files.at(0);
  QVERIFY(file.chunks.size() > 1);
  for (const QString &chunk : file.chunks) {
    // Every piece must fit what Chrome accepts in one message from a host.
    QVERIFY(chunk.size() <= kUploadChunkBase64Chars);
  }
  QCOMPARE(rejoin(file), contents);
}

void BrowserUploadsTests::read_refusesRelativeAndMissingPaths() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const UploadBatch relative =
      readUploadFiles({QStringLiteral("notes/report.pdf")}, QString());
  QVERIFY(!relative.ok);
  QVERIFY(relative.error.contains(QStringLiteral("absolute")));

  const UploadBatch missing = readUploadFiles(
      {QDir(dir.path()).filePath(QStringLiteral("nope.txt"))}, QString());
  QVERIFY(!missing.ok);
  QVERIFY(missing.error.contains(QStringLiteral("No such file")));

  // A directory is not a file, and reading one as though it were would produce
  // an empty attachment the caller would have to notice for themselves.
  const UploadBatch directory = readUploadFiles({dir.path()}, QString());
  QVERIFY(!directory.ok);
}

void BrowserUploadsTests::read_refusesMoreFilesThanTheLimit() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  QStringList paths;
  for (int i = 0; i <= kMaxUploadFiles; ++i) {
    const QString path =
        writeFile(QDir(dir.path()), QStringLiteral("f%1.txt").arg(i),
                  QByteArrayLiteral("x"));
    QVERIFY(!path.isEmpty());
    paths.append(path);
  }
  const UploadBatch batch = readUploadFiles(paths, QString());
  QVERIFY(!batch.ok);
  QVERIFY(batch.error.contains(QStringLiteral("at most")));
}

void BrowserUploadsTests::roots_confineUploadsAndCannotBeEscaped() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QDir base(dir.path());
  QVERIFY(base.mkpath(QStringLiteral("allowed")));
  QVERIFY(base.mkpath(QStringLiteral("allowed-secrets")));
  const QString root =
      QFileInfo(base.filePath(QStringLiteral("allowed"))).canonicalFilePath();
  const QString inside =
      writeFile(QDir(root), QStringLiteral("ok.txt"), QByteArrayLiteral("ok"));
  const QString sibling =
      writeFile(QDir(base.filePath(QStringLiteral("allowed-secrets"))),
                QStringLiteral("keys.txt"), QByteArrayLiteral("secret"));
  QVERIFY(!inside.isEmpty());
  QVERIFY(!sibling.isEmpty());

  QVERIFY(uploadPathAllowed(inside, root));
  // "allowed-secrets" starts with "allowed"; a prefix test that missed the
  // separator would hand the neighbouring directory over.
  QVERIFY(!uploadPathAllowed(sibling, root));
  // No roots configured means no restriction, which is the default.
  QVERIFY(uploadPathAllowed(sibling, QString()));

  const UploadBatch refused = readUploadFiles({sibling}, root);
  QVERIFY(!refused.ok);
  QVERIFY(refused.error.contains(QStringLiteral("UPLOAD_ROOTS")));

  const UploadBatch allowed = readUploadFiles({inside}, root);
  QVERIFY2(allowed.ok, qPrintable(allowed.error));

  // A path that walks out of a root through "..": canonicalised before the
  // test, so it is judged where it actually lands.
  const QString escape =
      QDir(root).filePath(QStringLiteral("../allowed-secrets/keys.txt"));
  const UploadBatch walked = readUploadFiles({escape}, root);
  QVERIFY(!walked.ok);
}

void BrowserUploadsTests::mime_namesCommonTypesAndAdmitsWhenItCannot() {
  QCOMPARE(uploadMimeForName(QStringLiteral("a.png")),
           QStringLiteral("image/png"));
  QCOMPARE(uploadMimeForName(QStringLiteral("a.pdf")),
           QStringLiteral("application/pdf"));
  // An unknown suffix reports nothing rather than guessing: the page is better
  // served by an empty type than by a confident wrong one.
  QVERIFY(uploadMimeForName(QStringLiteral("a.qqqzz")).isEmpty());
}

QTEST_MAIN(BrowserUploadsTests)
#include "test_browser_uploads.moc"
