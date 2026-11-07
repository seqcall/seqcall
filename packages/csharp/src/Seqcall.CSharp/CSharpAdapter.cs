using System.Diagnostics;
using Seqcall.CSharp.Analysis;
using Seqcall.CSharp.Protocol;
using Seqcall.CSharp.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace Seqcall.CSharp;

/// <summary>
/// The C# LanguageAdapter: one method per protocol method (docs/CSHARP-SIDECAR.md).
/// Not thread-safe; the RPC server processes requests in order.
/// MSBuild must be registered (<see cref="MsBuildRegistration"/>) before <see cref="InitializeAsync"/>.
/// </summary>
public sealed class CSharpAdapter : IDisposable
{
    private MSBuildWorkspace? _workspace;
    private AnalysisContext? _ctx;

    public string? ProjectRoot => _ctx?.Root;

    private AnalysisContext Ctx => _ctx ?? throw new InvalidOperationException("Not initialized: call initialize first");

    public async Task<InitializeResult> InitializeAsync(string projectRoot, string? solution, CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();
        // a clear reason instead of "Could not load Microsoft.Build.Framework" later on
        if (MsBuildRegistration.Error is not null) throw new InvalidOperationException(MsBuildRegistration.Error);
        var root = Paths.ToOs(projectRoot).TrimEnd('/', '\\');
        if (!Directory.Exists(root)) throw new DirectoryNotFoundException($"Project root not found: {root}");
        _workspace?.Dispose();
        var loaded = await WorkspaceLoader.LoadAsync(root, solution, ct).ConfigureAwait(false);
        _workspace = loaded.Workspace;
        _ctx = new AnalysisContext(root, loaded.Solution);
        await _ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        sw.Stop();
        var projects = loaded.Solution.Projects.Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToList();
        var documents = loaded.Solution.Projects.Sum(p => p.DocumentIds.Count);
        Log.Info($"Loaded {projects.Count} project(s), {documents} document(s): workspace {loaded.LoadMs} ms, compilations {sw.ElapsedMilliseconds - loaded.LoadMs} ms");
        // full diagnostics are expensive: only with --verbose
        foreach (var c in Log.Verbose ? _ctx.Compilations : [])
        {
            var errors = c.GetDiagnostics(ct).Count(d => d.Severity == DiagnosticSeverity.Error);
            if (errors > 0) Log.Warn($"{c.AssemblyName}: {errors} compilation error(s) (missing references or restore?)");
        }
        return new InitializeResult(projects, documents, sw.ElapsedMilliseconds);
    }

    public async Task<MethodRef?> FindEnclosingCallableAsync(string file, Position position, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var tree = ctx.TreeAt(file);
        if (tree is null) return null;
        var model = ctx.ModelOf(tree);
        if (model is null) return null;
        var text = await tree.GetTextAsync(ct).ConfigureAwait(false);
        if (position.Line < 0 || position.Line >= text.Lines.Count) return null;
        var line = text.Lines[position.Line];
        var offset = Math.Min(line.Start + Math.Max(0, position.Character), line.End);
        var root = await tree.GetRootAsync(ct).ConfigureAwait(false);
        // at the end of a line the token to the left is meant (e.g. after a closing parenthesis)
        var token = root.FindToken(offset == line.End && offset > line.Start ? offset - 1 : offset);
        var node = token.Parent;
        if (node is null) return null;
        var m = Callables.EnclosingCallable(model, node);
        return m is null ? null : ctx.Refs.MethodRefOf(m);
    }

    public async Task<MethodRef?> GetMethodAsync(string key, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        return new SymbolResolver(ctx).Resolve(key) switch
        {
            IMethodSymbol m => ctx.Refs.MethodRefOf(m),
            ISymbol member and (IFieldSymbol or IPropertySymbol or IEventSymbol) => ctx.Refs.DelegateMemberRef(member),
            _ => null,
        };
    }

    public async Task<IReadOnlyList<CallSite>> GetOutgoingCallsAsync(string methodKey, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var m = new SymbolResolver(ctx).ResolveMethod(methodKey);
        if (m is null || !SymbolRefs.IsSource(m.ContainingType)) return [];
        return new OutgoingCalls(ctx).Of(m);
    }

    public async Task<IReadOnlyList<MethodRef>> GetImplementationsAsync(string methodKey, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var m = new SymbolResolver(ctx).ResolveMethod(methodKey);
        if (m is null) return [];
        return await new Navigation(ctx).ImplementationsAsync(m, ct).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<CallerInfo>> GetCallersAsync(string methodKey, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var m = new SymbolResolver(ctx).ResolveMethod(methodKey);
        if (m is null) return [];
        return await new Navigation(ctx).CallersAsync(m, ct).ConfigureAwait(false);
    }

    /// <summary>FR-31.1: how often the method is used as a value (stored, assigned) outside test code.</summary>
    public async Task<int> GetValueUsesAsync(string methodKey, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var m = new SymbolResolver(ctx).ResolveMethod(methodKey);
        if (m is null) return 0;
        return await new Navigation(ctx).ValueUsesAsync(m, ct).ConfigureAwait(false);
    }

    /// <summary>FR-31.1: the types declared in a file (nested ones too), each with the methods / constructors declared in that file.</summary>
    public async Task<IReadOnlyList<FileType>> GetFileTypesAsync(string file, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var tree = ctx.TreeAt(file);
        var model = tree is null ? null : ctx.ModelOf(tree);
        if (tree is null || model is null) return [];
        var root = await tree.GetRootAsync(ct).ConfigureAwait(false);
        var result = new List<FileType>();
        foreach (var decl in root.DescendantNodes().OfType<Microsoft.CodeAnalysis.CSharp.Syntax.BaseTypeDeclarationSyntax>())
        {
            if (model.GetDeclaredSymbol(decl, ct) is not INamedTypeSymbol type) continue;
            var methods = type.GetMembers().OfType<IMethodSymbol>()
                .Where(m => m.MethodKind is MethodKind.Ordinary or MethodKind.Constructor && !m.IsImplicitlyDeclared && m.DeclaringSyntaxReferences.Any(r => r.SyntaxTree == tree))
                .Select(m => ctx.Refs.MethodRefOf(m))
                .ToList();
            result.Add(new FileType(ctx.Refs.ClassRefOf(type), methods));
        }
        return result;
    }

    /// <summary>FR-31.1: the types of every regular (not generated) file of the solution with their methods, as GetFileTypesAsync per file.</summary>
    public async Task<IReadOnlyList<FileType>> GetProjectTypesAsync(CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var files = ctx.Compilations.SelectMany(c => c.SyntaxTrees).Where(ctx.IsRegularTree).Select(t => t.FilePath).Distinct(Paths.Comparer).ToList();
        var result = new List<FileType>();
        foreach (var file in files) result.AddRange(await GetFileTypesAsync(Paths.ToProtocol(file), ct).ConfigureAwait(false));
        return result;
    }

    public async Task<ClassInfo?> GetClassInfoAsync(string classKey, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var t = new SymbolResolver(ctx).ResolveType(classKey);
        return t is null ? null : new ClassInfoBuilder(ctx).Build(t);
    }

    /// <summary>FR-12.12: source types the method references (signature and body).</summary>
    public async Task<IReadOnlyList<TypeUse>> GetTypeUsesAsync(string methodKey, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var m = new SymbolResolver(ctx).ResolveMethod(methodKey);
        if (m is null || !SymbolRefs.IsSource(m.ContainingType)) return [];
        return new TypeUses(ctx).Of(m);
    }

    /// <summary>FR-7.7</summary>
    public async Task<ModuleFacts?> GetModuleFactsAsync(string classKey, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var type = new SymbolResolver(ctx).ResolveType(classKey);
        return type is null || !SymbolRefs.IsSource(type) ? null : new ModuleFactsBuilder(ctx).Of(type);
    }

    /// <summary>FR-16.1</summary>
    public async Task<IReadOnlyList<EntryPoint>> GetEntryPointsAsync(CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        return new EntryPoints(ctx).Find(ct);
    }

    /// <summary>FR-8.6 the solution's DI registrations.</summary>
    public async Task<IReadOnlyList<ContainerBinding>> GetBindingsAsync(CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        return new Bindings(ctx).Find(ct);
    }

    /// <summary>FR-8.6 the executable projects that can run the file's code (whose registrations apply to it).</summary>
    public async Task<IReadOnlyList<string>> GetHostsOfAsync(string file, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        return new Bindings(ctx).HostsOf(file);
    }

    /// <summary>FR-1.15</summary>
    public async Task<IReadOnlyList<EarlyExit>> GetEarlyExitsAsync(string methodKey, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var m = new SymbolResolver(ctx).ResolveMethod(methodKey);
        if (m is null || !SymbolRefs.IsSource(m.ContainingType)) return [];
        return EarlyExits.Of(m);
    }

    /// <summary>FR-5.8</summary>
    public async Task<IReadOnlyList<ReturnFact>> GetReturnsAsync(string methodKey, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var m = new SymbolResolver(ctx).ResolveMethod(methodKey);
        if (m is null || !SymbolRefs.IsSource(m.ContainingType)) return [];
        return Returns.Of(m);
    }

    public async Task<IReadOnlyList<string>> GetParameterNamesAsync(string methodKey, CancellationToken ct = default)
    {
        var ctx = Ctx;
        await ctx.EnsureCompilationsAsync(ct).ConfigureAwait(false);
        var m = new SymbolResolver(ctx).ResolveMethod(methodKey);
        return m is null ? [] : SymbolRefs.Canonical(m).Parameters.Select(p => p.Name).ToList();
    }

    /// <summary>Applies new content (given or re-read from disk) to the snapshot; adds / removes documents.</summary>
    public Task UpdateFileAsync(string file, string? content, CancellationToken ct = default)
    {
        var ctx = Ctx;
        var path = Paths.ToOs(file);
        if (!path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
        {
            Log.Debug($"updateFile ignored (not a C# file): {path}");
            return Task.CompletedTask;
        }
        var exists = content is not null || File.Exists(path);
        var solution = ctx.Solution;
        var ids = solution.GetDocumentIdsWithFilePath(path);
        if (!exists)
        {
            foreach (var id in ids) solution = solution.RemoveDocument(id);
            Log.Debug($"updateFile: removed {path} ({ids.Length} document(s))");
        }
        else
        {
            var text = SourceText.From(content ?? ReadAllTextShared(path), System.Text.Encoding.UTF8);
            if (ids.Length > 0)
            {
                foreach (var id in ids) solution = solution.WithDocumentText(id, text, PreservationMode.PreserveIdentity);
            }
            else if (OwningProject(solution, path) is { } project)
            {
                var folders = Path.GetRelativePath(Path.GetDirectoryName(project.FilePath!)!, Path.GetDirectoryName(path)!)
                    .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)
                    .Where(f => f != ".")
                    .ToList();
                var docId = DocumentId.CreateNewId(project.Id, path);
                solution = solution.AddDocument(DocumentInfo.Create(
                    docId,
                    Path.GetFileName(path),
                    folders,
                    SourceCodeKind.Regular,
                    TextLoader.From(TextAndVersion.Create(text, VersionStamp.Create(), path)),
                    path));
                Log.Debug($"updateFile: added {path} to {project.Name}");
            }
            else
            {
                Log.Debug($"updateFile: {path} belongs to no project");
                return Task.CompletedTask;
            }
        }
        ctx.SetSolution(solution);
        return Task.CompletedTask;
    }

    private static string ReadAllTextShared(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(fs, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    /// <summary>The C# project with the deepest directory containing the file (SDK-style globbing).</summary>
    private static Project? OwningProject(Solution solution, string path) =>
        solution.Projects
            .Where(p => p.Language == LanguageNames.CSharp && p.FilePath is not null &&
                        Paths.IsUnder(Path.GetDirectoryName(p.FilePath)!, path) &&
                        !IsUnderBinObj(Path.GetDirectoryName(p.FilePath)!, path))
            .OrderByDescending(p => Path.GetDirectoryName(p.FilePath)!.Length)
            .FirstOrDefault();

    private static bool IsUnderBinObj(string projectDir, string path)
    {
        var rel = Path.GetRelativePath(projectDir, path).Replace('\\', '/');
        return rel.StartsWith("bin/", StringComparison.OrdinalIgnoreCase) || rel.StartsWith("obj/", StringComparison.OrdinalIgnoreCase);
    }

    public void Dispose()
    {
        _workspace?.Dispose();
        _workspace = null;
        _ctx = null;
    }
}
