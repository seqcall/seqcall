using Sample.Core.Domain;
using Sample.Core.Util;

namespace Sample.Core.Services;

/// <summary>Partial class, part 2.</summary>
public partial class ReportService
{
    private string Header(UserDto dto) => Format.Title(dto.DisplayName);

    private string Lines()
    {
        var first = _orders.Get(0);
        return first is null ? string.Empty : Format.Money(first.WithVat());
    }
}
