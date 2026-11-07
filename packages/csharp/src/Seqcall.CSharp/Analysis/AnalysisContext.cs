using System.Text.RegularExpressions;
using Seqcall.CSharp.Workspace;
using Microsoft.CodeAnalysis;

namespace Seqcall.CSharp.Analysis;

/// <summary>
/// The current solution snapshot plus per-snapshot caches (compilations, semantic models,
/// resolved keys). Every update produces a new snapshot and clears the caches.
/// </summary>
public sealed partial class AnalysisContext
{
    private readonly Dictionary<ProjectId, Compilation> _compilations = new();
    private readonly Dictionary<SyntaxTree, Compilation> _treeCompilations = new();
    private readonly Dictionary<SyntaxTree, SemanticModel> _models = new();
    private readonly Dictionary<string, ISymbol?> _keyCache = new(StringComparer.Ordinal);
    private readonly Dictionary<SyntaxTree, bool> _regularTrees = new();
    private bool _compiled;

    public AnalysisContext(string projectRoot, Solution solution)
    {
        Root = Paths.ToOs(projectRoot).TrimEnd('/', '\\');
        Solution = solution;
        Refs = new SymbolRefs(this);
    }

    /// <summary>Project root as OS path (no trailing separator).</summary>
    public string Root { get; }

    public Solution Solution { get; private set; }

    public SymbolRefs Refs { get; }

    internal Dictionary<string, ISymbol?> KeyCache => _keyCache;

    public void SetSolution(Solution solution)
    {
        Solution = solution;
        _compilations.Clear();
        _treeCompilations.Clear();
        _models.Clear();
        _keyCache.Clear();
        _regularTrees.Clear();
        _compiled = false;
    }

    /// <summary>
    /// Computes (and caches) the compilations of all C# projects of the snapshot — in parallel (Roslyn compiles
    /// independent projects concurrently and shares the referenced ones; one by one is much slower on a large
    /// solution), then recorded in project order, so a file linked into several projects keeps its first project.
    /// </summary>
    public async Task EnsureCompilationsAsync(CancellationToken ct = default)
    {
        if (_compiled) return;
        var projects = Solution.Projects.Where(p => p.Language == LanguageNames.CSharp).ToList();
        var compiled = await Task.WhenAll(projects.Select(async project =>
        {
            try
            {
                return await Task.Run(() => project.GetCompilationAsync(ct), ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Log.Warn($"Compilation of {project.Name} failed: {ex.Message}");
                return null;
            }
        })).ConfigureAwait(false);
        for (var i = 0; i < projects.Count; i++)
        {
            var c = compiled[i];
            if (c is null) continue;
            _compilations[projects[i].Id] = c;
            foreach (var t in c.SyntaxTrees) _treeCompilations.TryAdd(t, c);
        }
        _compiled = true;
    }

    public IEnumerable<Compilation> Compilations => _compilations.Values;

    public Compilation? CompilationOf(Project project) => _compilations.GetValueOrDefault(project.Id);

    public Compilation? CompilationOf(SyntaxTree tree) => _treeCompilations.GetValueOrDefault(tree);

    public SemanticModel? ModelOf(SyntaxTree tree)
    {
        if (_models.TryGetValue(tree, out var m)) return m;
        var c = CompilationOf(tree);
        if (c is null) return null;
        m = c.GetSemanticModel(tree);
        _models[tree] = m;
        return m;
    }

    /// <summary>Documents (one per project for linked files) with the given path.</summary>
    public IEnumerable<Document> DocumentsAt(string file)
    {
        var os = Paths.ToOs(file);
        foreach (var id in Solution.GetDocumentIdsWithFilePath(os))
        {
            var d = Solution.GetDocument(id);
            if (d is not null) yield return d;
        }
    }

    /// <summary>The tree of the file in the (first) project compilation containing it.</summary>
    public SyntaxTree? TreeAt(string file)
    {
        var os = Paths.ToOs(file);
        foreach (var doc in DocumentsAt(os))
        {
            var c = CompilationOf(doc.Project);
            var tree = c?.SyntaxTrees.FirstOrDefault(t => Paths.Comparer.Equals(t.FilePath, doc.FilePath));
            if (tree is not null) return tree;
        }
        return null;
    }

    /// <summary>True for trees of regular (non-generated) documents of the solution.</summary>
    public bool IsRegularTree(SyntaxTree tree)
    {
        if (_regularTrees.TryGetValue(tree, out var r)) return r;
        r = !string.IsNullOrEmpty(tree.FilePath) && Solution.GetDocumentIdsWithFilePath(tree.FilePath).Length > 0;
        _regularTrees[tree] = r;
        return r;
    }

    public string RelativePath(string osPath) => Paths.Relative(Root, osPath);

    [GeneratedRegex(@"(^|[./\\])(Unit|Integration|Functional|Acceptance|E2E|Component)?Tests?($|[./\\])", RegexOptions.IgnoreCase)]
    private static partial Regex TestProjectName();

    [GeneratedRegex(@"(^|/)(tests?|specs?)/", RegexOptions.IgnoreCase)]
    private static partial Regex TestFolder();

    public static bool IsTestProject(Project p) => TestProjectName().IsMatch(p.Name);

    /// <summary>Test code (test projects / test folders) never provides implementations and sorts last among callers.</summary>
    public bool IsTestFile(string osPath)
    {
        var rel = RelativePath(osPath);
        if (TestFolder().IsMatch(rel)) return true;
        foreach (var d in DocumentsAt(osPath))
        {
            if (TestProjectName().IsMatch(d.Project.Name)) return true;
        }
        return false;
    }
}
