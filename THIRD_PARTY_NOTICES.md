# Third-party notices

Chrome Control MCP source code is licensed under the MIT License. Official binary release archives
also contain an unmodified, dynamically linked Qt Core 6.10.0 runtime from the Qt Project.

Qt Core is copyright The Qt Company Ltd. and other contributors. It is distributed in the official
archives under the GNU Lesser General Public License version 3 option. The archive includes the
LGPLv3 and incorporated GPLv3 texts under `LICENSES/`, plus the QtBase SPDX software bill of
materials as `LICENSES/qtbase.spdx`.

The exact QtBase source corresponding to the packaged runtime is available from the
[QtBase 6.10.0 source tree](https://github.com/qt/qtbase/tree/5a8637e4516bc48a0b3f4b5ec3b18618b92e7222).
The runtime remains a separate shared library or framework and may be replaced with a compatible
build.

Qt Core can contain third-party components under their own terms. The included SPDX document is
the authoritative inventory for the exact Qt package used to build each archive. Nothing in the
MIT License for Chrome Control MCP changes those third-party terms.
