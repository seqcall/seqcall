using Sample.Core.Domain;
using Sample.Core.Util;

namespace Sample.Core.Services;

/// <summary>Calls members of C# 14 extension blocks (instance, static, generic).</summary>
public class ExportService
{
    public UserDto Export(IReadOnlyList<User> users)
    {
        var first = users.FirstOrNone() ?? User.Guest();
        return first.ToDto();
    }
}
