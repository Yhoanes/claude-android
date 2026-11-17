#!/usr/bin/env bash
#
# build.sh - Claude Code for Android (v2.1.325-r1) Gradle-free APK build orchestrator.
#
# Pipeline:
#   00-dev          -> generate BuildConfig.java + res/values/gen.xml + manifest version sync
#   01-stage-core   -> stage & verify core/claude-core.tar.gz (Claude v2.1.325 + glibc + Node)
#   04-runtime      -> assemble assets/runtime/{bin,certs,seed,host,bundled-skills}
#   04c-rt-manifest -> compute SHA-256 integrity manifest (assets/runtime/manifest.json)
#   05-web-bus      -> stage assets/web (__cc_android_boot.js, MCP catalog, claude-icon.png)
#   05b-env         -> stage assets/env/{pkg,overlay,bootstrap} (cc-box, rg, Bionic userspace)
#   06-rjava        -> aapt R.java generation (minSdk 28 / targetSdk 28)
#   07-javac        -> compile Java sources + generated sources (UTF-8)
#   07b-d8          -> dex bytecode compilation via R8/D8
#   08-package      -> package resources + assets + classes.dex + stored .tar.gz archives
#   09-sign         -> zipalign (4-byte page-safe) + apksigner v2/v3 signing
#   09b-verify      -> apksigner verify + ELF/gzip/SHA-256 payload integrity verification
#
# Flags:
#   --dev           -> build side-by-side Dev edition (com.cc.dev, Claude Code Dev, port 45178)
#   --help          -> print usage
#
set -euo pipefail

export LANG=C.UTF-8
export LC_ALL=C.UTF-8

# Ensure on-device Bionic userspace tools ($PREFIX/bin) are in PATH when building inside Android.
for _p in \
    "/data/user/0/com.agy/files/usr/bin" \
    "/data/user/0/com.cc.ide/files/usr/bin" \
    "/data/user/0/com.oc.ide/files/usr/bin"; do
    if [ -d "$_p" ]; then
        export PATH="$_p:$PATH"
        break
    fi
done
unset _p

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROJECT

. "$PROJECT/build/lib/log.sh"

. "$PROJECT/build/lib/flags.sh"
parse_args "$@"

. "$PROJECT/build/lib/paths.sh"
setup_paths

. "$PROJECT/build/lib/prereqs.sh"
check_tools

clean_build

shopt -s nullglob
for p in "$BUILD_LIB_DIR"/../phases/*.sh; do
    . "$p"
done
shopt -u nullglob
