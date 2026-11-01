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

using chrome_control_mcp::browser::kDefaultUploadCapBytes;
using chrome_control_mcp::browser::kMaxUploadCapMiB;
using chrome_control_mcp::browser::kMaxUploadFileBytes;
using chrome_control_mcp::browser::kMaxUploadFiles;
using chrome_control_mcp::browser::kUploadChunkBase64Chars;
using chrome_control_mcp::browser::kUploadPieceBytes;
using chrome_control_mcp::browser::planUploadFiles;
using chrome_control_mcp::browser::readUploadFiles;
using chrome_control_mcp::browser::UploadBatch;
using chrome_control_mcp::browser::UploadCap;
using chrome_control_mcp::browser::uploadCapFromValue;
using chrome_control_mcp::browser::UploadFile;
using chrome_control_mcp::browser::uploadMimeForName;
using chrome_control_mcp::browser::uploadPathAllowed;
using chrome_control_mcp::browser::UploadPieceReader;
using chrome_control_mcp::browser::UploadPlan;

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
  void cap_isTheOperatorsAndFailsClosed();
  void plan_refusesAFileOverTheCapWithoutReadingIt();
  void pieces_areReadOneAtATimeAndRejoinToTheFile();
  void pieces_stopWhenTheFileChangesUnderThem();
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

void BrowserUploadsTests::cap_isTheOperatorsAndFailsClosed() {
  // Unset: the default, far past every video a channel uploads.
  QCOMPARE(uploadCapFromValue(QString()).bytes, kDefaultUploadCapBytes);
  QVERIFY(uploadCapFromValue(QStringLiteral("  ")).problem.isEmpty());
  // Whole MiB in range: exactly that.
  QCOMPARE(uploadCapFromValue(QStringLiteral("512")).bytes,
           qint64{512} * 1024 * 1024);
  QCOMPARE(uploadCapFromValue(QString::number(kMaxUploadCapMiB)).bytes,
           qint64{kMaxUploadCapMiB} * 1024 * 1024);
  // Anything else fails closed to the old bound -- never a larger cap or none
  // -- and says which variable was not understood.
  for (const QString &bad :
       {QStringLiteral("0"), QStringLiteral("9000"), QStringLiteral("abc"),
        QStringLiteral("1.5"), QStringLiteral("-4"), QStringLiteral("2GB")}) {
    const UploadCap cap = uploadCapFromValue(bad);
    QCOMPARE(cap.bytes, kMaxUploadFileBytes);
    QVERIFY2(cap.problem.contains(
                 QStringLiteral("CHROME_CONTROL_MCP_UPLOAD_MAX_MB")),
             qPrintable(cap.problem));
  }
}

void BrowserUploadsTests::plan_refusesAFileOverTheCapWithoutReadingIt() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QByteArray contents(4096, 'x');
  const QString path =
      writeFile(QDir(dir.path()), QStringLiteral("clip.mp4"), contents);
  // Under the cap: checked, named and typed, and not read -- the plan holds
  // no bytes at all.
  const UploadPlan fits =
      planUploadFiles({path}, QString(), 4096, QString(), "browser_upload");
  QVERIFY2(fits.ok, qPrintable(fits.error));
  QCOMPARE(fits.files.at(0).size, qint64{4096});
  QCOMPARE(fits.files.at(0).name, QStringLiteral("clip.mp4"));
  QCOMPARE(fits.files.at(0).mime, QStringLiteral("video/mp4"));
  // Over it: refused, naming the size, the cap, and what to do about it.
  const UploadPlan over =
      planUploadFiles({path}, QString(), 4095,
                      QStringLiteral("Set CHROME_CONTROL_MCP_UPLOAD_MAX_MB."),
                      "browser_upload");
  QVERIFY(!over.ok);
  QVERIFY2(over.error.contains(QStringLiteral("4096 bytes")) &&
               over.error.contains(QStringLiteral("at most 4095")) &&
               over.error.contains(
                   QStringLiteral("CHROME_CONTROL_MCP_UPLOAD_MAX_MB")),
           qPrintable(over.error));
}

void BrowserUploadsTests::pieces_areReadOneAtATimeAndRejoinToTheFile() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  // Two and a half pieces, so the last is short and the order matters.
  QByteArray contents;
  contents.resize(kUploadPieceBytes * 2 + kUploadPieceBytes / 2);
  for (qsizetype i = 0; i < contents.size(); ++i) {
    contents[i] = static_cast<char>((i * 7) % 253);
  }
  const QString path =
      writeFile(QDir(dir.path()), QStringLiteral("long.bin"), contents);
  const UploadPlan plan = planUploadFiles({path}, QString(), contents.size(),
                                          QString(), "browser_upload");
  QVERIFY2(plan.ok, qPrintable(plan.error));
  UploadPieceReader reader(plan.files.at(0));
  QCOMPARE(reader.total(), 3);
  QByteArray rejoined;
  for (int i = 0; i < reader.total(); ++i) {
    QString piece;
    QString error;
    QVERIFY2(reader.next(&piece, &error), qPrintable(error));
    // One bridge message each, and never more than one piece's bytes.
    QVERIFY(piece.size() <= kUploadChunkBase64Chars);
    const QByteArray bytes = QByteArray::fromBase64(piece.toLatin1());
    QVERIFY(bytes.size() <= kUploadPieceBytes);
    rejoined.append(bytes);
  }
  QCOMPARE(rejoined, contents);
  // No piece past the last.
  QString extra;
  QString error;
  QVERIFY(!reader.next(&extra, &error));

  // An empty file is one empty piece, which the extension can count.
  const QString empty =
      writeFile(QDir(dir.path()), QStringLiteral("empty.txt"), QByteArray());
  const UploadPlan none =
      planUploadFiles({empty}, QString(), 1, QString(), "browser_upload");
  UploadPieceReader nothing(none.files.at(0));
  QCOMPARE(nothing.total(), 1);
  QString piece;
  QVERIFY(nothing.next(&piece, &error));
  QVERIFY(piece.isEmpty());
}

void BrowserUploadsTests::pieces_stopWhenTheFileChangesUnderThem() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QByteArray contents(kUploadPieceBytes + 10, 'a');
  const QString path =
      writeFile(QDir(dir.path()), QStringLiteral("growing.log"), contents);
  const UploadPlan plan = planUploadFiles({path}, QString(), contents.size(),
                                          QString(), "browser_upload");
  QVERIFY(plan.ok);
  // Grown after it was checked: the file being sent is no longer that one.
  {
    QFile file(path);
    QVERIFY(file.open(QIODevice::Append));
    file.write("more");
  }
  UploadPieceReader grown(plan.files.at(0));
  QString piece;
  QString error;
  QVERIFY(grown.next(&piece, &error));
  QVERIFY(!grown.next(&piece, &error));
  QVERIFY2(error.contains(QStringLiteral("changed while it was being sent")),
           qPrintable(error));
  // Shrunk after it was checked: the same.
  {
    QFile file(path);
    QVERIFY(file.open(QIODevice::WriteOnly | QIODevice::Truncate));
    file.write("a");
  }
  UploadPieceReader shrunk(plan.files.at(0));
  QVERIFY(!shrunk.next(&piece, &error));
  QVERIFY2(error.contains(QStringLiteral("changed while it was being sent")),
           qPrintable(error));
}

QTEST_MAIN(BrowserUploadsTests)
#include "test_browser_uploads.moc"
