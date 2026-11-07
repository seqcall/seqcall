using Sample.Core.Domain;

namespace Sample.Core.Util;

/// <summary>C# 14 extension blocks: the members belong to this static class, like classic extension methods.</summary>
public static class UserExtensions
{
    extension(User user)
    {
        public UserDto ToDto() => new(user.Id, Format.Title(user.Name), user.Name.Slugify());

        public static User Guest() => new("guest", "Guest");
    }

    extension<T>(IReadOnlyList<T> items)
    {
        public T? FirstOrNone() => items.Count > 0 ? items[0] : default;
    }
}
