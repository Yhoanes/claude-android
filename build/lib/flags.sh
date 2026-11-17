#!/usr/bin/env bash
#
# flags.sh - command-line parsing for Claude Code Android build.sh.

parse_args() {
    DEV_MODE=0
    NO_PATCH=0
    DRY_RUN=0
    for arg in "$@"; do
        case "$arg" in
            --dev)      DEV_MODE=1 ;;
            --no-patch) NO_PATCH=1 ;;
            --dry-run)  DRY_RUN=1 ;;
            -h|--help)
                cat <<'EOF'
Usage: bash build.sh [--dev]

Options:
  --dev       Build side-by-side Dev edition (com.cc.dev, Claude Code Dev, port 45178)
  -h, --help  Show this help message
EOF
                exit 0
                ;;
            *) echo "unknown flag: $arg" >&2; exit 2 ;;
        esac
    done
    export DEV_MODE NO_PATCH DRY_RUN
}
