#!/usr/bin/env bash
#
# 09b-verify.sh - verify APK cryptographic signature and packaged Claude Code ARM64 payload.

log "[11/11] apksigner verify + payload integrity check"
apksigner verify --verbose "$OUT_APK"

python3 - "$OUT_APK" <<'PY'
import gzip, hashlib, json, sys, zipfile

apk = sys.argv[1]
required = [
    "AndroidManifest.xml",
    "classes.dex",
    "resources.arsc",
    "assets/core-archive/claude-core.tar.gz",
    "assets/runtime/core-archive.sha256",
    "assets/runtime/bin/claude-host",
    "assets/runtime/bin/claude",
    "assets/runtime/bin/node",
    "assets/runtime/bin/cc-pty",
    "assets/runtime/bin/opencode-pty",
    "assets/runtime/shizuku/rish",
    "assets/runtime/shizuku/rish_shizuku.dex",
    "assets/runtime/bin/xdg-open",
    "assets/runtime/host/claude-serve.cjs",
    "assets/runtime/host/vscode-shim.cjs",
    "assets/runtime/host/claude-theme.css",
    "assets/runtime/host/extension.js",
    "assets/runtime/host/webview/index.js",
    "assets/runtime/host/webview/index.css",
    "assets/runtime/bundled-skills/pdf/SKILL.md",
    "assets/runtime/bundled-skills/docx/SKILL.md",
    "assets/runtime/bundled-skills/xlsx/SKILL.md",
    "assets/runtime/bundled-skills/pptx/SKILL.md",
    "assets/runtime/certs/ca-certificates.crt",
    "assets/runtime/seed/CLAUDE.md",
    "assets/runtime/seed/settings.json",
    "assets/runtime/manifest.json",
    "assets/web/__cc_android_boot.js",
    "assets/web/__cc_xterm.js",
    "assets/web/__cc_xterm.css",
    "assets/web/__cc_plugins_catalog.json",
    "assets/web/claude-icon.png",
    "assets/env/bootstrap/bootstrap.tar.gz",
    "assets/env/overlay/bin/cc-box",
    "assets/env/overlay/bin/rg",
    "assets/env/overlay/lib/libpcre2-8.so",
]

with zipfile.ZipFile(apk, "r") as z:
    names = set(z.namelist())
    missing = [r for r in required if r not in names]
    if missing:
        sys.exit("[verify] FAIL missing required APK entries: %r" % missing)

    forbidden = [
        n for n in names
        if n in ("assets/env/bootstrap/bootstrap.tar", "assets/core-archive/claude-core.tar")
    ]
    if forbidden:
        sys.exit("[verify] FAIL unexpected uncompressed tar entries in APK: %r" % forbidden)

    # 1. Verify bootstrap.tar.gz gzip magic & ZIP_STORED
    binfo = z.getinfo("assets/env/bootstrap/bootstrap.tar.gz")
    if binfo.compress_type != zipfile.ZIP_STORED:
        sys.exit("[verify] FAIL bootstrap.tar.gz not ZIP_STORED (compress_type=%d)" % binfo.compress_type)
    bdata = z.read("assets/env/bootstrap/bootstrap.tar.gz")
    if bdata[:2] != b"\x1f\x8b":
        sys.exit("[verify] FAIL bootstrap.tar.gz is not gzip")
    raw_tar = gzip.decompress(bdata)
    print("[verify] bootstrap.tar.gz ok (%d bytes stored -> %d bytes tar)" % (len(bdata), len(raw_tar)))

    # 2. Stream-verify claude-core.tar.gz gzip header, ZIP_STORED, and SHA-256 match
    cinfo = z.getinfo("assets/core-archive/claude-core.tar.gz")
    if cinfo.compress_type != zipfile.ZIP_STORED:
        sys.exit("[verify] FAIL claude-core.tar.gz not ZIP_STORED (compress_type=%d)" % cinfo.compress_type)
    expected_core_sha = z.read("assets/runtime/core-archive.sha256").decode("utf-8").strip()
    h = hashlib.sha256()
    head = b""
    total = 0
    with z.open("assets/core-archive/claude-core.tar.gz") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            if len(head) < 16:
                head += chunk[:16 - len(head)]
            h.update(chunk)
            total += len(chunk)
    if head[:2] != b"\x1f\x8b":
        sys.exit("[verify] FAIL claude-core.tar.gz is not gzip")
    actual_core_sha = h.hexdigest()
    if actual_core_sha != expected_core_sha:
        sys.exit("[verify] FAIL claude-core.tar.gz sha256 mismatch: %s != %s" % (actual_core_sha, expected_core_sha))
    print("[verify] claude-core.tar.gz ok (%.2f MB stored, sha256=%s...)" % (total / (1024 * 1024), actual_core_sha[:16]))

    # 3. Verify opencode-pty native Bionic ARM64 ELF + manifest.json match
    manifest = json.loads(z.read("assets/runtime/manifest.json").decode("utf-8"))
    pty_bytes = z.read("assets/runtime/bin/opencode-pty")
    pty_sha = hashlib.sha256(pty_bytes).hexdigest()
    if pty_bytes[:4] != b"\x7fELF" or pty_bytes[4] != 2 or pty_bytes[18] != 0xb7:
        sys.exit("[verify] FAIL bin/opencode-pty is not ELF64 AArch64")
    if pty_sha != manifest["files"].get("bin/opencode-pty"):
        sys.exit("[verify] FAIL bin/opencode-pty sha256 mismatch in manifest.json")
    print("[verify] runtime/manifest.json ok (%d files verified)" % len(manifest["files"]))
PY

# Clean intermediate build scratch while preserving build/{lib,phases,tools}
rm -rf "$BUILD_DIR/staging" "$BUILD_DIR/gen" "$BUILD_DIR/obj" "$BUILD_DIR/dex" \
       "$BUILD_DIR/apk" "$BUILD_DIR/res" "$BUILD_DIR/AndroidManifest.xml" \
       "$BUILD_DIR/unaligned.apk" "$BUILD_DIR/aligned.apk" \
       "$BUILD_DIR/bootstrap.tar.gz.hold" "$BUILD_DIR/claude-core.tar.gz.hold"

log "BUILD OK -> $OUT_APK"
ls -lh "$OUT_APK"
if [ -n "${OUT_APK_ALIAS:-}" ] && [ -f "$OUT_APK_ALIAS" ] && [ "$OUT_APK_ALIAS" != "$OUT_APK" ]; then
    ls -lh "$OUT_APK_ALIAS"
fi
