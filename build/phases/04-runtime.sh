#!/usr/bin/env bash
#
# 04-runtime.sh - assemble assets/runtime/{bin,certs,seed,host,bundled-skills}.

log "[2/11] assemble assets/runtime/{bin,certs,seed,host,bundled-skills}"
mkdir -p "$RT/bin" "$RT/certs" "$RT/seed" "$RT/host" "$RT/bundled-skills"

# Native Android bridge & runtime launchers (claude-host, claude, node, opencode-pty, xdg-open, chrome)
for tool in "$TOOLS_SRC_DIR"/*; do
    [ -e "$tool" ] || continue
    cp -f "$tool" "$RT/bin/"
done

# Shizuku rish stays OFF Claude's PATH: the app links runtime/bin/rish only after the
# user enables Shizuku in Settings > System (see ShizukuBridge.syncRishLink).
mkdir -p "$RT/shizuku"
mv -f "$RT/bin/rish" "$RT/bin/rish_shizuku.dex" "$RT/shizuku/"

# Official Anthropic Claude Code Full-Editor Webview + Standalone Host Shim
cp -r "$HOST_SRC_DIR/." "$RT/host/"

# Official Anthropic Bundled Skills (docx, pdf, pdf-reading, pptx, xlsx, frontend-design, draft-design-system)
cp -r "$SKILLS_SRC_DIR/." "$RT/bundled-skills/"

# TLS root certificates + default Android Claude Code workspace instructions & settings
cp -f "$CERTS_DIR"/* "$RT/certs/"
cp -f "$SEED_DIR"/* "$RT/seed/"
chmod 755 "$RT/bin"/* "$RT/shizuku/rish" "$RT/host/claude-serve.cjs" 2>/dev/null || true
