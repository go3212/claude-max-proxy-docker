using System.Net;
using System.Text;
using System.Text.Json;

namespace ClaudeSuscriptionClient.Tests;

internal sealed class RecordingHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;

    public RecordingHttpMessageHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
    {
        _handler = handler;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        _handler(request, cancellationToken);
}

internal sealed class InMemoryCredentialStore : IClaudeOAuthCredentialStore
{
    private ClaudeOAuthSnapshot _snapshot;

    public InMemoryCredentialStore(ClaudeOAuthSnapshot snapshot)
    {
        _snapshot = snapshot;
    }

    public int GetCount { get; private set; }

    public int SaveCount { get; private set; }

    public Task<ClaudeOAuthSnapshot> GetAsync(CancellationToken cancellationToken)
    {
        GetCount++;
        return Task.FromResult(_snapshot);
    }

    public Task SaveAsync(ClaudeOAuthSnapshot snapshot, CancellationToken cancellationToken)
    {
        SaveCount++;
        _snapshot = snapshot;
        return Task.CompletedTask;
    }

    public ClaudeOAuthSnapshot Current => _snapshot;
}

internal static class TestJson
{
    public static JsonElement Parse(string raw) => JsonDocument.Parse(raw).RootElement.Clone();
}

internal static class TestResponses
{
    public static HttpResponseMessage Json(HttpStatusCode statusCode, string json, string contentType = "application/json") =>
        new(statusCode)
        {
            Content = new StringContent(json, Encoding.UTF8, contentType)
        };
}
