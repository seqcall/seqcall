package dev.seqcall.rider

import com.google.gson.JsonObject
import com.intellij.codeInsight.hint.HintManager
import com.intellij.codeInsight.hint.HintUtil
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.ui.popup.JBPopupFactory
import javax.swing.event.HyperlinkEvent

/**
 * FR-33.6 the HTML of the Info at Caret popup, from the stdio host's `describeAt` answer: the lines, the entry points as
 * a list of links (`reach:<index>`, `+n more` → `reach:more`), then *Sequence diagram* (`diagram`) and, on a method's
 * name, *Paths to here* (`paths`). IDE-free so it can be tested without the platform.
 */
object InfoHtml {
    private val MORE = Regex("""^\+\d+ more$""")

    fun escape(text: String): String = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    fun render(answer: JsonObject): String {
        val item = answer.get("item")?.asString ?: "  · "
        val onName = answer.get("onName")?.asBoolean ?: false
        val out = StringBuilder("<b>Seqcall</b><br>")
        var inList = false
        var index = 0
        for (line in answer.getAsJsonArray("lines").map { it.asString }) {
            if (line.startsWith(item)) {
                val text = line.removePrefix(item)
                if (!inList) out.append("<ul style=\"margin-top:2px;margin-bottom:2px\">")
                inList = true
                if (MORE.matches(text)) out.append("<li><a href=\"reach:more\">${escape(text)}</a></li>")
                else out.append("<li><a href=\"reach:${index++}\"><code>${escape(text)}</code></a></li>")
                continue
            }
            if (inList) out.append("</ul>")
            inList = false
            out.append(escape(line)).append("<br>")
        }
        if (inList) out.append("</ul>")
        out.append("<br><a href=\"diagram\">Sequence diagram</a>")
        if (onName) out.append(" · <a href=\"paths\">Paths to here</a>")
        return out.toString()
    }

    /** The identifier around [offset] in [text] (the word under the caret), or null on none. */
    fun wordAt(text: CharSequence, offset: Int): String? {
        val isPart = { c: Char -> c.isLetterOrDigit() || c == '_' || c == '$' }
        var start = offset.coerceIn(0, text.length)
        var end = start
        while (start > 0 && isPart(text[start - 1])) start--
        while (end < text.length && isPart(text[end])) end++
        return if (start < end) text.substring(start, end) else null
    }
}

/** Where the caret is: file, 0-based line and character, the word under it. Saves the document (the analysis reads the disk). */
private data class Caret(val file: String, val line: Int, val character: Int, val word: String?)

private fun caretOf(editor: Editor): Caret? {
    val doc = editor.document
    val file = FileDocumentManager.getInstance().getFile(doc) ?: return null
    FileDocumentManager.getInstance().saveDocument(doc)
    val offset = editor.caretModel.offset
    val line = doc.getLineNumber(offset)
    return Caret(file.path, line, offset - doc.getLineStartOffset(line), InfoHtml.wordAt(doc.charsSequence, offset))
}

/**
 * FR-33.6 "Seqcall: Info at Caret" (editor context menu): what Seqcall knows about the call or method name at the
 * caret, in a popup there — which implementation runs, the entry points that reach it (each opens its flow, FR-33.7).
 */
class InfoAtCaretAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        e.presentation.isEnabledAndVisible = e.project != null && e.getData(CommonDataKeys.EDITOR) != null &&
            file != null && SeqcallProjectService.isAnalysed(file.path) && !file.path.endsWith(".json")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val caret = caretOf(editor) ?: return
        val service = SeqcallProjectService.get(project)
        service.describeAt(caret.file, caret.line, caret.character, caret.word) { answer ->
            ApplicationManager.getApplication().invokeLater {
                if (editor.isDisposed) return@invokeLater
                if (answer == null) return@invokeLater HintManager.getInstance().showInformationHint(editor, "Seqcall: nothing to say about this")
                val routes = answer.getAsJsonArray("routes")?.map { it.asString } ?: emptyList()
                var popup: com.intellij.openapi.ui.popup.JBPopup? = null
                val label = HintUtil.createInformationLabel(InfoHtml.render(answer), { ev ->
                    if (ev.eventType != HyperlinkEvent.EventType.ACTIVATED) return@createInformationLabel
                    popup?.cancel()
                    when (val target = ev.description) {
                        "diagram" -> service.openAt(caret.file, caret.line, caret.character)
                        "paths" -> service.openReach(caret.file, caret.line, caret.character, caret.word, null)
                        "reach:more" -> chooseRoute(editor, routes) { index -> service.openReach(caret.file, caret.line, caret.character, caret.word, index) }
                        else -> target.removePrefix("reach:").toIntOrNull()?.let { service.openReach(caret.file, caret.line, caret.character, caret.word, it) }
                    }
                }, null, null)
                // a popup at the caret, as Rider's quick documentation: closed by Esc, a click outside or a caret move
                val shown = JBPopupFactory.getInstance().createComponentPopupBuilder(label, null)
                    .setRequestFocus(false)
                    .setCancelOnClickOutside(true)
                    .setCancelKeyEnabled(true)
                    .setMovable(false)
                    .setResizable(false)
                    .createPopup()
                popup = shown
                editor.caretModel.addCaretListener(object : com.intellij.openapi.editor.event.CaretListener {
                    override fun caretPositionChanged(event: com.intellij.openapi.editor.event.CaretEvent) = shown.cancel()
                }, shown)
                shown.showInBestPositionFor(editor)
                com.intellij.openapi.diagnostic.logger<InfoAtCaretAction>().info("SEQCALL info at caret: popup with ${answer.getAsJsonArray("lines")?.size() ?: 0} lines, showing=${shown.isVisible}")
            }
        }
    }

    /** `+n more`: every entry point, searchable; the first row opens Paths to here (index null). */
    private fun chooseRoute(editor: Editor, routes: List<String>, open: (Int?) -> Unit) {
        val paths = "Show all in Paths to here"
        JBPopupFactory.getInstance().createPopupChooserBuilder(listOf(paths) + routes)
            .setTitle("Seqcall: open the flow down to here")
            .setNamerForFiltering { it }
            .setItemChosenCallback { chosen -> open(if (chosen == paths) null else routes.indexOf(chosen)) }
            .createPopup()
            .showInBestPositionFor(editor)
    }
}

/** FR-34.4 "Seqcall: Show Memory": Seqcall's own process and each project's C# analysis, with Free Memory. */
class ShowMemoryAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val service = SeqcallProjectService.get(e.project ?: return)
        service.memory { report ->
            if (report == null) return@memory service.notifyInfo("Seqcall memory", "Seqcall is not running: nothing is loaded.")
            val lines = report.getAsJsonArray("lines").joinToString("<br>") { InfoHtml.escape(it.asString) }
            service.notifyInfo(report.get("summary").asString, lines, mapOf("Free Memory" to { freeMemory(service) }))
        }
    }
}

/** FR-34.4 "Seqcall: Free Memory": drops the caches and stops the C# analysis (it loads again with the next diagram). */
class FreeMemoryAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        freeMemory(SeqcallProjectService.get(e.project ?: return))
    }
}

private fun freeMemory(service: SeqcallProjectService) =
    service.freeMemory { done -> service.notifyInfo("Seqcall memory", done ?: "Seqcall is not running: nothing is loaded.") }
