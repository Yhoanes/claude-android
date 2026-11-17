#!/usr/bin/env bash
#
# 01-stage-core.sh - stage & verify Claude Code ARM64 core archive (claude-core.tar.gz).

log "[1/11] stage & verify Claude Code ARM64 core archive"

if [ ! -f "$CORE_ARCHIVE_SRC" ]; then
    shopt -s nullglob
    CORE_PARTS=( "${CORE_ARCHIVE_SRC}".part-* )
    shopt -u nullglob
    [ "${#CORE_PARTS[@]}" -gt 0 ] \
        || die "core archive missing: $CORE_ARCHIVE_SRC (and no .part-* chunks found)"
    log "  reassembling $(basename "$CORE_ARCHIVE_SRC") from ${#CORE_PARTS[@]} repository chunks..."
    cat "${CORE_PARTS[@]}" > "${CORE_ARCHIVE_SRC}.tmp"
    mv -f "${CORE_ARCHIVE_SRC}.tmp" "$CORE_ARCHIVE_SRC"
fi

if [ -f "${CORE_ARCHIVE_SRC}.sha256" ]; then
    EXPECTED_CORE_SHA="$(awk '{print $1}' "${CORE_ARCHIVE_SRC}.sha256")"
    ACTUAL_CORE_SHA="$(sha256sum "$CORE_ARCHIVE_SRC" | awk '{print $1}')"
    [ "$EXPECTED_CORE_SHA" = "$ACTUAL_CORE_SHA" ] \
        || die "core archive SHA-256 mismatch: expected $EXPECTED_CORE_SHA, got $ACTUAL_CORE_SHA"
fi

file -b "$CORE_ARCHIVE_SRC" | grep -q '^gzip compressed' \
    || die "core archive is not gzip compressed: $CORE_ARCHIVE_SRC"

mkdir -p "$(dirname "$STAGED_CORE_ARCHIVE")" "$RT"

if [ "$DEV_MODE" -eq 1 ] && [ "${#PKG}" -eq "${#PKG_DEV}" ]; then
    log "  --dev: rewriting 10-byte prefix $PKG -> $PKG_DEV inside staged claude-core.tar.gz"
    python3 - "$CORE_ARCHIVE_SRC" "$STAGED_CORE_ARCHIVE" "$PKG" "$PKG_DEV" <<'PY'
import gzip, io, shutil, sys, tarfile

src_tgz, dst_tgz, src_pkg, dst_pkg = sys.argv[1], sys.argv[2], sys.argv[3].encode(), sys.argv[4].encode()
assert len(src_pkg) == len(dst_pkg)

with tarfile.open(src_tgz, "r:gz") as tin, gzip.GzipFile(dst_tgz, "wb", compresslevel=6, mtime=0) as gz:
    with tarfile.open(mode="w", fileobj=gz) as tout:
        for m in tin.getmembers():
            if m.isfile():
                fobj = tin.extractfile(m)
                # Stream large claude.elf directly without loading 364 MB into RAM
                if m.name.endswith("claude.elf"):
                    tout.addfile(m, fobj)
                else:
                    raw = fobj.read()
                    if src_pkg in raw:
                        raw = raw.replace(src_pkg, dst_pkg)
                    m.size = len(raw)
                    tout.addfile(m, io.BytesIO(raw))
            else:
                tout.addfile(m)
PY
else
    cp -f "$CORE_ARCHIVE_SRC" "$STAGED_CORE_ARCHIVE"
fi

gzip -t "$STAGED_CORE_ARCHIVE" || die "staged claude-core.tar.gz failed gzip integrity test"
CORE_SHA256="$(sha256sum "$STAGED_CORE_ARCHIVE" | awk '{print $1}')"
printf '%s\n' "$CORE_SHA256" > "$RT/core-archive.sha256"
log "  staged claude-core.tar.gz ok (sha256=${CORE_SHA256:0:16}...)"
