plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
    // coverage of the plugin tests: `npm run coverage:kt` (docs/TESTING.md §11)
    id("org.jetbrains.kotlinx.kover") version "0.9.11"
}

group = "dev.seqcall"
version = "0.1.0" // scripts/set-version.mjs

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

/** Rider installation used for compiling and runIde (the Toolbox default unless overridden). */
val riderPath: String = providers.gradleProperty("riderPath").orNull?.takeIf { it.isNotBlank() }
    ?: System.getenv("RIDER_PATH")
    ?: "${System.getProperty("user.home")}/.local/share/JetBrains/Toolbox/apps/rider"

/**
 * CI has no Rider installed: -PriderVersion=2026.2.3.1 (or env RIDER_VERSION) builds against that Rider
 * from JetBrains' Maven repository instead of the local installation.
 */
val riderVersion: String? = providers.gradleProperty("riderVersion").orNull?.takeIf { it.isNotBlank() }
    ?: System.getenv("RIDER_VERSION")?.takeIf { it.isNotBlank() }

/** Monorepo outputs bundled into the plugin directory (built by `npm run build:rider` at the repo root). */
val repo = layout.projectDirectory.dir("../..")
val webviewDist = repo.dir("packages/webview/dist")
val stdioHostDist = repo.dir("packages/stdio-host/dist")
val csharpDist = repo.dir("packages/vscode/dist/csharp")

dependencies {
    intellijPlatform {
        if (riderVersion != null) rider(riderVersion) { useInstaller = false } else local(riderPath)
        bundledPlugin("com.intellij.modules.jcef")
    }
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.google.code.gson:gson:2.13.2")
}

// Rider 2026.2 runs on Java 25 (its bundled JBR builds the plugin too: JAVA_HOME=<rider>/jbr).
kotlin { jvmToolchain(25) }

intellijPlatform {
    buildSearchableOptions = false
    instrumentCode = false
    pluginConfiguration {
        ideaVersion { sinceBuild = "262" }
    }
}

kover {
    reports {
        total {
            html { htmlDir = repo.dir("coverage/kotlin/html") }
            xml { xmlFile = repo.file("coverage/kotlin/report.xml") } // JaCoCo format, read by SonarQube
        }
    }
}

tasks {
    // Every sandbox (buildPlugin, runIde, tests) gets the bundled webview and sidecars.
    withType<org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask>().configureEach {
        from(webviewDist) {
            include("sequence.js", "class.js", "styles.css")
            into(pluginName.map { "$it/webview" })
        }
        from(stdioHostDist) { into(pluginName.map { "$it/node" }) }
        from(csharpDist) { into(pluginName.map { "$it/csharp" }) }
        from(repo.file("LICENSE")) { into(pluginName) }
        from(layout.buildDirectory.file("THIRD-PARTY-NOTICES.txt")) { into(pluginName) }
    }
    runIde {
        // Remote DevTools of the JCEF browsers (headless checks: scripts/jcef-screenshot.mjs).
        // JCEF_DEBUG_PORT=0 disables it.
        val debugPort = providers.environmentVariable("JCEF_DEBUG_PORT").orElse("9223")
        jvmArgumentProviders += CommandLineArgumentProvider { listOfNotNull(
            debugPort.get().takeIf { it != "0" }?.let { "-Dide.browser.jcef.debug.port=$it" },
            // Sandbox only: no "Trust solution?" dialog for the fixtures (it blocks unattended smoke runs).
            "-Didea.trust.disabled=true",
            "-Didea.trust.all.projects=true",
        ) }
        // Chromium puts its SingletonSocket in $TMPDIR/.org.chromium.Chromium.XXXXXX/; with a long TMPDIR
        // (e.g. an agent's scratchpad) the socket path exceeds the ~107-byte Unix limit and cef_server
        // dies with SIGTRAP as soon as a browser is created. Give the IDE a short one.
        val tmpDir = System.getenv("TMPDIR")
        if (tmpDir != null && tmpDir.length > 40) environment("TMPDIR", "/tmp")
        // Unattended smoke runs (scripts/smoke.sh sets SEQCALL_SMOKE_OPEN): no modal AI promo window.
        val smoke = providers.environmentVariable("SEQCALL_SMOKE_OPEN")
        // Diagnostics: JCEF_OOP=false runs JCEF in-process, JCEF_SANDBOX=false without Chromium's sandbox.
        val oop = providers.environmentVariable("JCEF_OOP")
        val cefSandbox = providers.environmentVariable("JCEF_SANDBOX")
        jvmArgumentProviders += CommandLineArgumentProvider {
            listOfNotNull(
                oop.orNull?.let { "-Dide.browser.jcef.out-of-process.enabled=$it" },
                cefSandbox.orNull?.let { "-Dide.browser.jcef.sandbox.enable=$it" },
            )
        }
        jvmArgumentProviders += CommandLineArgumentProvider { if (smoke.isPresent) listOf("-Didea.is.integration.test=true") else emptyList() }
        // -PopenProject=<dir>: open that project directly (e.g. ../../fixtures/sample-app).
        val open = providers.gradleProperty("openProject").map { layout.projectDirectory.file(it).asFile.absolutePath }
        argumentProviders += CommandLineArgumentProvider { listOfNotNull(open.orNull) }
    }
}
