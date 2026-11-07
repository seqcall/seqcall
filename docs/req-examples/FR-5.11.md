# FR-5.11 — inherited methods (C#)

```csharp
public abstract class BaseHttpClient
{
    protected Task<HttpResponseMessage> PostAsync(string path, HttpContent body) { /* … */ }
    protected HttpContent JsonBody(object value) { /* … */ }
}

public class ParcelApiClient : BaseHttpClient, IMapsApi
{
    public async Task<Route> PlanRouteAsync(RouteRequest request)
    {
        var response = await PostAsync("/routes", JsonBody(request));
        return await Read<Route>(response);
    }
}
```

In the sequence diagram `JsonBody` and `PostAsync` are self calls on `:ParcelApiClient` with a muted ↑
(*inherited: declared in BaseHttpClient*). The class diagram shows `ParcelApiClient ──▷ BaseHttpClient`, with
`PostAsync` and `JsonBody` listed in `BaseHttpClient` (behind *Show N private / protected methods*).
