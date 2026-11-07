using System.Threading.Tasks.Dataflow;
using Sample.Core.Domain;
using Sample.Core.Interfaces;
using Sample.Core.Util;

namespace Sample.Core.Services;

/// <summary>FR-17.7 work handed to a dataflow block: its lambda (or method) runs later, with the posted item.</summary>
public class AuditQueue
{
    private readonly IUserRepository _repo;
    private readonly ActionBlock<User> _saves;
    private readonly ActionBlock<User> _audits;

    public AuditQueue(IUserRepository repo)
    {
        _repo = repo;
        _saves = new ActionBlock<User>(
            async user =>
            {
                await repo.SaveAsync(user);
                Format.Title(user.Name);
            },
            new ExecutionDataflowBlockOptions { MaxDegreeOfParallelism = 1 });
        _audits = new ActionBlock<User>(WriteAuditAsync);
    }

    public bool Enqueue(User user)
    {
        Format.Title("queued");
        return _saves.Post(user);
    }

    public Task<bool> AuditAsync(User user) => _audits.SendAsync(user);

    private Task WriteAuditAsync(User user) => _repo.SaveAsync(user);
}
