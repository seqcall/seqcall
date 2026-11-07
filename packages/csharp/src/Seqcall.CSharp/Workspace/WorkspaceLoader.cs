using System.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.MSBuild;

namespace Seqcall.CSharp.Workspace;

public sealed record LoadedWorkspace(MSBuildWorkspace Workspace, Solution Solution, long LoadMs);

/// <summary>Opens the solution (given, else the single .sln/.slnx under the root, else all .csproj).</summary>
public static class WorkspaceLoader
{
    private static readonly string[] SkippedDirs = ["bin", "obj", "node_modules", ".git", ".vs", ".idea"];

    public static async Task<LoadedWorkspace> LoadAsync(string projectRoot, string? solution, CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();
        var workspace = MSBuildWorkspace.Create();
        workspace.LoadMetadataForReferencedProjects = false;
        workspace.SkipUnrecognizedProjects = true;
        workspace.RegisterWorkspaceFailedHandler(e =>
            Log.Warn($"workspace {e.Diagnostic.Kind}: {e.Diagnostic.Message}"));

        var slnPath = ResolveSolution(projectRoot, solution);
        Solution sln;
        if (slnPath is not null)
        {
            Log.Info($"Opening solution {slnPath}");
            sln = await workspace.OpenSolutionAsync(slnPath, cancellationToken: ct).ConfigureAwait(false);
        }
        else
        {
            var projects = FindFiles(projectRoot, "*.csproj").ToList();
            Log.Info($"No solution found; opening {projects.Count} project(s)");
            foreach (var p in projects)
            {
                if (workspace.CurrentSolution.Projects.Any(x => Paths.Comparer.Equals(x.FilePath, p))) continue;
                try
                {
                    await workspace.OpenProjectAsync(p, cancellationToken: ct).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    Log.Warn($"Failed to open {p}: {ex.Message}");
                }
            }
            sln = workspace.CurrentSolution;
        }
        sln = WithoutUnresolvedAnalyzers(sln);
        sw.Stop();
        return new LoadedWorkspace(workspace, sln, sw.ElapsedMilliseconds);
    }

    /// <summary>
    /// Drops analyzer references whose assembly is missing (packages not restored, analyzer built by the
    /// solution itself): SymbolFinder (implementations, callers) serializes the solution and throws
    /// "Unexpected value 'UnresolvedAnalyzerReference'" on them. Analyzers play no part in the analysis.
    /// </summary>
    internal static Solution WithoutUnresolvedAnalyzers(Solution solution)
    {
        var dropped = 0;
        foreach (var projectId in solution.ProjectIds)
        {
            var project = solution.GetProject(projectId)!;
            var unresolved = project.AnalyzerReferences.OfType<UnresolvedAnalyzerReference>().ToList();
            if (unresolved.Count == 0) continue;
            solution = solution.WithProjectAnalyzerReferences(projectId, project.AnalyzerReferences.Except(unresolved));
            dropped += unresolved.Count;
        }
        var solutionLevel = solution.AnalyzerReferences.OfType<UnresolvedAnalyzerReference>().ToList();
        foreach (var r in solutionLevel) solution = solution.RemoveAnalyzerReference(r);
        dropped += solutionLevel.Count;
        if (dropped > 0) Log.Warn($"Ignoring {dropped} analyzer reference(s) whose assembly is missing");
        return solution;
    }

    internal static string? ResolveSolution(string projectRoot, string? solution)
    {
        if (!string.IsNullOrWhiteSpace(solution))
        {
            var p = Path.IsPathRooted(solution) ? Paths.ToOs(solution) : Paths.ToOs(Path.Combine(projectRoot, solution));
            if (!File.Exists(p)) throw new FileNotFoundException($"Solution not found: {p}");
            return p;
        }
        var top = Directory.EnumerateFiles(projectRoot)
            .Where(IsSolutionFile)
            .OrderBy(f => f, StringComparer.Ordinal)
            .ToList();
        if (top.Count == 1) return top[0];
        if (top.Count > 1)
        {
            var dirName = Path.GetFileName(projectRoot.TrimEnd('/', '\\'));
            var pick = top.FirstOrDefault(f => Path.GetFileNameWithoutExtension(f).Equals(dirName, StringComparison.OrdinalIgnoreCase)) ?? top[0];
            Log.Warn($"Several solutions under the root; using {pick} (pass --solution to choose)");
            return pick;
        }
        var nested = FindFiles(projectRoot, "*.sln").Concat(FindFiles(projectRoot, "*.slnx")).Distinct().ToList();
        if (nested.Count == 1) return nested[0];
        return null;
    }

    private static bool IsSolutionFile(string f) =>
        f.EndsWith(".sln", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase);

    private static List<string> FindFiles(string root, string pattern)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        var results = new List<string>();
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            try
            {
                results.AddRange(Directory.EnumerateFiles(dir, pattern));
                foreach (var sub in Directory.EnumerateDirectories(dir))
                {
                    var name = Path.GetFileName(sub);
                    if (SkippedDirs.Contains(name, StringComparer.OrdinalIgnoreCase)) continue;
                    stack.Push(sub);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // unreadable directory: skip
            }
        }
        results.Sort(StringComparer.Ordinal);
        return results;
    }
}
