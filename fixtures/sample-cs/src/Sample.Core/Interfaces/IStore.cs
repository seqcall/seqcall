namespace Sample.Core.Interfaces;

/// <summary>Generic port.</summary>
public interface IStore<T>
{
    void Add(T item);

    T? Get(int index);
}
