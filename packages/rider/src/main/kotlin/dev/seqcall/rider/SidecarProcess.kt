package dev.seqcall.rider

import java.io.BufferedWriter
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The core sidecar process (`node stdio-host.cjs`): one JSON object per line on stdin/stdout,
 * stderr is diagnostics. IDE-free so it can be tested without the platform.
 */
class SidecarProcess(
    command: List<String>,
    workDir: File,
    env: Map<String, String> = emptyMap(),
    private val onMessage: (Rpc.Incoming) -> Unit,
    private val onStderr: (String) -> Unit = {},
    private val onExit: (Int) -> Unit = {},
) {
    private val process: Process = ProcessBuilder(command).directory(workDir).also { it.environment().putAll(env) }.start()
    private val stdin: BufferedWriter = process.outputStream.bufferedWriter(Charsets.UTF_8)
    private var nextId = 1
    private val callbacks = java.util.concurrent.ConcurrentHashMap<Int, (Rpc.Incoming.Response) -> Unit>()

    init {
        thread(name = "seqcall-sidecar-stdout", isDaemon = true) {
            process.inputStream.bufferedReader(Charsets.UTF_8).forEachLine { line ->
                if (line.isNotBlank()) {
                    try {
                        val msg = Rpc.parse(line)
                        // FR-33.6 a request with a callback gets its answer there; anything else goes to onMessage
                        val callback = (msg as? Rpc.Incoming.Response)?.let { callbacks.remove(it.id) }
                        if (callback != null) callback(msg as Rpc.Incoming.Response) else onMessage(msg)
                    } catch (e: Exception) {
                        onStderr("cannot handle sidecar message: ${e.message}")
                    }
                }
            }
            onExit(process.waitFor())
        }
        thread(name = "seqcall-sidecar-stderr", isDaemon = true) {
            process.errorStream.bufferedReader(Charsets.UTF_8).forEachLine(onStderr)
        }
    }

    val isAlive: Boolean get() = process.isAlive

    @Synchronized
    fun send(line: String) {
        if (!process.isAlive) return
        stdin.write(line)
        stdin.write("\n")
        stdin.flush()
    }

    fun notify(method: String, params: com.google.gson.JsonObject = com.google.gson.JsonObject()) = send(Rpc.notification(method, params))

    /** Sends a request; the response arrives as [Rpc.Incoming.Response] with the returned id. */
    @Synchronized
    fun request(method: String, params: com.google.gson.JsonObject = com.google.gson.JsonObject()): Int {
        val id = nextId++
        send(Rpc.request(id, method, params))
        return id
    }

    /** Sends a request whose response goes to [onResponse] (registered before it is sent, so it cannot be missed). */
    @Synchronized
    fun request(method: String, params: com.google.gson.JsonObject, onResponse: (Rpc.Incoming.Response) -> Unit): Int {
        val id = nextId++
        callbacks[id] = onResponse
        send(Rpc.request(id, method, params))
        return id
    }

    /** Asks the sidecar to shut down (it disposes the C# sidecar too), then kills it if needed. */
    fun stop(timeoutMs: Long = 3000) {
        try {
            request("shutdown")
            stdin.close()
        } catch (_: Exception) {
        }
        if (!process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) process.destroyForcibly()
    }
}
