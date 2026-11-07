namespace Sample.Core.Domain;

/// <summary>FR-5.12 values: a result built by static factories, a price that builds new prices, and three that are not.</summary>
public class Outcome
{
    private readonly string? _error;

    protected Outcome(string? error) => _error = error;

    public bool IsOk => _error is null;

    public static Outcome Ok() => new(null);

    public static Outcome Fail(string error) => new(error);
}

public class Outcome<T> : Outcome
{
    private readonly T _value;

    private Outcome(T value, string? error) : base(error) => _value = value;

    public T Value => _value;

    public static Outcome<T> Ok(T value) => new(value, null);

    public static new Outcome<T> Fail(string error) => new(default!, error);
}

public sealed record Price(decimal Amount, string Currency)
{
    public Price Add(Price other) => new(Amount + other.Amount, Currency);
}

/// <summary>Not values: a setter, a list that can change, a lifetime.</summary>
public record Draft
{
    public string Name { get; set; } = "";

    public string Describe() => Name;
}

public sealed class Basket
{
    public List<Price> Items { get; } = [];
}

public sealed class Ticket : IDisposable
{
    private readonly string _id;

    public Ticket(string id) => _id = id;

    public void Dispose() { }
}
