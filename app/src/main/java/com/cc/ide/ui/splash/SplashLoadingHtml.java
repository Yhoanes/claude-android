package com.cc.ide.ui.splash;

import android.webkit.WebView;

/**
 * Renders the Claude Code warm terracotta starburst + subtle three-dot loader
 * while CoreInstaller / Claude Host starts up.
 */
public final class SplashLoadingHtml {

    private static final String CLAUDE_STARBURST_SVG =
            "<svg viewBox=\"0 0 24 24\" width=\"42\" height=\"42\" xmlns=\"http://www.w3.org/2000/svg\">"
            + "<path fill=\"#D97757\" d=\"M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z\"/>"
            + "</svg>";

    private SplashLoadingHtml() {
    }

    public static String getLoadingHtml(String foregroundColor, String backgroundColor) {
        return "<!DOCTYPE html>\n"
                + "<html>\n"
                + "<head>\n"
                + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n"
                + "<style>\n"
                + "  :root { --bg: " + backgroundColor + "; --fg: " + foregroundColor + "; }\n"
                + "  html, body {\n"
                + "    margin: 0; padding: 0; height: 100%; width: 100%;\n"
                + "    background: var(--bg); color: var(--fg);\n"
                + "    display: flex; flex-direction: column; gap: 18px;\n"
                + "    align-items: center; justify-content: center;\n"
                + "    overflow: hidden; -webkit-user-select: none;\n"
                + "  }\n"
                + "  @keyframes claude-pulse {\n"
                + "    0%, 100% { transform: scale(1) rotate(0deg); opacity: 0.92; }\n"
                + "    50% { transform: scale(1.06) rotate(12deg); opacity: 1; }\n"
                + "  }\n"
                + "  .claude-mark { animation: claude-pulse 2.8s ease-in-out infinite; }\n"
                + "  @keyframes dot-bounce {\n"
                + "    0%, 100% { transform: translateY(0); }\n"
                + "    20% { transform: translateY(-3px); }\n"
                + "    40% { transform: translateY(0); }\n"
                + "  }\n"
                + "  .animate-dot-bounce {\n"
                + "    display: inline-block; width: 4px; height: 4px; border-radius: 50%;\n"
                + "    background-color: #D97757;\n"
                + "    animation: dot-bounce 1.5s ease-in-out infinite;\n"
                + "  }\n"
                + "</style>\n"
                + "</head>\n"
                + "<body>\n"
                + "  <div class=\"claude-mark\">" + CLAUDE_STARBURST_SVG + "</div>\n"
                + "  <span style=\"display:inline-flex;align-items:center;gap:4px;height:16px;padding:0 4px;opacity:0.75;\" aria-label=\"Loading\">\n"
                + "    <span class=\"animate-dot-bounce\" style=\"animation-delay:0ms;\"></span>\n"
                + "    <span class=\"animate-dot-bounce\" style=\"animation-delay:140ms;\"></span>\n"
                + "    <span class=\"animate-dot-bounce\" style=\"animation-delay:280ms;\"></span>\n"
                + "  </span>\n"
                + "</body>\n"
                + "</html>\n";
    }

    public static void load(WebView splashView, String foregroundColor, String backgroundColor) {
        if (splashView == null) {
            return;
        }
        splashView.loadDataWithBaseURL(null, getLoadingHtml(foregroundColor, backgroundColor),
                "text/html", "utf-8", null);
    }
}
