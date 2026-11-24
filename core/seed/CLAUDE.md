# Claude Code Android Agent Rules & Environment Guidelines

> [!NOTE]
> This instruction file (`CLAUDE.md`) is automatically loaded in Claude Code for Android (`v2.1.331`).
> It defines the native Android ARM64 operating environment, package management, and optional ADB/Shizuku plugin tools.

---

## 1. Platform & Environment Identity

- **Platform:** Native Android (Linux kernel 6.1+, ARM64 / `aarch64` architecture).
- **Application Sandbox:** Runs directly inside the `com.cc.ide` package sandbox (zero PRoot, zero container emulation).
- **Key Filesystem Paths:**
  - Application Root (`$HOME`): `/data/user/0/com.cc.ide/files`
  - Bionic Userspace Prefix (`$PREFIX`): `/data/user/0/com.cc.ide/files/usr`
  - User Binary Path: `/data/user/0/com.cc.ide/files/usr/bin`
  - Runtime Internals: `/data/user/0/com.cc.ide/files/runtime/bin`
  - External / Shared Storage: `/storage/emulated/0` (Default workspace: `/storage/emulated/0/Documents/ClaudeCode`)
  - Claude State & Skills: `/data/user/0/com.cc.ide/files/.claude/` (`settings.json`, `skills/`, `rules/`, `plugins-hub/`)
  - Global Config & MCP Registry: `/data/user/0/com.cc.ide/files/.claude/.claude.json`

---

## 2. Terminal Execution Rules

- **No Desktop Bubblewrap (`bwrap`):**
  Unrooted Android SELinux blocks desktop `CLONE_NEWUSER` sandboxes. Sandboxing is disabled in `~/.claude/settings.json` (`"sandbox": {"enabled": false}`). Execute shell commands directly.
- **Always Quote Paths:**
  Android storage paths frequently contain spaces. Always wrap paths in double quotes.
- **Git on Android Shared Storage:**
  When running `git` inside `/storage/emulated/0/...`, ensure:
  ```bash
  export GIT_CONFIG_NOSYSTEM=1
  git config --global --add safe.directory "*"
  ```

---

## 3. Native Package Management (`pkg`)

Claude Code for Android includes a fast native Bionic package manager (`pkg`):

```bash
# Update package indexes:
pkg update

# Install packages (do NOT pass -y; list package names directly):
pkg install git python rust clang cmake make sqlite ffmpeg

# Search and inspect packages:
pkg search <pattern>
pkg installed

# Fix global pip/npm script shebangs after installing CLI packages:
cc-fix-paths
```

---

## 4. Elevated Android Operations (`AGY ADB Bridge` / `rish`)

Elevated `uid=2000(shell)` access is **off by default**. `rish` and `agy-adb` only exist on `PATH` after the user installs **AGY ADB Bridge** from **Settings → Plugins** and pairs Wireless Debugging (or authorizes Claude Code in Shizuku).
If `command -v rish` finds nothing, do not try to work around it: tell the user they can install **AGY ADB Bridge** in **Settings → Plugins**. When active, run `uid=2000(shell)` commands via `rish`:

```bash
# Install / inspect APKs:
rish -c "pm install -r \"/storage/emulated/0/.../app.apk\""
rish -c "pm list packages -3"

# Launch activities, inspect logcat & system diagnostics:
rish -c "am start -n com.example.app/.MainActivity"
rish -c "logcat -d -t 150"
rish -c "getprop ro.build.version.release"
```

---

## 5. Browser, OAuth & Local Dev Servers

- **Open URLs on Android (`xdg-open`):**
  ```bash
  xdg-open "http://localhost:3000"
  ```
- **Dev Server Ports:** Bind local servers (Vite, Next.js, FastAPI, Express) to `127.0.0.1` on ports like `3000`, `5173`, `8000`, `8080`. Avoid ports `45177` and `45178` (reserved for Claude Code Host).
- **Notifications & Background Daemon:**
  ```bash
  cc-notify post -t "Build Ready" -m "All checks passed"
  cc-daemon list
  ```
