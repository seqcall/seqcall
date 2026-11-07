using System.Text.Json;
using Microsoft.Build.Locator;

namespace Seqcall.CSharp.Workspace;

/// <summary>
/// Registers the MSBuild of the SDK selected for the project (honouring its global.json).
/// Must run before any type from Microsoft.Build / MSBuildWorkspace is loaded, so callers keep
/// this in a separate method from the code that uses the workspace.
/// When no SDK satisfies the project's global.json, <see cref="Error"/> names the file, the required
/// and the installed SDKs (initialize fails with it instead of an MSBuild assembly-load error).
/// </summary>
public static class MsBuildRegistration
{
    private static readonly object Gate = new();

    public static string? RegisteredPath { get; private set; }

    /// <summary>No MSBuild could be registered (initialize fails with this message).</summary>
    public static string? Error { get; private set; }

    public static void Register(string projectRoot)
    {
        lock (Gate)
        {
            if (MSBuildLocator.IsRegistered) return;
            try
            {
                RegisterFor(projectRoot);
            }
            catch (Exception ex)
            {
                Error = $"MSBuild could not be registered: {ex.Message}";
                Log.Error(Error);
            }
        }
    }

    private static void RegisterFor(string projectRoot)
    {
        VisualStudioInstance? instance;
        try
        {
            instance = Query(projectRoot).FirstOrDefault();
        }
        catch (Exception ex)
        {
            // hostfxr throws when the project's global.json cannot be satisfied
            Log.Info($"No .NET SDK for the project's global.json: {ex.Message}");
            instance = null;
        }
        if (instance is null)
        {
            // No fallback to another SDK: MSBuildWorkspace's build host resolves the SDK again for
            // each project from the project's folder, so the global.json applies there anyway.
            var installed = Query(Path.GetTempPath()).OrderByDescending(i => i.Version).ToList();
            var list = installed.Count == 0 ? "none" : string.Join(", ", installed.Select(i => i.Version.ToString()));
            var pin = GlobalJsonPin(projectRoot);
            Error = pin is { } p
                ? $"{p.File} requires .NET SDK {p.Version}{(p.RollForward is null ? "" : $" (rollForward: {p.RollForward})")}, which is not installed (installed SDKs: {list}). " +
                  $"Install it, e.g. `dotnet-install.sh --version {p.Version} --install-dir ~/.dotnet` (https://dot.net/v1/dotnet-install.sh), then reload the window."
                : $"No .NET SDK found for {projectRoot} (installed SDKs: {list}). Install a .NET SDK (8 or newer) to analyse C# solutions.";
            Log.Error(Error);
            return;
        }
        MSBuildLocator.RegisterInstance(instance);
        RegisteredPath = instance.MSBuildPath;
        Log.Info($"Registered MSBuild {instance.Version} from {instance.MSBuildPath}");
    }

    private static List<VisualStudioInstance> Query(string workingDirectory)
    {
        var instances = MSBuildLocator.QueryVisualStudioInstances(new VisualStudioInstanceQueryOptions
        {
            DiscoveryTypes = DiscoveryType.DotNetSdk,
            WorkingDirectory = workingDirectory,
        }).ToList();
        foreach (var i in instances) Log.Info($"MSBuild candidate: {i.Name} {i.Version} at {i.MSBuildPath}");
        return instances;
    }

    /// <summary>The nearest global.json at or above the root that pins an SDK version.</summary>
    internal static (string File, string Version, string? RollForward)? GlobalJsonPin(string projectRoot)
    {
        for (var dir = new DirectoryInfo(projectRoot); dir is not null; dir = dir.Parent)
        {
            var file = Path.Combine(dir.FullName, "global.json");
            if (!File.Exists(file)) continue;
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(file), new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
                if (!doc.RootElement.TryGetProperty("sdk", out var sdk) || !sdk.TryGetProperty("version", out var v)) return null;
                var roll = sdk.TryGetProperty("rollForward", out var r) ? r.GetString() : null;
                return (file, v.GetString() ?? "", roll);
            }
            catch (JsonException)
            {
                return null;
            }
        }
        return null;
    }
}
