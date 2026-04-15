using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudeSuscriptionClient.IntegrationTests;

internal sealed class ClaudeCliFileCredentialStore : IClaudeOAuthCredentialStore
{
    private readonly string _path;

    public ClaudeCliFileCredentialStore(string path)
    {
        _path = path;
    }

    public async Task<ClaudeOAuthSnapshot> GetAsync(CancellationToken cancellationToken)
    {
        var node = await ReadNodeAsync(cancellationToken);
        var root = node.AsObject();
        var oauth = root["claudeAiOauth"]?.AsObject()
            ?? throw new InvalidOperationException($"Missing claudeAiOauth in {_path}.");

        return new ClaudeOAuthSnapshot
        {
            AccessToken = oauth["accessToken"]?.GetValue<string>() ?? throw new InvalidOperationException("Missing access token."),
            RefreshToken = oauth["refreshToken"]?.GetValue<string>() ?? throw new InvalidOperationException("Missing refresh token."),
            ExpiresAtUtc = DateTimeOffset.FromUnixTimeMilliseconds(oauth["expiresAt"]?.GetValue<long>() ?? throw new InvalidOperationException("Missing expiresAt.")),
            Scopes = oauth["scopes"] is JsonArray scopes
                ? scopes.Select(static value => value?.GetValue<string>() ?? string.Empty).Where(static value => !string.IsNullOrWhiteSpace(value)).ToArray()
                : Array.Empty<string>(),
            SubscriptionType = oauth["subscriptionType"]?.GetValue<string>(),
            RateLimitTier = oauth["rateLimitTier"]?.GetValue<string>(),
            OrganizationUuid = root["organizationUuid"]?.GetValue<string>()
        };
    }

    public async Task SaveAsync(ClaudeOAuthSnapshot snapshot, CancellationToken cancellationToken)
    {
        var node = await ReadNodeAsync(cancellationToken);
        var root = node.AsObject();
        var oauth = root["claudeAiOauth"] as JsonObject ?? new JsonObject();
        root["claudeAiOauth"] = oauth;

        oauth["accessToken"] = snapshot.AccessToken;
        oauth["refreshToken"] = snapshot.RefreshToken;
        oauth["expiresAt"] = snapshot.ExpiresAtUtc.ToUnixTimeMilliseconds();
        oauth["subscriptionType"] = snapshot.SubscriptionType;
        oauth["rateLimitTier"] = snapshot.RateLimitTier;
        oauth["scopes"] = new JsonArray(snapshot.Scopes.Select(static value => (JsonNode?)JsonValue.Create(value)).ToArray());
        root["organizationUuid"] = snapshot.OrganizationUuid;

        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        await File.WriteAllTextAsync(_path, node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), cancellationToken);
    }

    private async Task<JsonNode> ReadNodeAsync(CancellationToken cancellationToken)
    {
        var raw = await File.ReadAllTextAsync(_path, cancellationToken);
        return JsonNode.Parse(raw) ?? throw new InvalidOperationException($"Failed to parse {_path}.");
    }

    public static string ResolveDefaultPath()
    {
        var explicitPath = Environment.GetEnvironmentVariable("CLAUDE_CREDENTIALS_PATH");
        if (!string.IsNullOrWhiteSpace(explicitPath))
        {
            return explicitPath;
        }

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(home, ".claude", ".credentials.json");
    }
}
