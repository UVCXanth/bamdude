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
