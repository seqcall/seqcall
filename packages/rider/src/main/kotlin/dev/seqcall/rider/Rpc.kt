package dev.seqcall.rider

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Newline-delimited JSON-RPC 2.0 framing of the core sidecar (packages/stdio-host, protocol in
 * docs/RIDER-PLUGIN.md). The plugin sends notifications only (fire and forget, processed in order)
 * and receives notifications: `post`, `navigate`, `showClassDiagram`, `log`, `progress`.
 */
object Rpc {
    fun notification(method: String, params: JsonObject = JsonObject()): String =
        JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("method", method)
            add("params", params)
        }.toString()

    fun request(id: Int, method: String, params: JsonObject = JsonObject()): String =
        JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("id", id)
            addProperty("method", method)
            add("params", params)
        }.toString()

    fun position(line: Int, character: Int): JsonObject =
        JsonObject().apply {
            addProperty("line", line)
            addProperty("character", character)
        }

    /** A message posted by a view (`JSON.stringify` output) wrapped for the sidecar. */
    fun viewMessage(view: String, messageJson: String): String =
        notification("view", JsonObject().apply {
            addProperty("view", view)
            add("message", JsonParser.parseString(messageJson))
        })

    sealed interface Incoming {
        data class Post(val view: String, val message: JsonElement) : Incoming
        data class Navigate(val file: String, val line: Int, val character: Int) : Incoming
        /** FR-24.7 a reviewed call's file side by side: merge-base content ↔ the file now, at the 0-based line. */
        data class OpenDiff(val file: String, val line: Int, val baseText: String, val title: String) : Incoming
        data object ShowClassDiagram : Incoming
        data class Log(val level: String, val message: String) : Incoming
        data class Progress(val title: String?) : Incoming
        data class Response(val id: Int, val result: JsonElement?, val error: String?) : Incoming
        data class Unknown(val line: String) : Incoming
    }

    fun parse(line: String): Incoming {
        val obj = try {
            JsonParser.parseString(line).asJsonObject
        } catch (_: Exception) {
            return Incoming.Unknown(line)
        }
        val params = obj.get("params")?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
        val str = { o: JsonObject, k: String -> o.get(k)?.takeIf { !it.isJsonNull }?.asString }
        return when (obj.get("method")?.asString) {
            "post" -> Incoming.Post(str(params, "view") ?: "sequence", params.get("message"))
            "navigate" -> {
                val range = params.getAsJsonObject("range")
                val start = range.getAsJsonObject("start")
                Incoming.Navigate(range.get("file").asString, start.get("line").asInt, start.get("character").asInt)
            }
            "openDiff" -> Incoming.OpenDiff(str(params, "file") ?: "", params.get("line")?.asInt ?: 0, str(params, "baseText") ?: "", str(params, "title") ?: "Diff")
            "showClassDiagram" -> Incoming.ShowClassDiagram
            "log" -> Incoming.Log(str(params, "level") ?: "info", str(params, "message") ?: "")
            "progress" -> Incoming.Progress(str(params, "title"))
            null -> if (obj.has("id") && !obj.get("id").isJsonNull) {
                Incoming.Response(
                    obj.get("id").asInt,
                    obj.get("result"),
                    obj.get("error")?.takeIf { it.isJsonObject }?.asJsonObject?.get("message")?.asString,
                )
            } else Incoming.Unknown(line)
            else -> Incoming.Unknown(line)
        }
    }
}
