namespace Sample.Core.Domain;

/// <summary>Domain entity.</summary>
public class User
{
    public User(string id, string name, string? managerId = null)
    {
        Id = id;
        Name = name;
        ManagerId = managerId;
    }

    public string Id { get; }
    public string Name { get; private set; }
    public string? ManagerId { get; }
    public bool Active { get; set; } = true;

    public void Rename(string name)
    {
        Name = name.Trim();
    }
}
