using Seqcall.CSharp.Analysis;

namespace Seqcall.CSharp.Tests;

/// <summary>
/// FR-7.15 a type whose own code only holds data (fields, auto-properties, plain getters / setters, constructors that
/// only store values, constants) is data; any logic makes it behaviour.
/// </summary>
public sealed class DataOnlyTests
{
    private const string Shop = """
        public enum Kind { A, B }
        public interface IShape { int Id { get; } }
        public interface IPriced { int Price(); }
        public delegate void Done();
        public class Line
        {
            private int _qty;
            private string _name = "";
            public int Id { get; init; }
            public int Qty { get => _qty; set => _qty = value; }
            public string Name { get { return _name; } set { _name = value; } }
            public Kind Kind { get; set; } = Kind.A;
            public int Offset { get; } = -1;
            public int[] Codes { get; } = [];
            public object Tag { get; set; } = new();
            public int Size => (this._qty);
            public Line() { }
            public Line(int qty) : base() { _qty = qty; this.Id = default; }
            public Line WithName(string n) { _name = n; return this; }
            public void SetQty(int q) => _qty = q;
            public string Label() { return _name; }
            public void Reset() { return; }
        }
        public class Base { public Base(int a) { } }
        public class Child : Base { public Child(int a) : base(a + 1) { } }
        public class Arrow { private int _a; public Arrow(int a) => _a = a; }
        public class ArrowCall { private int _a; public ArrowCall(int a) => System.Console.WriteLine(a); }
        public class Checked { private int _a; public Checked(int a) { if (a < 0) _a = 0; } }
        public class Twice { private int _a; public void Set(int a) { _a = a; _a = a; } }
        public class Three { private int _a; public void Set(int a) { _a = a; return; } }
        public class Bad { private int _a; public void Set(int a) { _a += a; } }
        public class Neg { private bool _a; public bool A => !_a; }
        public class Filled { public int[] A { get; } = [1]; public object B { get; } = new object(); public object C { get; } = new Line(1); private int _d = 2; }
        public class Computed { public int A { get; } = System.Math.Abs(-1); }
        public class ComputedField { private int _a = System.Math.Abs(-1); }
        public class Spread { public int[] A { get; } = [.. new[] { 1 }]; }
        public class Built { public Line A { get; } = new Line { Id = 1 }; }
        public class Call { public int A => System.Math.Abs(1); }
        public class Empty { public void Run() { } }
        public class Events { public event Done? Finished; }
        public class Ops { public static Ops operator +(Ops a, Ops b) => a; }
        public class Nested { public class Inner { } public int A { get; set; } }
        public abstract class Abstract { public abstract int A(); }
        """;

    [Theory]
    [InlineData("Kind", null)] // an enum is domain vocabulary, not a data shape
    [InlineData("IShape", true)]
    [InlineData("IPriced", null)]
    [InlineData("Done", null)]
    [InlineData("Line", true)]
    [InlineData("Base", true)]
    [InlineData("Child", null)] // base(a + 1)
    [InlineData("Arrow", true)]
    [InlineData("ArrowCall", null)]
    [InlineData("Checked", null)]
    [InlineData("Twice", null)]
    [InlineData("Three", null)]
    [InlineData("Bad", null)]
    [InlineData("Neg", null)]
    [InlineData("Filled", true)]
    [InlineData("Computed", null)]
    [InlineData("ComputedField", null)]
    [InlineData("Spread", null)]
    [InlineData("Built", null)]
    [InlineData("Call", null)]
    [InlineData("Empty", null)]
    [InlineData("Events", null)]
    [InlineData("Ops", null)]
    [InlineData("Nested", true)]
    [InlineData("Abstract", null)]
    public async Task FR_7_15_types_that_only_hold_data(string type, bool? dataOnly)
    {
        var ctx = await Snippets.ContextAsync(("src/Shop.cs", Shop));
        var symbol = ctx.Compilations.Select(c => c.GetTypeByMetadataName(type)).First(t => t is not null)!;
        Assert.Equal(dataOnly, new ClassInfoBuilder(ctx).Build(symbol).DataOnly);
    }
}
