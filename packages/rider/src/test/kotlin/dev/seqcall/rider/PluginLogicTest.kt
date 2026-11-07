package dev.seqcall.rider

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class PluginLogicTest {
    private val repo = File("../..").canonicalFile

    @Test
    fun `FR-15_3 sidecar notifications are parsed`() {
        val post = Rpc.parse("""{"jsonrpc":"2.0","method":"post","params":{"view":"class","message":{"type":"empty","reason":"x"}}}""")
        assertEquals("class", (post as Rpc.Incoming.Post).view)
        assertEquals("empty", post.message.asJsonObject.get("type").asString)
        val nav = Rpc.parse("""{"method":"navigate","params":{"range":{"file":"/a/b.ts","start":{"line":3,"character":4},"end":{"line":3,"character":9}}}}""")
        assertEquals(Rpc.Incoming.Navigate("/a/b.ts", 3, 4), nav)
        // FR-24.7 a reviewed call side by side
        assertEquals(
            Rpc.Incoming.OpenDiff("/a/b.cs", 7, "old\n", "b.cs (develop ↔ feature/x)"),
            Rpc.parse("""{"method":"openDiff","params":{"file":"/a/b.cs","line":7,"baseText":"old\n","title":"b.cs (develop ↔ feature/x)"}}"""),
        )
        assertEquals(Rpc.Incoming.Progress(null), Rpc.parse("""{"method":"progress","params":{"title":null}}"""))
        assertEquals(Rpc.Incoming.Response(3, null, "boom"), Rpc.parse("""{"id":3,"error":{"code":-1,"message":"boom"}}""").let {
            (it as Rpc.Incoming.Response).copy(result = null)
        })
        assertTrue(Rpc.parse("not json") is Rpc.Incoming.Unknown)
    }

    @Test
    fun `FR-15_3 view messages are forwarded as JSON, not as strings`() {
        val line = JsonParser.parseString(Rpc.viewMessage("sequence", """{"type":"expand","messageId":"root/0:f"}""")).asJsonObject
        assertEquals("view", line.get("method").asString)
        assertEquals("root/0:f", line.getAsJsonObject("params").getAsJsonObject("message").get("messageId").asString)
    }

    @Test
    fun `FR-15_5 Node lookup prefers the setting, skips old versions and searches nvm`() {
        val home = createTempDir()
        fun exe(path: String) = File(home, path).apply { parentFile.mkdirs(); writeText(""); setExecutable(true) }
        val old = exe("bin/node")
        val nvm18 = exe(".nvm/versions/node/v18.20.0/bin/node")
        val nvm22 = exe(".nvm/versions/node/v22.11.0/bin/node")
        val versions = mapOf(old.path to "v16.20.2", nvm18.path to "v18.20.0", nvm22.path to "v22.11.0")
        val locator = NodeLocator(env = { if (it == "PATH") old.parent else null }, home = home.path, versionOf = { versions[it] })
        assertEquals(nvm22.path, locator.locate(null).path) // PATH node 16 rejected, newest nvm wins
        assertEquals(old.path, locator.candidates(null).first())
        val set = exe("custom/node")
        assertEquals(set.path, NodeLocator(env = { null }, home = home.path, versionOf = { "v24.0.0" }).locate(set.path).path)
        try {
            NodeLocator(env = { if (it == "PATH") old.parent else null }, home = "/nonexistent", versionOf = { versions[it] }).locate(null)
            fail("expected NotFound")
        } catch (e: NodeLocator.NotFound) {
            assertTrue(e.message!!, e.message!!.contains("v16.20.2"))
        }
        home.deleteRecursively()
    }

    @Test
    fun `FR-15_6 the page defines the host hook before the bundle and maps the IDE theme`() {
        val html = HtmlShell.page(File("/plugin/webview"), "sequence.js", "cefQuery_1({request: request});",
            HtmlShell.Theme(dark = true, vars = mapOf("editor-background" to HtmlShell.css(30, 31, 34))))
        assertTrue(html.indexOf("__seqcallHostPost") in 0 until html.indexOf("sequence.js"))
        assertTrue(html.contains("""src="file:/plugin/webview/sequence.js""""))
        assertTrue(html.contains("--vscode-editor-background:#1e1f22;"))
        assertTrue(html.contains("""class="vscode-dark""""))
        assertEquals("rgba(0, 0, 0, 0.50)", HtmlShell.css(0, 0, 0, 128))
    }

    /** JCEF-free bridge test: the real bundled sidecar driven from the JVM (skipped if not built / no Node). */
    @Test
    fun `FR-15_3 the bundled sidecar renders a diagram for the plugin`() {
        val bundle = File(repo, "packages/stdio-host/dist/stdio-host.cjs")
        assumeTrue("sidecar bundle not built", bundle.isFile)
        val node = try {
            NodeLocator().locate(null)
        } catch (_: NodeLocator.NotFound) {
            null
        }
        assumeTrue("no Node ${NodeLocator.MIN_MAJOR}+", node != null)

        val messages = CopyOnWriteArrayList<Rpc.Incoming>()
        val rendered = CountDownLatch(1)
        val process = SidecarProcess(listOf(node!!.path, bundle.path, "--workspace", repo.path), repo, onMessage = {
            messages += it
            if (it is Rpc.Incoming.Post && it.message.asJsonObject.get("type").asString == "render") rendered.countDown()
        })
        val file = File(repo, "fixtures/sample-app/src/controllers/user-controller.ts")
        val line = file.readLines().indexOfFirst { it.contains("this.validate(id);") }
        process.request("initialize")
        process.notify("openAt", JsonObject().apply {
            addProperty("file", file.path)
            add("position", Rpc.position(line, 6))
        })
        assertTrue("no render within 30 s: $messages", rendered.await(30, TimeUnit.SECONDS))
        val render = messages.filterIsInstance<Rpc.Incoming.Post>().first { it.message.asJsonObject.get("type").asString == "render" }
        assertEquals("getUser", render.message.asJsonObject.getAsJsonObject("diagram").getAsJsonObject("root").get("name").asString)
        process.stop()
        assertTrue(!process.isAlive)
    }

    @Test
    fun `FR-33_6 Info at Caret asks the bundled sidecar and gets its answer by callback, also the memory report`() {
        val bundle = File(repo, "packages/stdio-host/dist/stdio-host.cjs")
        assumeTrue("sidecar bundle not built", bundle.isFile)
        val node = try {
            NodeLocator().locate(null)
        } catch (_: NodeLocator.NotFound) {
            null
        }
        assumeTrue("no Node ${NodeLocator.MIN_MAJOR}+", node != null)
        val others = CopyOnWriteArrayList<Rpc.Incoming>()
        val process = SidecarProcess(listOf(node!!.path, bundle.path, "--workspace", repo.path), repo, onMessage = { others += it })
        val file = File(repo, "fixtures/sample-app/src/console/report.ts")
        val line = file.readLines().indexOfFirst { it.contains("function report") }
        val answers = CopyOnWriteArrayList<Rpc.Incoming.Response>()
        val done = CountDownLatch(2)
        process.request("initialize")
        process.request("describeAt", JsonObject().apply {
            addProperty("file", file.path)
            add("position", Rpc.position(line, "export function re".length))
            addProperty("word", "report")
        }) { answers += it; done.countDown() }
        process.request("memory", JsonObject()) { answers += it; done.countDown() }
        assertTrue("no answers within 30 s: $others", done.await(30, TimeUnit.SECONDS))
        val info = answers.first { it.result?.asJsonObject?.has("lines") == true && it.result!!.asJsonObject.has("routes") }.result!!.asJsonObject
        assertEquals("⌂ reached from 1 entry point", info.getAsJsonArray("lines")[0].asString)
        assertTrue(InfoHtml.render(info).contains("<a href=\"reach:0\"><code>"))
        val memory = answers.first { it.result?.asJsonObject?.has("summary") == true }.result!!.asJsonObject
        assertTrue(memory.get("summary").asString, memory.get("summary").asString.startsWith("Seqcall uses "))
        // the answers went to their callbacks, not to onMessage
        assertTrue(others.none { it is Rpc.Incoming.Response && it.id > 1 })
        process.stop()
    }

    @Test
    fun `FR-33_6 the popup HTML - lines escaped, entry points as links in a list, +n more, the links below`() {
        val answer = JsonParser.parseString(
            """{"lines":["⌂ reached from 7 entry points · 2 tests","  · GET /a<b>","  · POST /c","  · +5 more","↯ DB"],"item":"  · ","routes":[],"onName":true}""",
        ).asJsonObject
        assertEquals(
            "<b>Seqcall</b><br>⌂ reached from 7 entry points · 2 tests<br>" +
                "<ul style=\"margin-top:2px;margin-bottom:2px\"><li><a href=\"reach:0\"><code>GET /a&lt;b&gt;</code></a></li>" +
                "<li><a href=\"reach:1\"><code>POST /c</code></a></li><li><a href=\"reach:more\">+5 more</a></li></ul>" +
                "↯ DB<br><br><a href=\"diagram\">Sequence diagram</a> · <a href=\"paths\">Paths to here</a>",
            InfoHtml.render(answer),
        )
        // a call: no Paths to here; a list at the end is closed
        val call = JsonParser.parseString("""{"lines":["→ runs A.save (the only implementation)","  · x"],"onName":false}""").asJsonObject
        assertEquals(
            "<b>Seqcall</b><br>→ runs A.save (the only implementation)<br><ul style=\"margin-top:2px;margin-bottom:2px\"><li><a href=\"reach:0\"><code>x</code></a></li></ul><br><a href=\"diagram\">Sequence diagram</a>",
            InfoHtml.render(call),
        )
        assertEquals("&amp;&quot;", InfoHtml.escape("&\""))
    }

    @Test
    fun `FR-33_6 the word under the caret - inside, at either end, none on a space`() {
        val text = "await repo.FindByIdAsync(id);"
        assertEquals("FindByIdAsync", InfoHtml.wordAt(text, text.indexOf("ById")))
        assertEquals("FindByIdAsync", InfoHtml.wordAt(text, text.indexOf("Find")))
        assertEquals("FindByIdAsync", InfoHtml.wordAt(text, text.indexOf("(")))
        assertEquals("\$x_1", InfoHtml.wordAt("a \$x_1", 6))
        assertEquals(null, InfoHtml.wordAt("a  b", 2))
        assertEquals(null, InfoHtml.wordAt("", 5))
    }

    private fun createTempDir(): File = kotlin.io.path.createTempDirectory("seqcall").toFile()

    // FR-30.4 / FR-30.5 self-update from the GitHub releases (Updates.kt; fake GitHub, no network)

    private val latestUrl = "https://api.github.com/repos/seqcall/seqcall/releases/latest"
    private val assetUrl = "https://api.github.com/repos/seqcall/seqcall/releases/assets/9"
    private val storageUrl = "https://objects.example/signed?sig=1"

    private fun releaseJson(tag: String = "v0.2.0", asset: String = "seqcall-rider-0.2.0.zip") =
        """{"tag_name":"$tag","html_url":"https://github.com/seqcall/seqcall/releases/tag/$tag","assets":[
           {"name":"seqcall-0.2.0.vsix","url":"https://api.github.com/x/1"},{"name":"$asset","url":"$assetUrl"}]}"""

    /** A fake GitHub: the release, the asset as a redirect to signed storage, the zip there. */
    private class FakeGitHub(val release: String, val status: Int = 200, val assetStatus: Int = 302) : Updates.Http {
        val calls = mutableListOf<Pair<String, Map<String, String>>>()
        override fun get(url: String, headers: Map<String, String>): Updates.Response {
            calls += url to headers
            return when {
                url.endsWith("/releases/latest") -> Updates.Response(status, release.toByteArray(), null)
                url.contains("/assets/") -> Updates.Response(assetStatus, ByteArray(0), if (assetStatus == 302) "https://objects.example/signed?sig=1" else null)
                else -> Updates.Response(200, byteArrayOf(0x50, 0x4b, 3), null)
            }
        }
    }

    @Test
    fun `FR-30_4 versions compare numerically, a pending install counts, checks are due once a day`() {
        assertEquals(1, Updates.compareVersions("0.1.10", "0.1.9"))
        assertEquals(0, Updates.compareVersions("v0.2.0", "0.2"))
        assertEquals(0, Updates.compareVersions("1.0.0-beta", "1.0.0"))
        assertEquals(-1, Updates.compareVersions("0.1.9", "1.0.0"))
        assertEquals("0.2.0", Updates.effectiveVersion("0.1.9", "0.2.0"))
        assertEquals("0.2.0", Updates.effectiveVersion("0.2.0", "0.1.9"))
        assertEquals("0.1.9", Updates.effectiveVersion("0.1.9", null))
        val day = 24L * 3600_000
        assertTrue(Updates.due(null, 1, day))
        assertTrue(!Updates.due(0, day - 1, day))
        assertTrue(Updates.due(0, day, day))
        assertTrue(Updates.due(5000, 1000, day))
    }

    @Test
    fun `FR-30_4 a newer release's Rider zip is downloaded without any sign-in and installed`() {
        val gh = FakeGitHub(releaseJson())
        val installed = mutableListOf<Pair<List<Byte>, String>>()
        val r = Updates.Checker(gh, "0.1.9", { bytes, rel -> installed += bytes.toList() to rel.assetName }).check(Updates.Mode.INSTALL)
        assertEquals("0.2.0", (r as Updates.Result.Installed).release.version)
        assertEquals(listOf(listOf<Byte>(0x50, 0x4b, 3) to "seqcall-rider-0.2.0.zip"), installed)
        assertEquals(listOf(latestUrl, assetUrl, storageUrl), gh.calls.map { it.first })
        assertTrue("no sign-in", gh.calls.all { it.second["Authorization"] == null })
        assertEquals("application/octet-stream", gh.calls[1].second["Accept"])
    }

    @Test
    fun `FR-30_4 up to date, notify mode and a release without a Rider zip install nothing`() {
        val none: (ByteArray, Updates.Release) -> Unit = { _, _ -> fail("nothing to install") }
        assertEquals(Updates.Result.UpToDate("0.1.9"), Updates.Checker(FakeGitHub(releaseJson("v0.1.9")), "0.1.9", none).check(Updates.Mode.INSTALL))
        assertEquals(Updates.Result.UpToDate("0.2.0"), Updates.Checker(FakeGitHub(releaseJson()), Updates.effectiveVersion("0.1.9", "0.2.0"), none).check(Updates.Mode.INSTALL))
        val offered = Updates.Checker(FakeGitHub(releaseJson()), "0.1.9", none).check(Updates.Mode.NOTIFY)
        assertEquals("seqcall-rider-0.2.0.zip", (offered as Updates.Result.Available).release.assetName)
        assertEquals(Updates.Result.NoAsset("0.2.0"), Updates.Checker(FakeGitHub(releaseJson(asset = "notes.txt")), "0.1.9", none).check(Updates.Mode.INSTALL))
        // the notification's Install
        var got: String? = null
        assertTrue(Updates.Checker(FakeGitHub(releaseJson()), "0.1.9", { _, rel -> got = rel.version }).install(offered.release) is Updates.Result.Installed)
        assertEquals("0.2.0", got)
    }

    @Test
    fun `FR-30_5 refusals and failures become results that say what to do`() {
        val none: (ByteArray, Updates.Release) -> Unit = { _, _ -> fail("nothing to install") }
        assertEquals(Updates.Result.Error("GitHub has no published release of seqcall/seqcall (404)."), Updates.Checker(FakeGitHub("", status = 404), "0.1.9", none).check(Updates.Mode.INSTALL))
        assertEquals(Updates.Result.Error("GitHub answered 403."), Updates.Checker(FakeGitHub("", status = 403), "0.1.9", none).check(Updates.Mode.INSTALL))
        val limited = Updates.httpError(Updates.Response(403, ByteArray(0), null, "0"))
        assertTrue(limited, limited.contains("Try again in an hour"))
        assertEquals(Updates.Result.Error("GitHub answered 500."), Updates.Checker(FakeGitHub(releaseJson(), assetStatus = 500), "0.1.9", none).check(Updates.Mode.INSTALL))
        val offline = Updates.Checker({ _, _ -> throw java.io.IOException("api.github.com: unknown host") }, "0.1.9", none).check(Updates.Mode.INSTALL)
        assertEquals(Updates.Result.Error("api.github.com: unknown host"), offline)
        val failing = Updates.Checker(FakeGitHub(releaseJson()), "0.1.9", { _, _ -> throw IllegalStateException("not a plugin") }).check(Updates.Mode.INSTALL)
        assertEquals(Updates.Result.Error("not a plugin"), failing)
    }
}
