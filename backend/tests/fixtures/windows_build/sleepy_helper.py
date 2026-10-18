"""A stand-in for the build's CAD helper that does NOT own its tree: it starts a sleeping grandchild with a plain
Popen (as verify's smoke starts the converter and the PNG child), writes the grandchild's pid and sleeps itself.
Only the build's own whole-tree owner can end both."""

import subprocess
import sys
import time
from pathlib import Path

marker = Path(sys.argv[1])
grandchild = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
marker.write_text(str(grandchild.pid), encoding="ascii")
time.sleep(120)
