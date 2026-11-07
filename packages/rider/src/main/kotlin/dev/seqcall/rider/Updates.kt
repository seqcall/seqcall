package dev.seqcall.rider

import com.google.gson.JsonParser
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * FR-30.4 self-update from the GitHub releases of the public repository, without sign-in — the part without IntelliJ
 * classes, tested by PluginLogicTest. The IDE side (schedule, install after restart, notifications) is in Updater.kt.
 */
object Updates {
    const val REPO = "seqcall/seqcall"
    const val API = "https://api.github.com"

    data class Release(val version: String, val tag: String, val url: String, val assetUrl: String, val assetName: String)

    sealed interface Result {
        data class UpToDate(val latest: String) : Result
        data class NoAsset(val latest: String) : Result
        data class Error(val message: String) : Result
        data class Available(val release: Release) : Result
        data class Installed(val release: Release) : Result
    }

    enum class Mode { INSTALL, NOTIFY, OFF }

    /** `rateLimitRemaining`: GitHub's `x-ratelimit-remaining` header. */
    data class Response(val status: Int, val body: ByteArray, val location: String?, val rateLimitRemaining: String? = null)

    /** GET without following redirects (the asset answers with a redirect to signed storage). */
    fun interface Http {
        fun get(url: String, headers: Map<String, String>): Response
    }

    /** 1 / 0 / -1 for x.y.z versions; a leading `v` and a pre-release / build suffix are ignored. */
    fun compareVersions(a: String, b: String): Int {
        fun parts(v: String) = v.removePrefix("v").split('-', '+')[0].split('.').map { it.toIntOrNull() ?: 0 }
        val pa = parts(a)
        val pb = parts(b)
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val d = pa.getOrElse(i) { 0 } - pb.getOrElse(i) { 0 }
            if (d != 0) return Integer.signum(d)
        }
        return 0
    }

    /** True when the last check is older than `intervalMs` (or there was none); a clock that went back counts as due. */
    fun due(lastCheck: Long?, now: Long, intervalMs: Long): Boolean =
        lastCheck == null || now - lastCheck >= intervalMs || now < lastCheck

    /** The version a check compares with: the running one, or a newer one installed but not loaded yet (no restart yet). */
    fun effectiveVersion(running: String, installedPending: String?): String =
        if (installedPending != null && compareVersions(installedPending, running) > 0) installedPending else running

    /** The latest release's Rider zip, or why there is none (`NoAsset`). */
    fun parseRelease(json: String): Any {
        val o = JsonParser.parseString(json).asJsonObject
        val tag = o.get("tag_name")?.takeIf { !it.isJsonNull }?.asString ?: ""
        val version = tag.removePrefix("v")
        val asset = o.getAsJsonArray("assets")?.map { it.asJsonObject }?.firstOrNull {
            val name = it.get("name")?.asString ?: ""
            name.startsWith("seqcall-rider-") && name.endsWith(".zip") && it.has("url")
        } ?: return Result.NoAsset(version)
        val url = o.get("html_url")?.takeIf { !it.isJsonNull }?.asString ?: ""
        return Release(version, tag, url, asset.get("url").asString, asset.get("name").asString)
    }

    /** Why GitHub refused, in words a user can act on. */
    fun httpError(res: Response, repo: String = REPO): String = when {
        (res.status == 403 || res.status == 429) && res.rateLimitRemaining == "0" ->
            "GitHub's limit for requests without sign-in is used up for this network (${res.status}). Try again in an hour."
        res.status == 404 -> "GitHub has no published release of $repo (404)."
        else -> "GitHub answered ${res.status}."
    }

    private fun headers(accept: String) = mapOf(
        "Accept" to accept,
        "X-GitHub-Api-Version" to "2022-11-28",
        "User-Agent" to "seqcall-rider",
    )

    class Checker(
        private val http: Http,
        private val currentVersion: String,
        private val install: (ByteArray, Release) -> Unit,
        private val repo: String = REPO,
        /** The API base; SEQCALL_UPDATE_API points it at a fake GitHub (smoke runs). */
        private val api: String = API,
    ) {
        /** One check; in INSTALL mode a newer release is downloaded and installed, otherwise only reported. */
        fun check(mode: Mode): Result = try {
            val res = http.get("$api/repos/$repo/releases/latest", headers("application/vnd.github+json"))
            if (res.status !in 200..299) Result.Error(httpError(res, repo))
            else when (val r = parseRelease(String(res.body, Charsets.UTF_8))) {
                is Result.NoAsset -> r
                is Release -> when {
                    compareVersions(r.version, currentVersion) <= 0 -> Result.UpToDate(r.version)
                    mode != Mode.INSTALL -> Result.Available(r)
                    else -> installRelease(r)
                }
                else -> Result.Error("unexpected release")
            }
        } catch (e: Exception) {
            Result.Error(e.message ?: e.toString())
        }

        /** Downloads and installs `release` (the notification's Install). */
        fun install(release: Release): Result = try {
            installRelease(release)
        } catch (e: Exception) {
            Result.Error(e.message ?: e.toString())
        }

        private fun installRelease(release: Release): Result {
            var res = http.get(release.assetUrl, headers("application/octet-stream"))
            if (res.status in 300..399 && res.location != null) res = http.get(res.location, mapOf("User-Agent" to "seqcall-rider"))
            if (res.status !in 200..299) return Result.Error(httpError(res, repo))
            install(res.body, release)
            return Result.Installed(release)
        }
    }

    /** java.net.http without redirects. */
    val javaHttp = Http { url, headers ->
        val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(15)).build()
        val req = HttpRequest.newBuilder(URI(url)).timeout(Duration.ofMinutes(5)).GET().apply { headers.forEach { (k, v) -> header(k, v) } }.build()
        val res = client.send(req, HttpResponse.BodyHandlers.ofByteArray())
        Response(
            res.statusCode(), res.body(), res.headers().firstValue("location").orElse(null),
            res.headers().firstValue("x-ratelimit-remaining").orElse(null),
        )
    }
}
