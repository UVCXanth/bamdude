Third-party notices of BamDude's STEP-preview CAD component
============================================================

The STEP thumbnails are made by OCP (cadquery-ocp-novtk 8.0.1.1.0), Python
bindings of Open CASCADE Technology 8.0.1, installed under
runtime/step-preview/ as the exact wheels named in ../step_runtime_manifest.json.
Those wheels carry further native libraries; ../step_runtime_notices.json lists,
per platform family (linux, windows, macos):

  - every component whose libraries the wheels carry, with the file-name
    patterns of those libraries (a test checks that every library of every
    pinned wheel belongs to exactly one component);
  - its version, its licence as declared by its packager, and - where that
    licence offers alternatives - the one BamDude distributes it under
    ("terms");
  - parts compiled into another library ("embedded": pybind11 in OCP,
    RapidJSON in OCCT);
  - the licence texts, which are the files in this directory;
  - its corresponding source: a git commit or tag, a source RPM by its exact
    name, or a source archive with its SHA-256.

Open CASCADE Technology is distributed under the GNU Lesser General Public
License version 2.1 with the Open CASCADE exception (upstream/occt/).

Terms BamDude distributes under
-------------------------------

Where a component's licence offers alternatives, BamDude takes the terms that
place the least on the AGPL-3.0 application around it:

  - FreeType (2.9.1 on Linux, 2.12.1 on Windows and macOS): the FreeType
    License, FTL - not the GPL-2.0.
  - FreeImage (3.17.0 on Linux, 3.18.0 on Windows and macOS): the FreeImage
    Public License, FreeImage - not the GPL.
  - LibRaw (0.19.5 on Linux): LGPL-2.1-only - not the CDDL-1.0; the Windows
    and macOS builds are offered under LGPL-2.1-only alone.
  - libgomp (Linux), GCC's runtime library:
    GPL-3.0-or-later WITH GCC-exception-3.1

FreeType credit, as the FTL asks:

  Portions of this software are copyright © 2018 The FreeType Project
  (www.freetype.org). All rights reserved. (FreeType 2.9.1, Linux)

  Portions of this software are copyright © 2022 The FreeType Project
  (www.freetype.org). All rights reserved. (FreeType 2.12.1, Windows, macOS)

Corresponding source
--------------------

The components distributed under a licence that asks for their source - Open
CASCADE Technology, LibRaw, FreeImage and, on Linux, libgomp - have their exact
corresponding source published by BamDude itself. Every BamDude release that
carries this component has, on its page under
https://github.com/kainpl/bamdude/releases, the asset

  bamdude-step-preview-sources-533f263356f9.tar

with its SHA-256 beside it (the name follows the closure_sha256 of
../step_runtime_notices.json). Its SOURCES.json names every file with its
SHA-256, where it was taken from and the components it is the source of: the
source RPMs as their vendor signed them, the source archives by the SHA-256
their builds pinned, and Open CASCADE Technology as the tree of its tagged
commit.

For at least three years after BamDude last distributed a version that carries
this component, the same source is also available on request, for no more than
the cost of providing it: open an issue at https://github.com/kainpl/bamdude/issues.
