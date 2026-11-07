package dev.seqcall.rider

import java.io.File

/**
 * HTML page for one view bundle in JCEF. The webview's window bridge (packages/webview/src/bridge.ts)
 * posts through `window.__seqcallHostPost` when a host defines it, so the page defines it — calling the
 * JBCefJSQuery function — *before* the bundle runs (its first message is `ready`). Theme: the IDE's
 * colours as the `--vscode-*` variables the stylesheet reads (with its own light/dark fallbacks).
 */
object HtmlShell {
    data class Theme(val dark: Boolean, val vars: Map<String, String>)

    fun page(webviewDir: File, bundle: String, hostPostJs: String, theme: Theme): String {
        val base = webviewDir.toURI().toString().removeSuffix("/")
        val vars = theme.vars.entries.joinToString("") { (k, v) -> "--vscode-$k:$v;" }
        return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="$base/styles.css">
<style>:root{$vars}</style>
</head>
<body class="${if (theme.dark) "vscode-dark" else "vscode-light"}">
<div id="app"></div>
<script>window.__seqcallHostPost = function (msg) { var request = JSON.stringify(msg); $hostPostJs };</script>
<script src="$base/$bundle"></script>
</body>
</html>"""
    }

    /** `#rrggbb` / `rgba(r, g, b, a)` for CSS. */
    fun css(r: Int, g: Int, b: Int, alpha: Int = 255): String =
        if (alpha == 255) "#%02x%02x%02x".format(r, g, b)
        else "rgba($r, $g, $b, ${"%.2f".format(java.util.Locale.ROOT, alpha / 255.0)})"

    /** JavaScript that delivers a host message to the view (the bundle listens to window `message` events). */
    fun postScript(messageJson: String): String = "window.postMessage($messageJson, '*');"
}
