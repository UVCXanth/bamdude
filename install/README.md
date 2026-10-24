# BamDude Installation Scripts

Interactive installation scripts for BamDude with support for both native and Docker deployments.

## Quick Start

### Docker Installation (Recommended)

**Linux/macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/kainpl/bamdude/main/install/docker-install.sh -o docker-install.sh && chmod +x docker-install.sh && ./docker-install.sh
```

### Native Installation

**Linux/macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/kainpl/bamdude/main/install/install.sh -o install.sh && chmod +x install.sh && ./install.sh
```

**Windows:** download the latest `bamdude-windows-setup.exe` from the
[Releases page](https://github.com/kainpl/bamdude/releases) and run it. It's a
self-contained installer — no Python or Node install required on the target
machine. See [`installers/windows/`](../installers/windows/) to build it yourself.

---

## Scripts Overview

| Script | Platform | Method |
|--------|----------|--------|
| `install.sh` | Linux, macOS | Native (Python venv) |
| `installers/windows/` `.exe` | Windows 10/11 | Self-contained installer (embedded Python + NSSM service) |
| `docker-install.sh` | Linux, macOS | Docker |
| `update.sh` | Linux (systemd) | Native update helper |
| `step-preview.sh` | Linux, macOS | Enables, repairs and checks the STEP preview component of a native install |

---

## Native Installation Scripts

### `install.sh` (Linux/macOS)

Installs BamDude with Python virtual environment and optional systemd/launchd service.

**Supported Systems:**
- Debian/Ubuntu (apt)
- RHEL/Fedora/CentOS (dnf/yum)
- Arch Linux (pacman)
- openSUSE (zypper)
- macOS 12 or newer (Homebrew)

**Options:**
```
--path PATH        Installation directory (default: /opt/bamdude)
--port PORT        Port to listen on (default: 8000)
--tz TIMEZONE      Timezone (default: system timezone)
--data-dir PATH    Data directory (default: INSTALL_PATH/data)
--log-dir PATH     Log directory (default: INSTALL_PATH/logs)
--db BACKEND       Database: sqlite (default) | embedded | external
--database-url URL External database URL (implies --db external)
--debug            Enable debug mode
--log-level LEVEL  Log level: DEBUG, INFO, WARNING, ERROR (default: INFO)
--no-service       Skip systemd/launchd service setup
--yes, -y          Non-interactive mode, accept defaults
--with-step-preview  Install the STEP preview component without asking
```

**Examples:**
```bash
# Interactive installation
./install.sh

# Unattended with custom settings
./install.sh --path /srv/bamdude --port 3000 --tz America/New_York --yes

# Minimal unattended
./install.sh -y

# Skip service setup
./install.sh --no-service -y
```

### Windows installer (`.exe`, Windows 10/11)

BamDude ships a self-contained native Windows installer built with Inno Setup —
it bundles an embedded Python 3.12 distribution, the pre-built frontend, NSSM,
and a static ffmpeg, so **nothing** needs to be installed on the target machine.

Download `bamdude-windows-setup.exe` from the
[Releases page](https://github.com/kainpl/bamdude/releases) and run it. It:

- installs to `C:\Program Files\BamDude\`,
- keeps data and logs outside the program folder at `C:\ProgramData\BamDude\{data,logs}\`
  (preserved on uninstall by default), and
- registers BamDude as an NSSM-supervised Windows Service that autostarts on boot
  and serves `http://localhost:8000`.

A Start Menu shortcut opens the web UI in your browser. To build the installer
yourself, see [`installers/windows/README.md`](../installers/windows/README.md).

### STEP previews on a native install

3D thumbnails of STEP files need an optional component of about 170 MB (an
OpenCascade build). Docker images and the Windows installer ship it; on a
native install it is your choice:

- `install.sh` asks *"Install the STEP preview component?"*. The answer
  defaults to **yes** when this install already has it enabled and to **no**
  otherwise, so `--yes` keeps an enabled component and leaves a fresh install
  without one. `--with-step-preview` installs it without asking.
- It is offered on Debian/Ubuntu and Fedora/RHEL (the script installs the
  system libraries it needs, as root: `libgl1 libx11-6 libexpat1 zlib1g` or
  `mesa-libGL libX11 expat zlib`) and on macOS (nothing extra), on x86_64 and
  arm64. On Arch Linux and openSUSE it is not offered: install libGL, libX11
  and expat yourself, then run `install/step-preview.sh enable`.
- Without it STEP files are still kept in the library; they just get no
  thumbnail (the job ends with `cad_unavailable`).

To enable it later, or repair it, run from the install directory (BamDude may
keep running; the next STEP thumbnail uses the component):

```bash
sudo install/step-preview.sh enable    # records the choice, installs the libraries, then the component
sudo install/step-preview.sh status    # checks that it really renders, and says what to do if not
```

On macOS run both without `sudo` (the script refuses to run as root there). `--path DIR` points them at another install.
They exit `0` when done (or when the component works), `1` on a failure, with
its reason, and `3` when the component is not available for this machine or
its Python. `enable` waits at most 15 minutes for another install of the
component, 15 minutes for the download and 120 seconds for each check of it;
reading its files and proving its processes ended are not bounded.

What a reason means:

| Reason | What to do |
|--------|------------|
| `smoke_failed:system_library:<soname>` | A system library is missing: install the package `status` names, then run `enable` |
| `permission` | Something under `runtime/` is not writable by the install's owner (often left by an earlier `sudo` run): `sudo chown -R <owner> <install>/runtime`, then `enable` |
| `lock_timeout` | Another install of the component held its lock for 15 minutes: let it finish, then run `enable` again |
| `helper_unproven` | An update from Settings could not prove an earlier run of the helper ended: restart BamDude, then update again or run `enable` |
| `pip_timeout`, `pip_failed` | The download did not complete: check the network, then run `enable` |

When an install or update finds a half-finished folder of an earlier run of
the component and cannot prove that run has ended, it keeps the folder for a
later install. The log then has one warning per such folder, starting
`bamdude-step-staging-kept`, with the reason as a closed code: the helper
prints it to its error output, and an update from Settings writes it to
BamDude's log. It names no path or user, and nothing about the folder changes
because of it.

Updates keep an enabled component current: `update.sh` and an update from
Settings refresh it, and `update.sh` removes an older version only when it can
prove the service stopped (cgroup v2: the unit's group is empty); otherwise it
keeps it and says so. The version the code before the update runs on is always
kept — a start that fails rolls the code back to it — and goes with the next
update. A failure here never fails the update; an update from
Settings names the reason under its result. The System page
shows the component's state — installed or not, never "works", which only
`status` checks — and, on a native install, these two commands. Choosing
*no* (or `disabled`) stops updates from touching the component; it does not
remove one that is already installed.

---

## Docker Installation Scripts

### `docker-install.sh` (Linux/macOS)

Installs BamDude using Docker containers.

**Options:**
```
--path PATH        Installation directory (default: ~/bamdude)
--port PORT        Port to expose (default: 8000)
--tz TIMEZONE      Timezone (default: system timezone)
--build            Build from source instead of using pre-built image
--yes, -y          Non-interactive mode, accept defaults
```

**Examples:**
```bash
# Interactive installation
./docker-install.sh

# Unattended with custom settings
./docker-install.sh --path /srv/bamdude --port 3000 --tz Europe/Berlin --yes

# Build from source
./docker-install.sh --build --yes
```

---

## Configuration Options

All scripts support these configuration options:

| Option | Description | Default |
|--------|-------------|---------|
| Install Path | Where BamDude is installed | `/opt/bamdude` (Linux/Docker) |
| Port | HTTP port for web interface | `8000` |
| Timezone | Server timezone | System timezone or `UTC` |
| Data Directory | Database and archives | `INSTALL_PATH/data` |
| Log Directory | Application logs | `INSTALL_PATH/logs` |
| Debug Mode | Enable verbose logging | `false` |
| Log Level | INFO, WARNING, ERROR, DEBUG | `INFO` |

---

## Post-Installation

### Accessing BamDude

After installation, open your browser to:
```
http://localhost:8000
```

Or use the port you specified during installation.

### Service Management

**Linux (systemd):**
```bash
sudo systemctl status bamdude    # Check status
sudo systemctl start bamdude     # Start
sudo systemctl stop bamdude      # Stop
sudo systemctl restart bamdude   # Restart
sudo journalctl -u bamdude -f    # View logs
```

**macOS (launchd):**
```bash
launchctl list | grep bamdude                              # Check status
launchctl load ~/Library/LaunchAgents/com.bamdude.app.plist    # Start
launchctl unload ~/Library/LaunchAgents/com.bamdude.app.plist  # Stop
```

**Windows (Service):**
```powershell
Get-Service BamDude          # Check status
Start-Service BamDude        # Start
Stop-Service BamDude         # Stop
Restart-Service BamDude      # Restart
```

**Docker:**
```bash
docker compose ps           # Check status
docker compose up -d        # Start
docker compose down         # Stop
docker compose restart      # Restart
docker compose logs -f      # View logs
```

### Updating

**Native installation:**
```bash
curl -fsSL https://raw.githubusercontent.com/kainpl/bamdude/main/install/update.sh -o update.sh
chmod +x update.sh
sudo ./update.sh
```

The updater performs:
- Root permission check (fails fast before any work)
- Runs git, pip and npm as the install's owner, never as root; root keeps systemd. The owner must be the
  service's user, and nothing of the install outside `data/`, `logs/`, `backups/` and `runtime/` may belong to
  anyone else (an update run as root before left such files). Either problem stops the update before anything
  changes and names the repair, e.g. `sudo chown -R bamdude: /opt/bamdude`. So does an `npm` that only root can
  find (one from nvm or asdf, say): the build runs as the owner, so install Node.js system-wide. An install
  reached through a symlink is checked through the link
- Optional built-in backup API call (`/api/v1/settings/backup`) before update
- Keeps only the newest 5 local backup ZIP files
- Local-change warning + confirmation before `git reset --hard`
- If remote has no new commits, the updater asks whether to run anyway; the default (no) exits without stopping the service
- Refreshes an enabled STEP preview component (see [STEP previews on a native install](#step-previews-on-a-native-install))
- Service stop/start with code rollback + service restart attempt if update fails

Useful environment overrides:
```bash
# Typical native install defaults
INSTALL_DIR=/opt/bamdude SERVICE_NAME=bamdude sudo ./update.sh

# Require backup to succeed (abort update if backup fails)
BACKUP_MODE=require sudo ./update.sh

# Skip backup API call
BACKUP_MODE=skip sudo ./update.sh

# Auth-enabled instances: provide API key for backup endpoint
BAMDUDE_API_KEY=bd_xxx BACKUP_MODE=require sudo ./update.sh
```

**Docker (pre-built image):**
```bash
cd ~/bamdude
docker compose pull
docker compose up -d
```

**Docker (from source):**
```bash
cd ~/bamdude
git pull
docker compose up -d --build
```

---

## Troubleshooting

### Permission Denied (Linux)
Run with `sudo` or ensure your user has appropriate permissions:
```bash
sudo ./install.sh
```

### Docker: Printer Discovery Not Working
Docker Desktop for macOS doesn't support host networking. Add printers manually by IP address in the BamDude web interface.

### Service Won't Start
Check logs for errors:
```bash
# Linux
sudo journalctl -u bamdude -n 50

# Docker
docker compose logs bamdude
```

### Port Already in Use
Choose a different port during installation or stop the conflicting service:
```bash
# Find what's using port 8000
sudo lsof -i :8000  # Linux/macOS
```

---

## Requirements

### Native Installation
- Python 3.12+ (automatically installed if missing)
- Node.js 18+ (automatically installed if missing)
- Git (automatically installed if missing)
- ~500MB disk space

### Docker Installation
- Docker Engine 20+ or Docker Desktop
- ~1GB disk space (includes image)

---

## Support

- **Documentation:** https://docs.bamdude.top
- **Discord:** https://discord.gg/aFS3ZfScHM
- **Issues:** https://github.com/kainpl/bamdude/issues
