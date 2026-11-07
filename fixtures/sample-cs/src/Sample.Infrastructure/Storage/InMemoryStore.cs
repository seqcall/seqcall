using Sample.Core.Interfaces;

namespace Sample.Infrastructure.Storage;

/// <summary>Generic implementation.</summary>
public class InMemoryStore<T> : IStore<T>
{
    private readonly List<T> _items = [];

    public void Add(T item) => _items.Add(item);

    public T? Get(int index) => index < _items.Count ? _items[index] : default;
}
