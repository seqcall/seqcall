package dev.seqcall.rider

import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Finds a Node.js ≥ [MIN_MAJOR] for the core sidecar. An IDE started from the desktop often has
 * a different PATH than a shell (nvm is not loaded), so nvm installations are searched as well.
 * Order: explicit setting → env SEQCALL_NODE → PATH → newest nvm installation → common locations.
 */
class NodeLocator(
    private val env: (String) -> String? = System::getenv,
    private val home: String = System.getProperty("user.home"),
    private val versionOf: (String) -> String? = ::runVersion,
) {
    data class Found(val path: String, val version: String)

    class NotFound(message: String) : Exception(message)

    fun candidates(setting: String?): List<String> {
        val list = mutableListOf<String>()
        setting?.takeIf { it.isNotBlank() }?.let(list::add)
        env("SEQCALL_NODE")?.takeIf { it.isNotBlank() }?.let(list::add)
        env("PATH")?.split(File.pathSeparatorChar)?.forEach { dir -> list += File(dir, exe).path }
        val nvm = File(env("NVM_DIR") ?: "$home/.nvm", "versions/node")
        nvm.listFiles()?.filter { it.isDirectory }
            ?.sortedWith(compareByDescending<File> { majorOf(it.name) ?: 0 }.thenByDescending { it.name })
            ?.forEach { list += File(it, "bin/$exe").path }
        list += listOf("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node")
        return list.distinct()
    }

    /** First candidate that exists and is new enough; the error lists what was rejected. */
    fun locate(setting: String?): Found {
        val rejected = mutableListOf<String>()
        for (path in candidates(setting)) {
            if (!File(path).canExecute()) continue
            val version = versionOf(path)
            val major = version?.let(::majorOf)
            if (major != null && major >= MIN_MAJOR) return Found(path, version)
            rejected += "$path (${version ?: "no version"})"
        }
        throw NotFound(
            "Seqcall needs Node.js $MIN_MAJOR or newer. " +
                (if (rejected.isEmpty()) "No node executable found. " else "Too old: ${rejected.joinToString()}. ") +
                "Install it or set the path in Settings | Tools | Seqcall (or env SEQCALL_NODE).",
        )
    }

    companion object {
        const val MIN_MAJOR = 20
        private val exe = if (System.getProperty("os.name").startsWith("Windows")) "node.exe" else "node"

        fun majorOf(version: String): Int? = Regex("""^v?(\d+)""").find(version.trim())?.groupValues?.get(1)?.toIntOrNull()

        private fun runVersion(path: String): String? = try {
            val p = ProcessBuilder(path, "--version").redirectErrorStream(true).start()
            if (!p.waitFor(5, TimeUnit.SECONDS)) {
                p.destroyForcibly()
                null
            } else p.inputStream.bufferedReader().readText().trim().takeIf { p.exitValue() == 0 }
        } catch (_: Exception) {
            null
        }
    }
}
