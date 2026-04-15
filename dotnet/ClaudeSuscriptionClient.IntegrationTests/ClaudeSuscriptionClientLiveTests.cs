using FluentAssertions;

namespace ClaudeSuscriptionClient.IntegrationTests;

public sealed class ClaudeSuscriptionClientLiveTests
{
    [Fact]
    [Trait("Category", "Live")]
    public async Task SendMessageAsync_WithLocalClaudeCredentials_ReturnsARealResponse()
    {
        if (!ShouldRunLiveTests(out var credentialsPath))
        {
            return;
        }

        using var httpClient = new HttpClient();
        var sut = new ClaudeSuscriptionClient(httpClient, new ClaudeCliFileCredentialStore(credentialsPath));

        var response = await sut.SendMessageAsync(new ClaudeMessageRequest
        {
            Model = ResolveLiveModel(),
            Messages = new[] { ClaudeMessage.UserText("Reply with exactly OK.") }
        });

        response.Content.Should().NotBeEmpty();
        response.Metadata.RequestId.Should().NotBeNullOrWhiteSpace();
        response.Usage.Should().NotBeNull();
        response.Content
            .Where(block => block.Type == ClaudeContentBlockType.Text)
            .Select(block => block.Text)
            .Should()
            .Contain(text => !string.IsNullOrWhiteSpace(text));
    }

    [Fact]
    [Trait("Category", "Live")]
    public async Task StreamMessageAsync_WithLocalClaudeCredentials_StreamsAndCompletes()
    {
        if (!ShouldRunLiveTests(out var credentialsPath))
        {
            return;
        }

        using var httpClient = new HttpClient();
        var sut = new ClaudeSuscriptionClient(httpClient, new ClaudeCliFileCredentialStore(credentialsPath));
        var events = new List<ClaudeStreamEvent>();

        await foreach (var item in sut.StreamMessageAsync(new ClaudeMessageRequest
                       {
                           Model = ResolveLiveModel(),
                           Messages = new[] { ClaudeMessage.UserText("Reply with exactly OK.") }
                       }))
        {
            events.Add(item);
        }

        events.Should().NotBeEmpty();
        events[^1].EventType.Should().Be(ClaudeStreamEventType.Completed);
        events[^1].Metadata.Should().NotBeNull();
    }

    private static bool ShouldRunLiveTests(out string credentialsPath)
    {
        credentialsPath = ClaudeCliFileCredentialStore.ResolveDefaultPath();
        return string.Equals(Environment.GetEnvironmentVariable("CLAUDE_LIVE_TESTS"), "1", StringComparison.Ordinal) &&
               File.Exists(credentialsPath);
    }

    private static string ResolveLiveModel() =>
        Environment.GetEnvironmentVariable("CLAUDE_LIVE_TEST_MODEL")?.Trim() switch
        {
            { Length: > 0 } value => value,
            _ => "claude-sonnet-4-5-20250929"
        };
}
