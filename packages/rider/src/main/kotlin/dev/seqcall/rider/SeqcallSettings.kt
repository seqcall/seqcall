package dev.seqcall.rider

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel

/** Application settings: the Node.js executable for the core sidecar (empty = auto-detect), FR-30.4 updates. */
@Service(Service.Level.APP)
@State(name = "SeqcallSettings", storages = [Storage("seqcall.xml")])
class SeqcallSettings : SimplePersistentStateComponent<SeqcallSettings.Options>(Options()) {
    class Options : BaseState() {
        var nodePath by string()
        /** FR-30.4 install / notify / off. */
        var autoUpdate by string("install")
    }

    companion object {
        fun get(): SeqcallSettings = service()
    }
}

class SeqcallConfigurable : BoundConfigurable("Seqcall") {
    override fun createPanel(): DialogPanel = panel {
        val s = SeqcallSettings.get().state
        row("Node.js executable:") {
            textField()
                .columns(40)
                .bindText({ s.nodePath ?: "" }, { s.nodePath = it.trim().ifEmpty { null } })
                .comment("Node ${NodeLocator.MIN_MAJOR}+ runs the analysis. Empty: env SEQCALL_NODE, PATH, then nvm installations.")
        }
        // FR-30.4 / FR-30.5 updates from the GitHub releases
        row("Updates:") {
            comboBox(listOf("install", "notify", "off"))
                .bindItem({ s.autoUpdate ?: "install" }, { s.autoUpdate = it ?: "install" })
                .comment("Checked once a day. install: installs a newer version for the next restart; notify: asks first; off: only Tools | Check for Seqcall Updates.")
        }
    }
}
