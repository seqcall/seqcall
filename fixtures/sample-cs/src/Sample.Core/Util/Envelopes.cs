using Sample.Core.Domain;

namespace Sample.Core.Util;

/// <summary>FR-5.9: a generic wrapper created through a type parameter (`new TEnvelope { … }`).</summary>
public abstract class Envelope<T>
{
    public T? Data { get; init; }
}

public class OrderEnvelope : Envelope<Order>
{
}

public static class EnvelopeExtensions
{
    public static TEnvelope Wrap<TData, TEnvelope>(this TData data)
        where TEnvelope : Envelope<TData>, new()
    {
        return new TEnvelope { Data = data };
    }

    /// <summary>Passes its own type parameters on.</summary>
    public static TEnvelope WrapVia<TData, TEnvelope>(this TData data)
        where TEnvelope : Envelope<TData>, new()
    {
        return data.Wrap<TData, TEnvelope>();
    }
}
