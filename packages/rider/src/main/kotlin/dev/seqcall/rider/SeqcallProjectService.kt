package dev.seqcall.rider

import com.google.gson.JsonArray
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.util.DiffUserDataKeys
import com.intellij.diff.util.Side
import com.intellij.openapi.util.Pair
import com.google.gson.JsonObject
import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.content.ContentManagerEvent
import com.intellij.ui.content.ContentManagerListener
import com.intellij.util.concurrency.AppExecutorUtil
import java.io.File
import java.nio.file.Files
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Per-project glue between the IDE, the core sidecar and the two JCEF views. No analysis logic:
 * view intents go to the sidecar unchanged, its `post` notifications go to the views unchanged.
 */
@Service(Service.Level.PROJECT)
class SeqcallProjectService(private val project: Project) : Disposable {
    private val log = logger<SeqcallProjectService>()

    /** All sidecar traffic in order, off the EDT. */
    private val queue = AppExecutorUtil.createBoundedApplicationPoolExecutor("Seqcall sidecar", 1)
    private val pageDir: File = Files.createTempDirectory("seqcall-pages").toFile().apply { deleteOnExit() }

    @Volatile
    private var sidecar: SidecarProcess? = null
    private var toolWindow: ToolWindow? = null

    @Volatile
    private var sequence: DiagramBrowser? = null

    @Volatile
    private var classView: DiagramBrowser? = null
    private var caretJob: ScheduledFuture<*>? = null

    /** Recent traffic (message types) for diagnostics and the smoke check. */
    val trace: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())

    init {
        project.messageBus.connect(this).subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) = filesChanged(events.mapNotNull { it.path.takeIf(::isAnalysed) })
        })
        EditorFactory.getInstance().eventMulticaster.addCaretListener(object : CaretListener {
            override fun caretPositionChanged(event: CaretEvent) = caretMoved(event)
        }, this)
    }

    // ───────────────────────────── Tool window ─────────────────────────────

    /** Called by [SeqcallToolWindowFactory]: the sequence view is the first, permanent tab. */
    fun attach(window: ToolWindow) {
        toolWindow = window
        log.info("SEQCALL attaching views (JCEF)")
        val browser = DiagramBrowser(this, "sequence", webviewDir(), pageDir) { fromView("sequence", it) }
        sequence = browser
        val content = ContentFactory.getInstance().createContent(browser.component, "Sequence", false).apply { isCloseable = false }
        window.contentManager.addContent(content)
        window.contentManager.addContentManagerListener(object : ContentManagerListener {
            override fun contentRemoved(event: ContentManagerEvent) {
                if (event.content.displayName == "Class") {
                    classView?.let { com.intellij.openapi.util.Disposer.dispose(it) }
                    classView = null
                    sendLater { it.notify("viewClosed", JsonObject().apply { addProperty("view", "class") }) }
                }
            }
        })
    }

    private fun showToolWindow(then: () -> Unit = {}) = ApplicationManager.getApplication().invokeLater {
        if (project.isDisposed) return@invokeLater
        val window = ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)
        if (window == null) {
            log.warn("SEQCALL tool window '$TOOL_WINDOW_ID' is not registered")
            return@invokeLater
        }
        log.info("SEQCALL showing tool window (attached=${toolWindow != null})")
        window.show { then() }
    }

    /** FR-12.1: class diagram as a second tab, created on first use. */
    fun showClassDiagram() {
        showToolWindow {
            val window = toolWindow ?: return@showToolWindow
            val manager = window.contentManager
            val existing = manager.findContent("Class")
            if (existing != null) {
                manager.setSelectedContent(existing)
                return@showToolWindow
            }
            val browser = DiagramBrowser(this, "class", webviewDir(), pageDir) { fromView("class", it) }
            classView = browser
            val content = ContentFactory.getInstance().createContent(browser.component, "Class", false).apply { isCloseable = true }
            manager.addContent(content)
            manager.setSelectedContent(content)
        }
    }

    // ───────────────────────────── IDE → sidecar ─────────────────────────────

    /** FR-1.1 / FR-15.4: diagram of the method at the caret. */
    fun openAt(file: String, line: Int, character: Int) {
        showToolWindow {
            toolWindow?.contentManager?.findContent("Sequence")?.let { toolWindow?.contentManager?.setSelectedContent(it) }
        }
        sendLater {
            it.notify("openAt", JsonObject().apply {
                addProperty("file", file)
                add("position", Rpc.position(line, character))
            })
        }
    }

    /**
     * FR-33.6 Info at Caret: the hover's lines for the call or method name at the position; [onResult] gets the
     * stdio host's answer (`{ lines, item, routes, onName }`) or null, off the EDT.
     */
    fun describeAt(file: String, line: Int, character: Int, word: String?, onResult: (JsonObject?) -> Unit) {
        sendLater { process ->
            process.request("describeAt", JsonObject().apply {
                addProperty("file", file)
                add("position", Rpc.position(line, character))
                word?.let { addProperty("word", it) }
            }) { r -> onResult(r.result?.takeIf { it.isJsonObject }?.asJsonObject) }
        }
    }

    /** FR-33.7 entry point [index] of the last Info at Caret opens its flow down to the method; null: its Paths to here. */
    fun openReach(file: String, line: Int, character: Int, word: String?, index: Int?) {
        showToolWindow {
            toolWindow?.contentManager?.findContent("Sequence")?.let { toolWindow?.contentManager?.setSelectedContent(it) }
        }
        sendLater {
            it.notify("openReach", JsonObject().apply {
                addProperty("file", file)
                add("position", Rpc.position(line, character))
                word?.let { w -> addProperty("word", w) }
                index?.let { i -> addProperty("index", i) }
            })
        }
    }

    /** FR-34.4 the memory report (`{ lines, summary }`), or null when Seqcall is not running (nothing to measure). */
    fun memory(onResult: (JsonObject?) -> Unit) {
        if (sidecar?.isAlive != true) return onResult(null)
        sendLater { process -> process.request("memory", JsonObject()) { r -> onResult(r.result?.takeIf { it.isJsonObject }?.asJsonObject) } }
    }

    /** FR-34.4 Free Memory: what it did as a sentence, or null when Seqcall is not running. */
    fun freeMemory(onResult: (String?) -> Unit) {
        if (sidecar?.isAlive != true) return onResult(null)
        sendLater { process -> process.request("freeMemory", JsonObject()) { r -> onResult(r.result?.takeIf { !it.isJsonNull }?.asString) } }
    }

    /** FR-34.4 a balloon in the Seqcall group (actions: title → what a click runs). */
    fun notifyInfo(title: String, content: String, actions: Map<String, () -> Unit> = emptyMap()) {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val n = NotificationGroupManager.getInstance().getNotificationGroup("Seqcall").createNotification(title, content, NotificationType.INFORMATION)
            actions.forEach { (label, run) -> n.addAction(com.intellij.notification.NotificationAction.createSimpleExpiring(label) { run() }) }
            n.notify(project)
        }
    }

    private fun filesChanged(files: List<String>) {
        if (files.isEmpty() || sidecar == null) return
        sendLater { it.notify("filesChanged", JsonObject().apply { add("files", JsonArray().apply { files.forEach(::add) }) }) }
    }

    /** FR-2.4 highlight of the call at the caret (debounced). */
    private fun caretMoved(event: CaretEvent) {
        if (sidecar == null || event.editor.project != project) return
        val file = FileDocumentManager.getInstance().getFile(event.editor.document)?.path ?: return
        if (!isAnalysed(file)) return
        val doc = event.editor.document
        val offset = event.caret.offset
        val line = doc.getLineNumber(offset)
        val character = offset - doc.getLineStartOffset(line)
        caretJob?.cancel(false)
        caretJob = AppExecutorUtil.getAppScheduledExecutorService().schedule({
            sendLater {
                it.notify("caretMoved", JsonObject().apply {
                    addProperty("file", file)
                    add("position", Rpc.position(line, character))
                })
            }
        }, 150, TimeUnit.MILLISECONDS)
    }

    private fun fromView(view: String, json: String) {
        trace += "$view→host ${typeOf(json)}"
        sendLater { it.send(Rpc.viewMessage(view, json)) }
    }

    private fun sendLater(action: (SidecarProcess) -> Unit) {
        queue.execute {
            val process = try {
                ensureSidecar()
            } catch (e: Exception) {
                error(e.message ?: e.toString())
                return@execute
            }
            action(process)
        }
    }

    // ───────────────────────────── Sidecar → IDE ─────────────────────────────

    private fun onSidecar(msg: Rpc.Incoming) {
        when (msg) {
            is Rpc.Incoming.Post -> {
                trace += "host→${msg.view} ${msg.message.asJsonObject.get("type")?.asString}"
                (if (msg.view == "class") classView else sequence)?.post(msg.message.toString())
            }
            is Rpc.Incoming.Navigate -> ApplicationManager.getApplication().invokeLater { navigate(msg.file, msg.line, msg.character) }
            is Rpc.Incoming.OpenDiff -> ApplicationManager.getApplication().invokeLater { openDiff(msg) }
            is Rpc.Incoming.ShowClassDiagram -> showClassDiagram()
            is Rpc.Incoming.Log -> if (msg.level == "error") log.warn("SEQCALL ${msg.message}") else log.info("SEQCALL ${msg.message}")
            is Rpc.Incoming.Progress -> ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) StatusBar.Info.set(msg.title?.let { "Seqcall: $it" } ?: "", project)
            }
            is Rpc.Incoming.Response -> if (msg.error != null) log.warn("SEQCALL request ${msg.id}: ${msg.error}")
            is Rpc.Incoming.Unknown -> log.info("SEQCALL unexpected sidecar output: ${msg.line.take(200)}")
        }
    }

    private fun navigate(path: String, line: Int, character: Int) {
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(path) ?: return error("Cannot open $path")
        val doc = FileDocumentManager.getInstance().getDocument(vf)
        val offset = if (doc != null && line < doc.lineCount) {
            (doc.getLineStartOffset(line) + character).coerceAtMost(doc.getLineEndOffset(line))
        } else 0
        OpenFileDescriptor(project, vf, offset).navigate(true)
    }

    /** FR-24.7 the platform diff viewer: the file's merge-base content (read-only) against the file now, at the call. */
    private fun openDiff(msg: Rpc.Incoming.OpenDiff) {
        if (project.isDisposed) return
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(msg.file) ?: return error("Cannot open ${msg.file}")
        val factory = DiffContentFactory.getInstance()
        val request = SimpleDiffRequest(msg.title, factory.create(project, msg.baseText, vf.fileType), factory.create(project, vf), "Base", "Now")
        request.putUserData(DiffUserDataKeys.SCROLL_TO_LINE, Pair.create(Side.RIGHT, msg.line))
        DiffManager.getInstance().showDiff(project, request)
    }

    private fun error(message: String) {
        log.warn("SEQCALL $message")
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            NotificationGroupManager.getInstance().getNotificationGroup("Seqcall")
                .createNotification(message, NotificationType.ERROR).notify(project)
        }
    }

    // ───────────────────────────── Sidecar lifecycle ─────────────────────────────

    @Synchronized
    private fun ensureSidecar(): SidecarProcess {
        sidecar?.takeIf { it.isAlive }?.let { return it }
        val dir = pluginDir()
        val bundle = File(dir, "node/stdio-host.cjs")
        if (!bundle.isFile) throw IllegalStateException("Seqcall: sidecar bundle missing at $bundle (build with `npm run build:rider`).")
        val node = NodeLocator().locate(SeqcallSettings.get().state.nodePath)
        val command = mutableListOf(node.path, bundle.path)
        project.basePath?.let { command += listOf("--workspace", it) }
        File(dir, "csharp/Seqcall.CSharp.dll").takeIf { it.isFile }?.let { command += listOf("--csharp-sidecar", it.path) }
        log.info("SEQCALL starting sidecar: node ${node.version} ${command.joinToString(" ")}")
        val process = SidecarProcess(
            command,
            File(project.basePath ?: dir.path),
            dotnetEnv(),
            onMessage = ::onSidecar,
            onStderr = { log.info("SEQCALL sidecar: $it") },
            onExit = { code -> if (code != 0) error("Seqcall: the analysis process exited ($code); see idea.log.") },
        )
        process.request("initialize")
        sidecar = process
        return process
    }

    /** An IDE started from the desktop may not have `dotnet` on its PATH (user-local SDKs in ~/.dotnet). */
    private fun dotnetEnv(): Map<String, String> {
        if (System.getenv("SEQCALL_DOTNET") != null || PathEnvironmentVariableUtil.findInPath("dotnet") != null) return emptyMap()
        val local = File(System.getProperty("user.home"), ".dotnet/dotnet").takeIf { it.canExecute() } ?: return emptyMap()
        return mapOf("SEQCALL_DOTNET" to local.path, "DOTNET_ROOT" to local.parent)
    }

    override fun dispose() {
        caretJob?.cancel(false)
        val process = sidecar
        sidecar = null
        queue.shutdown()
        if (process != null) AppExecutorUtil.getAppExecutorService().execute { process.stop() }
        pageDir.deleteRecursively()
    }

    private fun typeOf(json: String): String? = try {
        com.google.gson.JsonParser.parseString(json).asJsonObject.get("type")?.asString
    } catch (_: Exception) {
        null
    }

    companion object {
        const val TOOL_WINDOW_ID = "Seqcall"
        const val PLUGIN_ID = "dev.seqcall"

        fun get(project: Project): SeqcallProjectService = project.service()

        fun pluginDir(): File =
            PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.pluginPath?.toFile()
                ?: throw IllegalStateException("Seqcall plugin directory not found")

        fun webviewDir(): File = File(pluginDir(), "webview")

        private val ANALYSED = Regex("""\.(?:[cm]?[jt]sx?|cs|php)$""", RegexOption.IGNORE_CASE)

        fun isAnalysed(path: String): Boolean =
            path.endsWith("/.seqcall.json") ||
                (ANALYSED.containsMatchIn(path) && !Regex("""/(?:node_modules|bin|obj|vendor)/""").containsMatchIn(path) && !Regex("""\.d\.[cm]?ts$""").containsMatchIn(path))
    }
}
