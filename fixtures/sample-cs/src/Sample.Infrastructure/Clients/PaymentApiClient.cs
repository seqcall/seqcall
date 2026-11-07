using System.Net.Http.Json;
using Sample.Core.Domain;
using Sample.Core.Interfaces;
using Sample.Infrastructure.Logging;

namespace Sample.Infrastructure.Clients;

/// <summary>API client (adapter) over HttpClient.</summary>
public class PaymentApiClient : IPaymentClient
{
    private readonly HttpClient _http;

    public PaymentApiClient(HttpClient http)
    {
        _http = http ?? throw new ArgumentNullException(nameof(http));
    }

    public async Task<bool> ChargeAsync(Order order)
    {
        Logger.Info($"charging {order.Id}");
        var response = await _http.PostAsJsonAsync("/charges", order);
        return response.IsSuccessStatusCode;
    }
}
