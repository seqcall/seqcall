using Seqcall.CSharp.Analysis;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace Seqcall.CSharp.Tests;

/// <summary>
/// Small in-memory projects for shapes the sample solution does not have: the files under a made-up root, one
/// project (<c>Shop</c>) referencing only the core library — attributes and framework interfaces are declared in
/// the snippet itself (the analysis matches them by name).
/// </summary>
public static class Snippets
{
    public const string Root = "/snippets";

    public static async Task<AnalysisContext> ContextAsync(params (string Path, string Code)[] files)
    {
        var ws = new AdhocWorkspace();
        var id = ProjectId.CreateNewId();
        var solution = ws.CurrentSolution.AddProject(ProjectInfo.Create(id, VersionStamp.Default, "Shop", "Shop", LanguageNames.CSharp,
            compilationOptions: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable),
            metadataReferences: [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)]));
        foreach (var (path, code) in files)
        {
            solution = solution.AddDocument(DocumentId.CreateNewId(id), Path.GetFileName(path), SourceText.From(code), filePath: $"{Root}/{path}");
        }
        var ctx = new AnalysisContext(Root, solution);
        await ctx.EnsureCompilationsAsync();
        return ctx;
    }
}
