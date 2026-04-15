using System.Net;
using System.Text;
using System.Text.Json;
using FluentAssertions;

namespace ClaudeSuscriptionClient.Tests;

public sealed class ClaudeSuscriptionClientTests
{
    [Fact]
    public async Task SendMessageAsync_RefreshesExpiredSnapshot_PersistsAndReportsRefresh()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddMinutes(-5), "old-access", "old-refresh"));
        ClaudeOAuthRefreshNotification? notification = null;
        string? authorizationHeader = null;
        var oauthCalls = 0;

        using var client = new HttpClient(new RecordingHttpMessageHandler(async (request, cancellationToken) =>
        {
            if (request.RequestUri == new Uri("https://claude.ai/v1/oauth/token"))
            {
                Interlocked.Increment(ref oauthCalls);
                var body = await request.Content!.ReadAsStringAsync(cancellationToken);
                body.Should().Contain("refresh_token=old-refresh");

                return TestResponses.Json(HttpStatusCode.OK, """
                {
                  "access_token": "fresh-access",
                  "refresh_token": "fresh-refresh",
                  "expires_in": 120
                }
                """);
            }

            authorizationHeader = request.Headers.Authorization?.Parameter;
            return TestResponses.Json(HttpStatusCode.OK, """
            {
              "id": "msg_1",
              "type": "message",
              "role": "assistant",
              "model": "claude-sonnet-4-6-20260101",
              "stop_reason": "end_turn",
              "content": [{ "type": "text", "text": "OK" }],
              "usage": { "input_tokens": 10, "output_tokens": 2 }
            }
            """);
        }));

        var sut = new ClaudeSuscriptionClient(
            client,
            store,
            new ClaudeSuscriptionClientOptions
            {
                OnOAuthRefreshedAsync = (value, _) =>
                {
                    notification = value;
                    return Task.CompletedTask;
                }
            });

        var response = await sut.SendMessageAsync(new ClaudeMessageRequest
        {
            Model = "claude-sonnet-4-6-20260101",
            Messages = new[] { ClaudeMessage.UserText("hello world") }
        });

        oauthCalls.Should().Be(1);
        store.SaveCount.Should().Be(1);
        authorizationHeader.Should().Be("fresh-access");
        response.Metadata.OAuthRefreshed.Should().BeTrue();
        response.Metadata.RefreshedSnapshot!.AccessToken.Should().Be("fresh-access");
        store.Current.RefreshToken.Should().Be("fresh-refresh");
        notification.Should().NotBeNull();
        notification!.RefreshedSnapshot.AccessToken.Should().Be("fresh-access");
    }

    [Fact]
    public async Task SendMessageAsync_RefreshIsSingleFlightUnderConcurrency()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddMinutes(-5), "old-access", "old-refresh"));
        var oauthCalls = 0;

        using var client = new HttpClient(new RecordingHttpMessageHandler(async (request, cancellationToken) =>
        {
            if (request.RequestUri == new Uri("https://claude.ai/v1/oauth/token"))
            {
                Interlocked.Increment(ref oauthCalls);
                await Task.Delay(50, cancellationToken);
                return TestResponses.Json(HttpStatusCode.OK, """
                {
                  "access_token": "fresh-access",
                  "refresh_token": "fresh-refresh",
                  "expires_in": 120
                }
                """);
            }

            return TestResponses.Json(HttpStatusCode.OK, """
            {
              "id": "msg_1",
              "type": "message",
              "role": "assistant",
              "model": "claude-sonnet-4-6-20260101",
              "stop_reason": "end_turn",
              "content": [{ "type": "text", "text": "OK" }]
            }
            """);
        }));

        var sut = new ClaudeSuscriptionClient(client, store);
        var request = new ClaudeMessageRequest
        {
            Model = "claude-sonnet-4-6-20260101",
            Messages = new[] { ClaudeMessage.UserText("hello world") }
        };

        await Task.WhenAll(
            sut.SendMessageAsync(request),
            sut.SendMessageAsync(request));

        oauthCalls.Should().Be(1);
        store.SaveCount.Should().Be(1);
    }

    [Fact]
    public async Task SendMessageAsync_ShapesHermesMinimalBodyAndHeaders()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddHours(1)));
        string? body = null;
        string? betaHeader = null;
        string? userAgent = null;

        using var client = new HttpClient(new RecordingHttpMessageHandler(async (request, cancellationToken) =>
        {
            body = await request.Content!.ReadAsStringAsync(cancellationToken);
            betaHeader = request.Headers.GetValues("anthropic-beta").Single();
            userAgent = request.Headers.UserAgent.ToString();

            return TestResponses.Json(HttpStatusCode.OK, """
            {
              "id": "msg_1",
              "type": "message",
              "role": "assistant",
              "model": "claude-opus-4-6-20260101",
              "stop_reason": "end_turn",
              "content": [{ "type": "text", "text": "OK" }]
            }
            """);
        }));

        var sut = new ClaudeSuscriptionClient(client, store);

        await sut.SendMessageAsync(new ClaudeMessageRequest
        {
            Model = "claude-opus-4-6-20260101",
            Effort = ClaudeEffortLevel.Medium,
            Temperature = 0.2,
            System = new[] { ClaudeSystemBlock.TextBlock("Stay helpful", ClaudeCacheControl.WorkspaceEphemeral("5m")) },
            Messages = new[] { ClaudeMessage.User(ClaudeContentBlock.TextBlock("hello world")) }
        });

        using var document = JsonDocument.Parse(body!);
        var root = document.RootElement;
        var system = root.GetProperty("system");
        var content = root.GetProperty("messages")[0].GetProperty("content");

        system.GetArrayLength().Should().Be(2);
        system[0].GetProperty("text").GetString().Should().StartWith("x-anthropic-billing-header: ");
        system[1].GetProperty("text").GetString().Should().Be("You are Claude Code, Anthropic's official CLI for Claude.");
        content[0].GetProperty("text").GetString().Should().Be("<system-reminder>\nStay helpful\n</system-reminder>");
        content[0].GetProperty("cache_control").GetProperty("type").GetString().Should().Be("ephemeral");
        content[0].GetProperty("cache_control").GetProperty("scope").GetString().Should().Be("workspace");
        content[1].GetProperty("text").GetString().Should().Be("hello world");
        root.TryGetProperty("temperature", out _).Should().BeFalse();
        root.GetProperty("thinking").GetProperty("type").GetString().Should().Be("enabled");
        root.GetProperty("thinking").GetProperty("budget_tokens").GetInt32().Should().Be(2048);
        root.GetProperty("output_config").GetProperty("effort").GetString().Should().Be("medium");
        root.GetProperty("context_management").GetProperty("edits")[0].GetProperty("keep").GetProperty("type").GetString().Should().Be("thinking_turns");
        betaHeader.Should().Contain("effort-2025-11-24");
        userAgent.Should().Contain("claude-cli/2.1.104");
    }

    [Fact]
    public async Task SendMessageAsync_SerializesTypedFactoryHelpersForRichBlocks()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddHours(1)));
        string? body = null;

        using var client = new HttpClient(new RecordingHttpMessageHandler(async (request, cancellationToken) =>
        {
            body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return TestResponses.Json(HttpStatusCode.OK, """
            {
              "id": "msg_1",
              "type": "message",
              "role": "assistant",
              "model": "claude-opus-4-6-20260101",
              "stop_reason": "end_turn",
              "content": [{ "type": "text", "text": "OK" }]
            }
            """);
        }));

        var sut = new ClaudeSuscriptionClient(client, store);

        await sut.SendMessageAsync(new ClaudeMessageRequest
        {
            Model = "claude-opus-4-6-20260101",
            Messages = new[]
            {
                ClaudeMessage.User(
                    ClaudeContentBlock.ImageBase64("aGVsbG8=", ClaudeImageMediaType.Png),
                    ClaudeContentBlock.ToolResultText("toolu_1", "done", isError: true),
                    ClaudeContentBlock.TextBlock("describe this"))
            },
            Tools = new[]
            {
                ClaudeToolDefinition.Official(
                    ClaudeOfficialTool.Bash,
                    TestJson.Parse("""{ "type": "object" }"""),
                    "Run bash")
            },
            ToolChoice = ClaudeToolChoice.Official(ClaudeOfficialTool.Bash)
        });

        using var document = JsonDocument.Parse(body!);
        var root = document.RootElement;
        var content = root.GetProperty("messages")[0].GetProperty("content");

        content[0].GetProperty("type").GetString().Should().Be("image");
        content[0].GetProperty("source").GetProperty("type").GetString().Should().Be("base64");
        content[0].GetProperty("source").GetProperty("media_type").GetString().Should().Be("image/png");
        content[0].GetProperty("source").GetProperty("data").GetString().Should().Be("aGVsbG8=");
        content[1].GetProperty("type").GetString().Should().Be("tool_result");
        content[1].GetProperty("tool_use_id").GetString().Should().Be("toolu_1");
        content[1].GetProperty("is_error").GetBoolean().Should().BeTrue();
        content[1].GetProperty("content")[0].GetProperty("text").GetString().Should().Be("done");
        root.GetProperty("tools")[0].GetProperty("name").GetString().Should().Be("Bash");
        root.GetProperty("tool_choice").GetProperty("name").GetString().Should().Be("Bash");
    }

    [Fact]
    public async Task SendMessageAsync_DefaultsThinkingToHigh()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddHours(1)));
        string? body = null;

        using var client = new HttpClient(new RecordingHttpMessageHandler(async (request, cancellationToken) =>
        {
            body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return TestResponses.Json(HttpStatusCode.OK, """
            {
              "id": "msg_1",
              "type": "message",
              "role": "assistant",
              "model": "claude-sonnet-4-5-20250929",
              "stop_reason": "end_turn",
              "content": [{ "type": "text", "text": "OK" }]
            }
            """);
        }));

        var sut = new ClaudeSuscriptionClient(client, store);

        await sut.SendMessageAsync(new ClaudeMessageRequest
        {
            Model = "claude-sonnet-4-5-20250929",
            Messages = new[] { ClaudeMessage.UserText("hello world") }
        });

        using var document = JsonDocument.Parse(body!);
        var root = document.RootElement;
        root.GetProperty("thinking").GetProperty("type").GetString().Should().Be("enabled");
        root.GetProperty("thinking").GetProperty("budget_tokens").GetInt32().Should().Be(3072);
        root.GetProperty("context_management").GetProperty("edits")[0].GetProperty("keep").GetProperty("type").GetString().Should().Be("thinking_turns");
        root.TryGetProperty("output_config", out _).Should().BeFalse();
    }

    [Fact]
    public async Task SendMessageAsync_ParsesTypedThinkingBlocks()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddHours(1)));

        using var client = new HttpClient(new RecordingHttpMessageHandler((_, _) =>
            Task.FromResult(TestResponses.Json(HttpStatusCode.OK, """
            {
              "id": "msg_1",
              "type": "message",
              "role": "assistant",
              "model": "claude-sonnet-4-5-20250929",
              "stop_reason": "end_turn",
              "content": [
                { "type": "thinking", "thinking": "step one", "signature": "sig_1" },
                { "type": "redacted_thinking", "data": "encrypted" },
                { "type": "text", "text": "OK" }
              ]
            }
            """))));

        var sut = new ClaudeSuscriptionClient(client, store);

        var response = await sut.SendMessageAsync(new ClaudeMessageRequest
        {
            Model = "claude-sonnet-4-5-20250929",
            Messages = new[] { ClaudeMessage.UserText("hello world") }
        });

        response.Content[0].Type.Should().Be(ClaudeContentBlockType.Thinking);
        response.Content[0].ThinkingText.Should().Be("step one");
        response.Content[0].Signature.Should().Be("sig_1");
        response.Content[1].Type.Should().Be(ClaudeContentBlockType.RedactedThinking);
        response.Content[1].Data.Should().Be("encrypted");
    }

    [Fact]
    public async Task SendMessageAsync_MapsToolsOutboundAndRewritesToolUseInbound()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddHours(1)));
        string? body = null;

        using var client = new HttpClient(new RecordingHttpMessageHandler(async (request, cancellationToken) =>
        {
            body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return TestResponses.Json(HttpStatusCode.OK, """
            {
              "id": "msg_1",
              "type": "message",
              "role": "assistant",
              "model": "claude-opus-4-6-20260101",
              "stop_reason": "tool_use",
              "content": [
                {
                  "type": "tool_use",
                  "id": "toolu_1",
                  "name": "Bash",
                  "input": { "command": "ls" }
                }
              ]
            }
            """);
        }));

        var sut = new ClaudeSuscriptionClient(client, store);
        var response = await sut.SendMessageAsync(new ClaudeMessageRequest
        {
            Model = "claude-opus-4-6-20260101",
            Messages = new[] { ClaudeMessage.User(ClaudeContentBlock.TextBlock("hello world")) },
            Tools = new[]
            {
                ClaudeToolDefinition.Official(
                    ClaudeOfficialTool.Bash,
                    TestJson.Parse("""{ "type": "object" }"""),
                    "Run bash"),
                ClaudeToolDefinition.Create(
                    "question",
                    TestJson.Parse("""{ "type": "object" }"""),
                    "Ask question")
            }
        });

        using var document = JsonDocument.Parse(body!);
        var tools = document.RootElement.GetProperty("tools");
        tools[0].GetProperty("name").GetString().Should().Be("Bash");
        tools[1].GetProperty("name").GetString().Should().Be("mcp__local__question");
        response.Content.Should().ContainSingle();
        response.Content[0].Name.Should().Be("bash");
    }

    [Fact]
    public async Task SendMessageAsync_StripsEffortForHaikuAndAdjustsBetas()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddHours(1)));
        string? body = null;
        string? betaHeader = null;

        using var client = new HttpClient(new RecordingHttpMessageHandler(async (request, cancellationToken) =>
        {
            body = await request.Content!.ReadAsStringAsync(cancellationToken);
            betaHeader = request.Headers.GetValues("anthropic-beta").Single();
            return TestResponses.Json(HttpStatusCode.OK, """
            {
              "id": "msg_1",
              "type": "message",
              "role": "assistant",
              "model": "claude-haiku-4-5-20251001",
              "stop_reason": "end_turn",
              "content": [{ "type": "text", "text": "OK" }]
            }
            """);
        }));

        var sut = new ClaudeSuscriptionClient(client, store, new ClaudeSuscriptionClientOptions { Enable1MContext = true });

        await sut.SendMessageAsync(new ClaudeMessageRequest
        {
            Model = "claude-haiku-4-5-20251001",
            Effort = ClaudeEffortLevel.High,
            Messages = new[] { ClaudeMessage.UserText("hello world") }
        });

        betaHeader.Should().NotContain("interleaved-thinking-2025-05-14");
        betaHeader.Should().NotContain("effort-2025-11-24");
        using var document = JsonDocument.Parse(body!);
        document.RootElement.TryGetProperty("thinking", out _).Should().BeFalse();
        document.RootElement.TryGetProperty("output_config", out _).Should().BeFalse();
    }

    [Fact]
    public async Task SendMessageAsync_ThrowsThirdPartyUsageException()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddHours(1)));

        using var client = new HttpClient(new RecordingHttpMessageHandler((_, _) =>
            Task.FromResult(TestResponses.Json(HttpStatusCode.BadRequest, """
            {
              "error": {
                "message": "Third-party apps now draw from your extra usage, not your plan limits. We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going."
              }
            }
            """))));

        var sut = new ClaudeSuscriptionClient(client, store);

        var act = () => sut.SendMessageAsync(new ClaudeMessageRequest
        {
            Model = "claude-opus-4-6-20260101",
            Messages = new[] { ClaudeMessage.UserText("hello world") }
        });

        await act.Should().ThrowAsync<ClaudeThirdPartyUsageException>();
    }

    [Fact]
    public async Task StreamMessageAsync_ParsesSseAndEmitsCompletedMetadata()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddHours(1)));

        const string sse = """
        event: message_start
        data: {"type":"message_start","message":{"id":"msg_1"},"usage":{"input_tokens":10}}

        event: content_block_delta
        data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}

        event: message_delta
        data: {"type":"message_delta","usage":{"output_tokens":4}}

        data: [DONE]

        """;

        using var client = new HttpClient(new RecordingHttpMessageHandler((_, _) =>
            Task.FromResult(TestResponses.Json(HttpStatusCode.OK, sse, "text/event-stream"))));

        var sut = new ClaudeSuscriptionClient(client, store);

        var events = new List<ClaudeStreamEvent>();
        await foreach (var item in sut.StreamMessageAsync(new ClaudeMessageRequest
                       {
                           Model = "claude-opus-4-6-20260101",
                           Messages = new[] { ClaudeMessage.UserText("hello world") }
                       }))
        {
            events.Add(item);
        }

        events.Select(x => x.EventType).Should().ContainInOrder(
            ClaudeStreamEventType.MessageStart,
            ClaudeStreamEventType.ContentBlockDelta,
            ClaudeStreamEventType.MessageDelta,
            ClaudeStreamEventType.Done,
            ClaudeStreamEventType.Completed);
        events[1].TextDelta.Should().Be("Hel");
        events[^1].Metadata.Should().NotBeNull();
        events[^1].Usage!.InputTokens.Should().Be(10);
        events[^1].Usage!.OutputTokens.Should().Be(4);
        events[^1].Usage!.TotalTokens.Should().Be(14);
    }

    [Fact]
    public async Task SendMessageAsync_ThrowsValidationExceptionWhenSystemTextCannotBeRelocated()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddHours(1)));
        using var client = new HttpClient(new RecordingHttpMessageHandler((_, _) =>
            Task.FromResult(TestResponses.Json(HttpStatusCode.OK, "{}"))));
        var sut = new ClaudeSuscriptionClient(client, store);

        var act = () => sut.SendMessageAsync(new ClaudeMessageRequest
        {
            Model = "claude-sonnet-4-6-20260101",
            System = new[] { ClaudeSystemBlock.TextBlock("Stay helpful") },
            Messages = new[] { ClaudeMessage.AssistantText("No user present") }
        });

        await act.Should().ThrowAsync<ClaudeRequestValidationException>();
    }

    [Fact]
    public async Task SendMessageAsync_AddsOneMillionContextBetaWhenEnabledForSupportedModels()
    {
        var store = new InMemoryCredentialStore(CreateSnapshot(DateTimeOffset.UtcNow.AddHours(1)));
        string? betaHeader = null;

        using var client = new HttpClient(new RecordingHttpMessageHandler((request, _) =>
        {
            betaHeader = request.Headers.GetValues("anthropic-beta").Single();
            return Task.FromResult(TestResponses.Json(HttpStatusCode.OK, """
            {
              "id": "msg_1",
              "type": "message",
              "role": "assistant",
              "model": "claude-sonnet-4-6-20260101",
              "stop_reason": "end_turn",
              "content": [{ "type": "text", "text": "OK" }]
            }
            """));
        }));

        var sut = new ClaudeSuscriptionClient(client, store, new ClaudeSuscriptionClientOptions { Enable1MContext = true });

        await sut.SendMessageAsync(new ClaudeMessageRequest
        {
            Model = "claude-sonnet-4-6-20260101",
            Messages = new[] { ClaudeMessage.UserText("hello world") }
        });

        betaHeader.Should().Contain("context-1m-2025-08-07");
    }

    private static ClaudeOAuthSnapshot CreateSnapshot(
        DateTimeOffset expiresAtUtc,
        string accessToken = "access-token",
        string refreshToken = "refresh-token") =>
        new()
        {
            AccessToken = accessToken,
            RefreshToken = refreshToken,
            ExpiresAtUtc = expiresAtUtc,
            Scopes = new[] { "org.read" },
            SubscriptionType = "max",
            RateLimitTier = "subscription"
        };
}
