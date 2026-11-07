using System.Text.RegularExpressions;
using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Seqcall.CSharp.Analysis;

/// <summary>
/// Combined fragments (FR-1.10): the control-flow constructs of the analysed body that enclose a
/// call, outermost first. Walks from the call up to the enclosing member / local function, or the
/// lambda whose body the call is in (the collector prepends the lambda's own scopes, FR-1.11).
/// </summary>
public static partial class FragmentScopes
{
    public static IReadOnlyList<FragmentScope>? Of(SyntaxNode call)
    {
        var scopes = new List<FragmentScope>();
        var child = call;
        for (var n = call.Parent; n is not null && !IsBoundary(n); child = n, n = n.Parent)
        {
            var scope = ScopeOf(n, child);
            if (scope is { Kind: "loop" } && n is ForStatementSyntax or CommonForEachStatementSyntax or WhileStatementSyntax or DoStatementSyntax && LeavesLoop(call, n))
                scope = scope with { LeavesLoop = true };
            if (scope is not null) scopes.Add(scope);
        }
        if (scopes.Count == 0) return null;
        scopes.Reverse();
        return scopes;
    }

    /// <summary>LINQ / list methods whose lambda runs once per element (FR-1.11).</summary>
    private static readonly HashSet<string> Iteration =
    [
        "Select", "SelectMany", "Where", "Any", "All", "First", "FirstOrDefault", "Last", "LastOrDefault",
        "Single", "SingleOrDefault", "Count", "LongCount", "Sum", "Min", "Max", "MinBy", "MaxBy", "Average",
        "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending", "GroupBy", "ToDictionary", "ToLookup",
        "ForEach", "Aggregate", "TakeWhile", "SkipWhile", "DistinctBy", "Find", "FindAll", "FindIndex",
        "FindLast", "Exists", "TrueForAll", "RemoveAll", "ConvertAll",
    ];

    /// <summary>
    /// FR-1.11: scope of the calls inside a lambda passed to a library method — <c>loop</c> for LINQ /
    /// list iteration (<c>each u in users</c>), <c>callback</c> otherwise (<c>[task.ContinueWith]</c>).
    /// </summary>
    public static FragmentScope LambdaScope(SyntaxNode call, AnonymousFunctionExpressionSyntax lambda)
    {
        var range = RangeOf(lambda.SyntaxTree, lambda.SpanStart, lambda.Body.SpanStart);
        var id = $"cb@{lambda.SpanStart}";
        if (call is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } && Iteration.Contains(ma.Name.Identifier.ValueText))
        {
            var ps = ParameterNames(lambda);
            var element = ma.Name.Identifier.ValueText == "Aggregate" && ps.Count > 1 ? ps[1] : ps.Count > 0 ? ps[0] : null;
            var collection = ChainText(ma.Expression);
            return new FragmentScope(id, "loop", 0, element is null ? $"each in {collection}" : $"each {element} in {collection}", null, range);
        }
        var target = call switch
        {
            InvocationExpressionSyntax inv => ChainText(inv.Expression),
            BaseObjectCreationExpressionSyntax c => $"new {(c is ObjectCreationExpressionSyntax o ? Text(o.Type) : "")}".Trim(),
            _ => Text(call),
        };
        return new FragmentScope(id, "callback", 0, target, null, range);
    }

    /// <summary>FR-17.7 the calls of the lambda a dataflow block runs later for <c>block.Post(x)</c>: <c>[later: _block]</c>.</summary>
    public static FragmentScope HandOffScope(SyntaxNode call, ExpressionSyntax runs, string block) =>
        new($"handoff@{call.SpanStart}@{runs.SpanStart}", "callback", 0, $"later: {block}", null,
            runs is AnonymousFunctionExpressionSyntax lambda ? RangeOf(lambda.SyntaxTree, lambda.SpanStart, lambda.Body.SpanStart) : RangeOf(runs));

    public static IReadOnlyList<string> ParameterNames(AnonymousFunctionExpressionSyntax lambda) => lambda switch
    {
        SimpleLambdaExpressionSyntax s => [s.Parameter.Identifier.ValueText],
        ParenthesizedLambdaExpressionSyntax p => p.ParameterList.Parameters.Select(x => x.Identifier.ValueText).ToList(),
        AnonymousMethodExpressionSyntax a => a.ParameterList?.Parameters.Select(x => x.Identifier.ValueText).ToList() ?? [],
        _ => [],
    };

    /// <summary><c>users.Where(…).Select</c>: a call chain with argument lists collapsed.</summary>
    private static string ChainText(ExpressionSyntax e) => e switch
    {
        InvocationExpressionSyntax i => $"{ChainText(i.Expression)}({(i.ArgumentList.Arguments.Count == 0 ? "" : "…")})",
        MemberAccessExpressionSyntax m => $"{ChainText(m.Expression)}.{m.Name.Identifier.ValueText}",
        _ => Text(e),
    };

    private static bool IsBoundary(SyntaxNode n) =>
        n is MemberDeclarationSyntax or AccessorDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax;

    private static string Text(SyntaxNode n) => SymbolRefs.CompactText(n);

    private static SourceRange? RangeOf(SyntaxNode n) => SymbolRefs.Range(n);

    private static SourceRange? RangeOf(SyntaxTree tree, int start, int end) => SymbolRefs.Range(tree, TextSpan.FromBounds(start, end));

    /// <summary>Negation for display: <c>!x</c>, <c>!a.B()</c>, otherwise <c>!(…)</c>.</summary>
    public static string Negate(string guard)
    {
        if (NegatedName().IsMatch(guard)) return LeadingNot().Replace(guard, "");
        return NameOrCall().IsMatch(guard) ? $"!{guard}" : $"!({guard})";
    }

    private static FragmentScope? ScopeOf(SyntaxNode n, SyntaxNode child)
    {
        switch (n)
        {
            case IfStatementSyntax ifs:
                {
                    var (head, index) = IfHead(ifs);
                    var conditions = IfConditions(head, out var hasElse);
                    if (child == ifs.Condition) return index == 0 ? null : Chain("if", head, conditions, hasElse, index, null);
                    if (child == ifs.Statement) return Chain("if", head, conditions, hasElse, index, null);
                    if (child == ifs.Else && ifs.Else.Statement is not IfStatementSyntax)
                        return Chain("if", head, conditions, hasElse, index + 1, ifs.Else.ElseKeyword.Span);
                    return null; // else-if: the inner link reports the scope
                }
            case ConditionalExpressionSyntax ce:
                {
                    var (head, index) = ConditionalHead(ce);
                    var conditions = ConditionalConditions(head);
                    if (child == ce.Condition) return index == 0 ? null : Chain("cond", head, conditions, true, index, null);
                    if (child == ce.WhenTrue) return Chain("cond", head, conditions, true, index, null);
                    if (child == ce.WhenFalse && Unparen(ce.WhenFalse) is not ConditionalExpressionSyntax)
                        return Chain("cond", head, conditions, true, index + 1, ce.ColonToken.Span);
                    return null;
                }
            case SwitchSectionSyntax section when section.Parent is SwitchStatementSyntax sw:
                return SwitchSection(sw, section);
            case SwitchExpressionArmSyntax arm when arm.Parent is SwitchExpressionSyntax se && child == arm.Expression:
                return SwitchArm(se, arm);
            case ForStatementSyntax f:
                if (f.Declaration is not null && child == f.Declaration) return null;
                if (f.Initializers.Contains(child)) return null;
                return Loop(f, f.Condition is null ? null : Text(f.Condition), f.Condition is null ? null : RangeOf(f.Condition));
            case CommonForEachStatementSyntax fe:
                {
                    if (child != fe.Statement) return null;
                    var variable = fe switch
                    {
                        ForEachStatementSyntax s => s.Identifier.ValueText,
                        ForEachVariableStatementSyntax v => Text(v.Variable),
                        _ => "item",
                    };
                    return Loop(fe, $"each {variable} in {Text(fe.Expression)}", RangeOf(fe.SyntaxTree, fe.ForEachKeyword.SpanStart, fe.CloseParenToken.Span.End));
                }
            case WhileStatementSyntax w:
                return Loop(w, Text(w.Condition), RangeOf(w.Condition));
            case DoStatementSyntax d:
                return Loop(d, Text(d.Condition), RangeOf(d.Condition));
            case TryStatementSyntax t:
                {
                    var id = $"try@{t.SpanStart}";
                    var handlers = CatchHandlers(t);
                    if (child == t.Block) return new FragmentScope(id, "try", 0, null, null, RangeOf(t.SyntaxTree, t.TryKeyword.SpanStart, t.TryKeyword.Span.End), handlers);
                    if (child is CatchClauseSyntax c)
                        return new FragmentScope(id, "try", 1 + t.Catches.IndexOf(c), CatchGuard(c), null, RangeOf(t.SyntaxTree, c.SpanStart, c.Block.SpanStart), handlers);
                    return null; // finally always runs
                }
        }
        return null;
    }

    private static string CatchGuard(CatchClauseSyntax c)
    {
        var guard = c.Declaration is null ? "catch" : $"catch {Text(c.Declaration.Type)}";
        return c.Filter is null ? guard : $"{guard} when {Text(c.Filter.FilterExpression)}";
    }

    /// <summary>A logging call: <c>_logger.LogError</c>, <c>Log.Warning</c>, <c>Console.Error.WriteLine</c> (same rule as core's catch-outcome.ts).</summary>
    [GeneratedRegex(@"^([Ll]og([A-Z]\w*)?|[Ww]arn(ing)?|[Ee]rror|[Ii]nfo(rmation)?|[Dd]ebug|[Tt]race|[Cc]ritical|[Ff]atal|[Aa]lert|[Ee]mergency|[Nn]otice|report|[Cc]apture(Exception|Message))$", RegexOptions.None, RegexTimeoutMs)]
    private static partial Regex LogMethod();

    /// <summary><c>_logger</c>, <c>log</c>, <c>Log</c>, <c>_auditLogger</c> — not <c>catalog</c>.</summary>
    [GeneratedRegex(@"^_?log(ger)?$|Logger$", RegexOptions.IgnoreCase, RegexTimeoutMs)]
    private static partial Regex LogReceiver();

    /// <summary>Upper bound for one regex match on code text (S6444); the inputs are names and short expressions.</summary>
    private const int RegexTimeoutMs = 1000;

    [GeneratedRegex(@"\s+", RegexOptions.None, RegexTimeoutMs)]
    private static partial Regex Whitespace();

    [GeneratedRegex(@"^!\s*[\w.]+$", RegexOptions.None, RegexTimeoutMs)]
    private static partial Regex NegatedName();

    [GeneratedRegex(@"^!\s*", RegexOptions.None, RegexTimeoutMs)]
    private static partial Regex LeadingNot();

    [GeneratedRegex(@"^[\w.]+(\(\))?$", RegexOptions.None, RegexTimeoutMs)]
    private static partial Regex NameOrCall();

    private static bool IsLogCall(InvocationExpressionSyntax inv)
    {
        if (inv.Expression is MemberAccessExpressionSyntax ma)
        {
            var receiver = ma.Expression is MemberAccessExpressionSyntax inner ? inner.Name.Identifier.ValueText : Text(ma.Expression);
            return LogMethod().IsMatch(ma.Name.Identifier.ValueText) || LogReceiver().IsMatch(receiver) || receiver == "Error";
        }
        return inv.Expression is IdentifierNameSyntax id && LogMethod().IsMatch(id.Identifier.ValueText);
    }

    /// <summary>FR-1.17 what each catch clause does with the error (statements inside lambdas / local functions do not count).</summary>
    private static List<CatchHandler>? CatchHandlers(TryStatementSyntax t)
    {
        if (t.Catches.Count == 0) return null;
        return t.Catches.Select((c, i) =>
        {
            var outcome = "swallow";
            string? value = null;
            var logged = false;
            foreach (var n in c.Block.DescendantNodes(x => x is not AnonymousFunctionExpressionSyntax and not LocalFunctionStatementSyntax))
            {
                switch (n)
                {
                    case ThrowStatementSyntax or ThrowExpressionSyntax:
                        outcome = "rethrow";
                        break;
                    case ReturnStatementSyntax r when outcome != "rethrow":
                        outcome = "return";
                        value ??= r.Expression is null ? null : Compact(Text(r.Expression));
                        break;
                    case ContinueStatementSyntax when outcome == "swallow":
                        outcome = "skip";
                        break;
                    case InvocationExpressionSyntax inv when IsLogCall(inv):
                        logged = true;
                        break;
                }
            }
            return new CatchHandler(i + 1, CatchGuard(c), outcome, value, logged, RangeOf(t.SyntaxTree, c.SpanStart, c.Block.SpanStart));
        }).ToList();
    }

    private static string Compact(string text, int max = 40)
    {
        var one = Whitespace().Replace(text, " ").Trim();
        return one.Length > max ? one[..(max - 1)] + "…" : one;
    }

    private static ExpressionSyntax Unparen(ExpressionSyntax e)
    {
        while (e is ParenthesizedExpressionSyntax p) e = p.Expression;
        return e;
    }

    // ───────────── if / else-if / else chains and nested ?: ─────────────

    private static (IfStatementSyntax Head, int Index) IfHead(IfStatementSyntax n)
    {
        var index = 0;
        while (n.Parent is ElseClauseSyntax { Parent: IfStatementSyntax outer })
        {
            n = outer;
            index++;
        }
        return (n, index);
    }

    private static List<ExpressionSyntax> IfConditions(IfStatementSyntax head, out bool hasElse)
    {
        var conditions = new List<ExpressionSyntax>();
        hasElse = false;
        StatementSyntax? link = head;
        while (link is IfStatementSyntax ifs)
        {
            conditions.Add(ifs.Condition);
            link = ifs.Else?.Statement;
            if (link is not null and not IfStatementSyntax) hasElse = true;
        }
        return conditions;
    }

    private static (ConditionalExpressionSyntax Head, int Index) ConditionalHead(ConditionalExpressionSyntax n)
    {
        var index = 0;
        while (true)
        {
            SyntaxNode? p = n.Parent;
            while (p is ParenthesizedExpressionSyntax) p = p.Parent;
            if (p is ConditionalExpressionSyntax outer && Unparen(outer.WhenFalse) == n)
            {
                n = outer;
                index++;
                continue;
            }
            return (n, index);
        }
    }

    private static List<ExpressionSyntax> ConditionalConditions(ConditionalExpressionSyntax head)
    {
        var conditions = new List<ExpressionSyntax>();
        ExpressionSyntax link = head;
        while (Unparen(link) is ConditionalExpressionSyntax c)
        {
            conditions.Add(c.Condition);
            link = c.WhenFalse;
        }
        return conditions;
    }

    private static FragmentScope Chain(string prefix, SyntaxNode head, List<ExpressionSyntax> conditions, bool hasElse, int operand, TextSpan? elseSpan)
    {
        var kind = conditions.Count == 1 && !hasElse ? "opt" : "alt";
        var id = $"{prefix}@{head.SpanStart}";
        if (operand < conditions.Count)
        {
            var cond = conditions[operand];
            return new FragmentScope(id, kind, operand, Text(cond), null, RangeOf(cond));
        }
        var span = elseSpan ?? new TextSpan(head.SpanStart, 0);
        var negated = conditions.Count == 1 ? Negate(Text(conditions[0])) : null;
        return new FragmentScope(id, kind, operand, "else", negated, RangeOf(head.SyntaxTree, span.Start, span.End));
    }

    // ───────────── switch ─────────────

    private static FragmentScope SwitchSection(SwitchStatementSyntax sw, SwitchSectionSyntax section)
    {
        var hasDefault = sw.Sections.Any(s => s.Labels.Any(l => l is DefaultSwitchLabelSyntax));
        var kind = sw.Sections.Count == 1 && !hasDefault ? "opt" : "alt";
        var disc = Text(sw.Expression);
        string guard;
        if (section.Labels.Any(l => l is DefaultSwitchLabelSyntax)) guard = "else";
        else if (section.Labels.All(l => l is CaseSwitchLabelSyntax)) guard = $"{disc} = {string.Join(" | ", section.Labels.Select(l => Text(((CaseSwitchLabelSyntax)l).Value)))}";
        else guard = string.Join(" | ", section.Labels.Select(l => LabelGuard(disc, l)));
        var first = section.Labels.FirstOrDefault();
        var range = first is null ? RangeOf(section) : RangeOf(sw.SyntaxTree, first.SpanStart, first.ColonToken.SpanStart);
        return new FragmentScope($"switch@{sw.SpanStart}", kind, sw.Sections.IndexOf(section), guard, null, range);
    }

    private static string LabelGuard(string disc, SwitchLabelSyntax label) => label switch
    {
        CaseSwitchLabelSyntax c => $"{disc} = {Text(c.Value)}",
        CasePatternSwitchLabelSyntax p => PatternGuard(disc, p.Pattern) + (p.WhenClause is null ? "" : $" when {Text(p.WhenClause.Condition)}"),
        _ => "else",
    };

    private static string PatternGuard(string disc, PatternSyntax pattern) =>
        pattern is ConstantPatternSyntax c ? $"{disc} = {Text(c.Expression)}" : $"{disc} is {Text(pattern)}";

    private static FragmentScope SwitchArm(SwitchExpressionSyntax se, SwitchExpressionArmSyntax arm)
    {
        var disc = Text(se.GoverningExpression);
        var hasDiscard = se.Arms.Any(a => a.Pattern is DiscardPatternSyntax);
        var kind = se.Arms.Count == 1 && !hasDiscard ? "opt" : "alt";
        var guard = arm.Pattern is DiscardPatternSyntax ? "else" : PatternGuard(disc, arm.Pattern);
        if (arm.WhenClause is not null) guard += $" when {Text(arm.WhenClause.Condition)}";
        return new FragmentScope($"switch@{se.SpanStart}", kind, se.Arms.IndexOf(arm), guard, null, RangeOf(se.SyntaxTree, arm.SpanStart, arm.EqualsGreaterThanToken.SpanStart));
    }

    // ───────────── loops ─────────────

    /// <summary>
    /// FR-19.1 the call runs at most once per loop: its statement (in the innermost block below the loop) is a
    /// <c>return</c> / <c>throw</c>, or one follows it in that block before a <c>continue</c> / <c>break</c>.
    /// </summary>
    private static bool LeavesLoop(SyntaxNode call, SyntaxNode loop)
    {
        static bool Exits(SyntaxNode s) => s is ReturnStatementSyntax or ThrowStatementSyntax;
        for (var n = call.Parent; n is not null && n != loop; n = n.Parent)
            if (Exits(n)) return true; // `if (x) return F();`
        var child = call;
        for (var n = call.Parent; n is not null && n != loop; child = n, n = n.Parent)
        {
            SyntaxList<StatementSyntax>? list = n switch { BlockSyntax b => b.Statements, SwitchSectionSyntax s => s.Statements, _ => null };
            if (list is not { } statements) continue;
            if (child is not StatementSyntax statement) return false;
            var i = statements.IndexOf(statement);
            if (i < 0) return false;
            for (var k = i; k < statements.Count; k++)
            {
                if (Exits(statements[k])) return true;
                if (k > i && statements[k] is ContinueStatementSyntax or BreakStatementSyntax) return false;
            }
            return false;
        }
        return false;
    }

    private static FragmentScope Loop(SyntaxNode loop, string? guard, SourceRange? range) =>
        new($"loop@{loop.SpanStart}", "loop", 0, guard, null, range ?? RangeOf(loop.SyntaxTree, loop.SpanStart, loop.SpanStart));
}
