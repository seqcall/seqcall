package dev.seqcall.rider

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory

/** FR-15.4 "Show Sequence Diagram" at the caret (editor context menu, Ctrl+Alt+Shift+K). */
class ShowSequenceDiagramAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        e.presentation.isEnabledAndVisible = e.project != null && e.getData(CommonDataKeys.EDITOR) != null &&
            file != null && SeqcallProjectService.isAnalysed(file.path) && !file.path.endsWith(".json")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val doc = editor.document
        val file = FileDocumentManager.getInstance().getFile(doc) ?: return
        // The analysis reads files from disk.
        FileDocumentManager.getInstance().saveDocument(doc)
        val offset = editor.caretModel.offset
        val line = doc.getLineNumber(offset)
        SeqcallProjectService.get(project).openAt(file.path, line, offset - doc.getLineStartOffset(line))
    }
}

class ShowClassDiagramAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        SeqcallProjectService.get(e.project ?: return).showClassDiagram()
    }
}

class SeqcallToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        if (!JBCefApp.isSupported()) {
            val label = JBLabel("Seqcall needs the embedded browser (JCEF), which is not available in this IDE runtime.")
            toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(label, "", false))
            return
        }
        SeqcallProjectService.get(project).attach(toolWindow)
    }
}

/**
 * Headless smoke check (development): with env `SEQCALL_SMOKE_OPEN=<absolute file>:<1-based line>[:<column>]`
 * the diagram opens `SEQCALL_SMOKE_DELAY` seconds (default 3) after startup; `SEQCALL_SMOKE_CLASS=1` also opens the class diagram.
 * The traffic is logged to idea.log ("SEQCALL smoke trace"). `SEQCALL_SMOKE_UPDATE=1` runs Check for Seqcall Updates
 * (FR-30.4; with SEQCALL_UPDATE_API against a fake GitHub).
 */
class SmokeStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        if (System.getenv("SEQCALL_SMOKE_UPDATE") == "1") Updater.checkManually(project)
        System.getenv("SEQCALL_SMOKE_INFO")?.let { smokeInfo(project, it) }
        val spec = System.getenv("SEQCALL_SMOKE_OPEN") ?: return
        val parts = spec.split(':')
        val file = parts[0]
        val line = (parts.getOrNull(1)?.toIntOrNull() ?: 1) - 1
        val column = parts.getOrNull(2)?.toIntOrNull() ?: 4
        val service = SeqcallProjectService.get(project)
        kotlinx.coroutines.delay((System.getenv("SEQCALL_SMOKE_DELAY")?.toLongOrNull() ?: 3) * 1000)
        service.openAt(file, line, column)
        if (System.getenv("SEQCALL_SMOKE_CLASS") == "1") {
            kotlinx.coroutines.delay(8000)
            service.showClassDiagram()
        }
        repeat(6) {
            kotlinx.coroutines.delay(5000)
            com.intellij.openapi.diagnostic.logger<SmokeStartup>().info("SEQCALL smoke trace: ${service.trace.toList()}")
        }
    }
}

/**
 * FR-33.6 / FR-34.4 smoke check (development): with env `SEQCALL_SMOKE_INFO=<absolute file>:<1-based line>:<column>` the
 * file opens in an editor with the caret there, *Seqcall: Info at Caret* runs through the action system, and the log
 * says whether its popup shows and what the sidecar answered; then entry point 0 opens and Show / Free Memory answer.
 * Lines "SEQCALL smoke info …" in idea.log.
 */
private suspend fun smokeInfo(project: Project, spec: String) {
    val log = com.intellij.openapi.diagnostic.logger<SmokeStartup>()
    val parts = spec.split(':')
    val path = parts[0]
    val line = (parts.getOrNull(1)?.toIntOrNull() ?: 1) - 1
    val column = parts.getOrNull(2)?.toIntOrNull() ?: 0
    kotlinx.coroutines.delay((System.getenv("SEQCALL_SMOKE_DELAY")?.toLongOrNull() ?: 3) * 1000)
    val app = com.intellij.openapi.application.ApplicationManager.getApplication()
    app.invokeAndWait({
        val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByPath(path) ?: return@invokeAndWait log.warn("SEQCALL smoke info: no file $path")
        val editor = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
            .openTextEditor(com.intellij.openapi.fileEditor.OpenFileDescriptor(project, vf, line, column), true) ?: return@invokeAndWait log.warn("SEQCALL smoke info: no editor")
        val action = com.intellij.openapi.actionSystem.ActionManager.getInstance().getAction("Seqcall.InfoAtCaret")
        log.info("SEQCALL smoke info: action registered=${action != null}, in the editor menu=${action?.templatePresentation?.text}")
        com.intellij.openapi.actionSystem.ActionManager.getInstance().tryToExecute(action, null, editor.contentComponent, "smoke", true)
    }, com.intellij.openapi.application.ModalityState.any())
    val service = SeqcallProjectService.get(project)
    val text = java.io.File(path).readLines().getOrElse(line) { "" }
    val word = InfoHtml.wordAt(text, column)
    val answer = kotlinx.coroutines.CompletableDeferred<com.google.gson.JsonObject?>()
    service.describeAt(path, line, column, word) { answer.complete(it) }
    val info = kotlinx.coroutines.withTimeoutOrNull(120_000) { answer.await() }
    log.info("SEQCALL smoke info answer (word $word): $info")
    kotlinx.coroutines.delay(2000)
    // any modality: the sandbox may show its own modal dialog (an evaluation feedback form) meanwhile
    app.invokeAndWait({
        val modal = com.intellij.openapi.application.ModalityState.current() != com.intellij.openapi.application.ModalityState.nonModal()
        // (the action logs whether its popup shows: "SEQCALL info at caret: … showing=…")
        log.info("SEQCALL smoke info: a modal dialog open=$modal")
    }, com.intellij.openapi.application.ModalityState.any())
    if ((info?.getAsJsonArray("routes")?.size() ?: 0) > 0) {
        service.openReach(path, line, column, word, 0)
        log.info("SEQCALL smoke info: entry point 0 asked")
    }
    kotlinx.coroutines.delay(5000)
    val memory = kotlinx.coroutines.CompletableDeferred<com.google.gson.JsonObject?>()
    service.memory { memory.complete(it) }
    log.info("SEQCALL smoke info memory: ${kotlinx.coroutines.withTimeoutOrNull(30_000) { memory.await() }}")
    val freed = kotlinx.coroutines.CompletableDeferred<String?>()
    service.freeMemory { freed.complete(it) }
    log.info("SEQCALL smoke info free: ${kotlinx.coroutines.withTimeoutOrNull(30_000) { freed.await() }}")
    log.info("SEQCALL smoke trace: ${service.trace.toList()}")
}
