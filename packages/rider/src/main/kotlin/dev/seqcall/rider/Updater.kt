package dev.seqcall.rider

import com.intellij.ide.BrowserUtil
import com.intellij.ide.plugins.PluginInstaller
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.ide.plugins.loadDescriptorFromArtifact
import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicBoolean

/** FR-30.4 the IDE side of the self-update: schedule, install after restart, notifications. */
object Updater {
    private const val CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000
    private const val STARTUP_DELAY_MS = 15_000L
    private const val LAST_CHECK_KEY = "dev.seqcall.update.lastCheck"
    /** A version installed by an update and not loaded yet (no restart yet): not installed again. */
    private const val INSTALLED_KEY = "dev.seqcall.update.installed"
    private val log = logger<Updater>()
    private val started = AtomicBoolean(false)

    fun mode(): Updates.Mode = when (SeqcallSettings.get().state.autoUpdate) {
        "notify" -> Updates.Mode.NOTIFY
        "off" -> Updates.Mode.OFF
        else -> Updates.Mode.INSTALL
    }

    private fun runningVersion(): String =
        PluginManagerCore.getPlugin(PluginId.getId(SeqcallProjectService.PLUGIN_ID))?.version ?: "0"

    private fun checker(): Updates.Checker {
        val props = PropertiesComponent.getInstance()
        return Updates.Checker(
            http = Updates.javaHttp,
            currentVersion = Updates.effectiveVersion(runningVersion(), props.getValue(INSTALLED_KEY)),
            install = { bytes, release -> installAfterRestart(bytes, release) },
            api = System.getenv("SEQCALL_UPDATE_API") ?: Updates.API,
        )
    }

    private fun installAfterRestart(bytes: ByteArray, release: Updates.Release) {
        val zip = Files.createTempFile("seqcall-rider-${release.version}-", ".zip")
        Files.write(zip, bytes)
        try {
            val descriptor = loadDescriptorFromArtifact(zip, null)
                ?: throw IllegalStateException("${release.assetName} is not a plugin")
            check(descriptor.pluginId.idString == SeqcallProjectService.PLUGIN_ID) { "${release.assetName} is another plugin (${descriptor.pluginId})" }
            val existing = PluginManagerCore.getPlugin(descriptor.pluginId)?.pluginPath
            PluginInstaller.installAfterRestart(descriptor, zip, existing, true)
        } catch (e: Exception) {
            Files.deleteIfExists(zip)
            throw e
        }
        PropertiesComponent.getInstance().setValue(INSTALLED_KEY, release.version)
        log.info("SEQCALL update: ${release.assetName} installs at the next restart")
    }

    private fun notify(project: Project?, text: String, type: NotificationType = NotificationType.INFORMATION, vararg actions: AnAction) {
        val n: Notification = NotificationGroupManager.getInstance().getNotificationGroup("Seqcall").createNotification(text, type)
        actions.forEach { n.addAction(it) }
        n.notify(project)
    }

    private fun restartAction() = NotificationAction.createSimpleExpiring("Restart") { ApplicationManager.getApplication().restart() }

    private fun describe(r: Updates.Result): String = when (r) {
        is Updates.Result.UpToDate -> "Seqcall is up to date (${runningVersion()})."
        is Updates.Result.NoAsset -> "The latest Seqcall release (${r.latest}) has no Rider plugin."
        is Updates.Result.Error -> "Could not check for Seqcall updates: ${r.message}"
        is Updates.Result.Available -> "Seqcall ${r.release.version} is available (you have ${runningVersion()})."
        is Updates.Result.Installed -> "Seqcall ${r.release.version} is installed. Restart the IDE to use it."
    }

    /** Shows what a check found; `quiet`: the automatic check only speaks about a new version. */
    private fun show(project: Project?, r: Updates.Result, quiet: Boolean) {
        log.info("SEQCALL update: ${describe(r)}")
        when (r) {
            is Updates.Result.Installed -> notify(project, describe(r), NotificationType.INFORMATION, restartAction())
            is Updates.Result.Available -> notify(
                project, describe(r), NotificationType.INFORMATION,
                NotificationAction.createSimpleExpiring("Install") { installInBackground(project, r.release) },
                NotificationAction.createSimple("Release Notes") { if (r.release.url.isNotEmpty()) BrowserUtil.browse(r.release.url) },
            )
            is Updates.Result.Error -> if (!quiet) notify(project, describe(r), NotificationType.ERROR)
            else -> if (!quiet) notify(project, describe(r))
        }
    }

    private fun installInBackground(project: Project?, release: Updates.Release) =
        ApplicationManager.getApplication().executeOnPooledThread { show(project, checker().install(release), false) }

    /** FR-30.5 Check for Seqcall Updates: always checks; in notify / off mode it offers the install. */
    fun checkManually(project: Project?) = ApplicationManager.getApplication().executeOnPooledThread {
        PropertiesComponent.getInstance().setValue(LAST_CHECK_KEY, System.currentTimeMillis().toString())
        show(project, checker().check(if (mode() == Updates.Mode.INSTALL) Updates.Mode.INSTALL else Updates.Mode.NOTIFY), false)
    }

    /** FR-30.4 the automatic check: once per IDE session and day, not in the development sandbox. */
    suspend fun checkAutomatically(project: Project) {
        if (!started.compareAndSet(false, true)) return
        val app = ApplicationManager.getApplication()
        if (app.isUnitTestMode || app.isHeadlessEnvironment || System.getProperty("idea.plugin.in.sandbox.mode") == "true") return
        kotlinx.coroutines.delay(STARTUP_DELAY_MS)
        val mode = mode()
        val props = PropertiesComponent.getInstance()
        if (mode == Updates.Mode.OFF || !Updates.due(props.getValue(LAST_CHECK_KEY)?.toLongOrNull(), System.currentTimeMillis(), CHECK_INTERVAL_MS)) return
        props.setValue(LAST_CHECK_KEY, System.currentTimeMillis().toString())
        app.executeOnPooledThread { show(project, checker().check(mode), true) }
    }
}

class UpdateStartup : ProjectActivity {
    override suspend fun execute(project: Project) = Updater.checkAutomatically(project)
}

class CheckForUpdatesAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        Updater.checkManually(e.project)
    }
}
