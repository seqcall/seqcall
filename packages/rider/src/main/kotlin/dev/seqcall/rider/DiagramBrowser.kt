package dev.seqcall.rider

import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import java.io.File
import javax.swing.JComponent

/**
 * One webview bundle (`sequence` or `class`) in a JCEF browser. View → host: the page's
 * `__seqcallHostPost` calls a JBCefJSQuery ([onMessage] gets the JSON). Host → view: [post] runs
 * `window.postMessage(…)`. Messages before the view's `ready` are dropped — the sidecar answers
 * `ready` with the current state anyway.
 */
class DiagramBrowser(
    parent: Disposable,
    val view: String,
    webviewDir: File,
    pageDir: File,
    private val onMessage: (String) -> Unit,
) : Disposable {
    private val browser = JBCefBrowser.createBuilder().build()
    private val query = JBCefJSQuery.create(browser as JBCefBrowserBase)

    @Volatile
    var isReady = false
        private set

    val component: JComponent get() = browser.component

    init {
        Disposer.register(parent, this)
        Disposer.register(this, browser)
        Disposer.register(this, query)
        query.addHandler { request ->
            if (typeOf(request) == "ready") isReady = true
            onMessage(request)
            null
        }
        load(webviewDir, pageDir)
    }

    private fun load(webviewDir: File, pageDir: File) {
        isReady = false
        val html = HtmlShell.page(webviewDir, "$view.js", query.inject("request"), IdeTheme.current())
        val page = File(pageDir, "$view.html").apply { writeText(html) }
        browser.loadURL(page.toURI().toString())
    }

    fun post(messageJson: String) {
        if (!isReady) return
        val cef = browser.cefBrowser
        cef.executeJavaScript(HtmlShell.postScript(messageJson), cef.url, 0)
    }

    fun openDevTools() = browser.openDevtools()

    override fun dispose() {}

    private fun typeOf(json: String): String? = try {
        JsonParser.parseString(json).asJsonObject.get("type")?.asString
    } catch (_: Exception) {
        null
    }
}
