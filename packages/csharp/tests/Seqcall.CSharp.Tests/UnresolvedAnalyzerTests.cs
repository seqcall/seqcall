using Seqcall.CSharp.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace Seqcall.CSharp.Tests;

/// <summary>An analyzer whose assembly is missing (packages not restored) must not break SymbolFinder (FR-8).</summary>
public sealed class UnresolvedAnalyzerTests
{
    [Fact]
    public async Task Implementations_are_found_when_an_analyzer_assembly_is_missing()
    {
        using var ws = new AdhocWorkspace();
        var project = ws.AddProject("Shop", LanguageNames.CSharp)
            .WithMetadataReferences([MetadataReference.CreateFromFile(typeof(object).Assembly.Location)])
            .AddAnalyzerReference(new UnresolvedAnalyzerReference("/missing/Shop.Analyzers.dll"));
        var doc = project.AddDocument("Orders.cs", SourceText.From(
            "interface IOrders { void Place(); } class Orders : IOrders { public void Place() {} }"));
        var solution = doc.Project.Solution;
        var place = (await doc.Project.GetCompilationAsync())!.GetTypeByMetadataName("IOrders")!.GetMembers("Place").Single();

        await Assert.ThrowsAnyAsync<InvalidOperationException>(() => SymbolFinder.FindImplementationsAsync(place, solution));

        var cleaned = WorkspaceLoader.WithoutUnresolvedAnalyzers(solution);
        Assert.Empty(cleaned.Projects.Single().AnalyzerReferences);
        var impl = Assert.Single(await SymbolFinder.FindImplementationsAsync(place, cleaned));
        Assert.Equal("Orders", impl.ContainingType.Name);
    }
}
