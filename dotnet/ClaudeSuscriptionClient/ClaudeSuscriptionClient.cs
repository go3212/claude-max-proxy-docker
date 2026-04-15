using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudeSuscriptionClient;

public sealed partial class ClaudeSuscriptionClient
{
    private const string BillingPrefix = "x-anthropic-billing-header";
    private const string BillingSalt = "59cf53e54c78";
    private const string IdentityText = "You are Claude Code, Anthropic's official CLI for Claude.";
    private const string OAuthClientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
    private static readonly TimeSpan CredentialCacheTtl = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan RefreshWindow = TimeSpan.FromMinutes(1);
    private static readonly string[] BaseBetas =
    {
        "claude-code-20250219",
        "oauth-2025-04-20",
        "interleaved-thinking-2025-05-14",
        "prompt-caching-scope-2026-01-05",
        "context-management-2025-06-27"
    };
    private static readonly string[] ToolBetas =
    {
        "advisor-tool-2026-03-01",
        "advanced-tool-use-2025-11-20"
    };
    private static readonly Dictionary<string, string> OpenToOfficialToolName = new(StringComparer.OrdinalIgnoreCase)
    {
        ["task"] = "Agent",
        ["bash"] = "Bash",
        ["edit"] = "Edit",
        ["glob"] = "Glob",
        ["grep"] = "Grep",
        ["read"] = "Read",
        ["write"] = "Write",
        ["skill"] = "Skill"
    };
    private static readonly Dictionary<string, string> OpenToMcpAliasToolName = new(StringComparer.OrdinalIgnoreCase)
    {
        ["get_environment"] = "mcp__environment__get_environment"
    };

    private readonly HttpClient _httpClient;
    private readonly IClaudeOAuthCredentialStore _credentialStore;
    private readonly ClaudeSuscriptionClientOptions _options;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private readonly string _sessionId = Guid.NewGuid().ToString();

    private ClaudeOAuthSnapshot? _cachedSnapshot;
    private DateTimeOffset _cachedAtUtc = DateTimeOffset.MinValue;

    public ClaudeSuscriptionClient(
        HttpClient httpClient,
        IClaudeOAuthCredentialStore credentialStore,
        ClaudeSuscriptionClientOptions? options = null)
    {
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _credentialStore = credentialStore ?? throw new ArgumentNullException(nameof(credentialStore));
        _options = options ?? new ClaudeSuscriptionClientOptions();
    }

    public async Task<ClaudeOAuthSnapshot> GetOAuthStateAsync(CancellationToken cancellationToken = default) =>
        (await GetValidSnapshotAsync(cancellationToken).ConfigureAwait(false)).Snapshot;

    public async Task<ClaudeMessageResponse> SendMessageAsync(
        ClaudeMessageRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        var prepared = await PrepareRequestAsync(request, false, cancellationToken).ConfigureAwait(false);
        using var response = await SendHttpRequestAsync(prepared, cancellationToken).ConfigureAwait(false);
        var rawBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            throw CreateResponseException(response.StatusCode, prepared.Metadata.RequestId, rawBody);
        }

        try
        {
            using var document = JsonDocument.Parse(rawBody);
            return ParseMessageResponse(document.RootElement, prepared.Metadata, prepared.ReverseToolNameMap);
        }
        catch (JsonException exception)
        {
            throw new ClaudeProtocolException(
                "Anthropic returned an invalid JSON response.",
                response.StatusCode,
                prepared.Metadata.RequestId,
                BuildExcerpt(rawBody),
                exception);
        }
    }

    public async IAsyncEnumerable<ClaudeStreamEvent> StreamMessageAsync(
        ClaudeMessageRequest request,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        var prepared = await PrepareRequestAsync(request, true, cancellationToken).ConfigureAwait(false);
        using var response = await SendHttpRequestAsync(prepared, cancellationToken).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            var rawBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            throw CreateResponseException(response.StatusCode, prepared.Metadata.RequestId, rawBody);
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: false);

        var eventName = (string?)null;
        var dataLines = new List<string>();
        ClaudeUsage? latestUsage = null;
        var sawDone = false;

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
            if (line is null)
            {
                break;
            }

            if (line.Length == 0)
            {
                var parsed = ParseSseFrame(eventName, dataLines, prepared.ReverseToolNameMap);
                eventName = null;
                dataLines.Clear();

                if (parsed is null)
                {
                    continue;
                }

                if (parsed.Usage is not null)
                {
                    latestUsage = MergeUsage(latestUsage, parsed.Usage);
                }

                yield return parsed;

                if (parsed.EventType == ClaudeStreamEventType.Done)
                {
                    sawDone = true;
                    break;
                }

                continue;
            }

            if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                eventName = line[6..].Trim();
                continue;
            }

            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                dataLines.Add(line[5..].TrimStart());
            }
        }

        if (!sawDone && dataLines.Count > 0)
        {
            var parsed = ParseSseFrame(eventName, dataLines, prepared.ReverseToolNameMap);
            if (parsed is not null)
            {
                if (parsed.Usage is not null)
                {
                    latestUsage = MergeUsage(latestUsage, parsed.Usage);
                }

                yield return parsed;
            }
        }

        yield return new ClaudeStreamEvent
        {
            EventType = ClaudeStreamEventType.Completed,
            EventName = "completed",
            Usage = latestUsage,
            Metadata = prepared.Metadata
        };
    }

    private async Task<HttpResponseMessage> SendHttpRequestAsync(
        PreparedRequest prepared,
        CancellationToken cancellationToken)
    {
        var message = new HttpRequestMessage(HttpMethod.Post, _options.MessagesEndpoint)
        {
            Content = new StringContent(prepared.BodyJson, Encoding.UTF8, "application/json")
        };

        foreach (var header in prepared.Headers)
        {
            if (!message.Headers.TryAddWithoutValidation(header.Key, header.Value))
            {
                message.Content?.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
        }

        return await _httpClient.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<PreparedRequest> PrepareRequestAsync(
        ClaudeMessageRequest request,
        bool stream,
        CancellationToken cancellationToken)
    {
        ValidateRequest(request);

        var access = await GetValidSnapshotAsync(cancellationToken).ConfigureAwait(false);
        var requestId = Guid.NewGuid().ToString();
        var toolBridge = BuildToolBridge(request.Tools);
        var betas = BuildBetas(request.Model, toolBridge.HasTools);
        var body = BuildOutgoingBody(request, toolBridge, stream);
        var headers = BuildHeaders(access.Snapshot.AccessToken, requestId, betas);

        return new PreparedRequest(
            body.ToJsonString(new JsonSerializerOptions { WriteIndented = false }),
            headers,
            new ClaudeOperationMetadata
            {
                OAuthRefreshed = access.RefreshedSnapshot is not null,
                RefreshedSnapshot = access.RefreshedSnapshot,
                RequestId = requestId,
                SessionId = _sessionId,
                AppliedBetas = betas
            },
            toolBridge.ReverseToolNameMap);
    }

    private async Task<AccessResult> GetValidSnapshotAsync(CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        if (_cachedSnapshot is not null &&
            now - _cachedAtUtc < CredentialCacheTtl &&
            _cachedSnapshot.ExpiresAtUtc > now + RefreshWindow)
        {
            return new AccessResult(_cachedSnapshot, null);
        }

        await _refreshLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            now = DateTimeOffset.UtcNow;
            if (_cachedSnapshot is not null &&
                now - _cachedAtUtc < CredentialCacheTtl &&
                _cachedSnapshot.ExpiresAtUtc > now + RefreshWindow)
            {
                return new AccessResult(_cachedSnapshot, null);
            }

            ClaudeOAuthSnapshot snapshot;
            try
            {
                snapshot = await _credentialStore.GetAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                throw new ClaudeAuthenticationException(
                    "The OAuth credential store could not load Claude credentials.",
                    innerException: exception);
            }

            ValidateSnapshot(snapshot);

            ClaudeOAuthSnapshot? refreshedSnapshot = null;
            if (snapshot.ExpiresAtUtc <= now + RefreshWindow)
            {
                refreshedSnapshot = await RefreshSnapshotAsync(snapshot, cancellationToken).ConfigureAwait(false);
                try
                {
                    await _credentialStore.SaveAsync(refreshedSnapshot, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception exception)
                {
                    throw new ClaudeOAuthRefreshException(
                        "Claude OAuth credentials were refreshed but could not be persisted by the credential store.",
                        innerException: exception);
                }

                if (_options.OnOAuthRefreshedAsync is not null)
                {
                    await _options.OnOAuthRefreshedAsync(
                            new ClaudeOAuthRefreshNotification
                            {
                                PreviousSnapshot = snapshot,
                                RefreshedSnapshot = refreshedSnapshot,
                                RefreshedAtUtc = DateTimeOffset.UtcNow
                            },
                            cancellationToken)
                        .ConfigureAwait(false);
                }

                snapshot = refreshedSnapshot;
            }

            _cachedSnapshot = snapshot;
            _cachedAtUtc = now;

            return new AccessResult(snapshot, refreshedSnapshot);
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    private async Task<ClaudeOAuthSnapshot> RefreshSnapshotAsync(
        ClaudeOAuthSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        using var message = new HttpRequestMessage(HttpMethod.Post, _options.OAuthTokenEndpoint)
        {
            Content = new FormUrlEncodedContent(
                new Dictionary<string, string>
                {
                    ["grant_type"] = "refresh_token",
                    ["client_id"] = OAuthClientId,
                    ["refresh_token"] = snapshot.RefreshToken
                })
        };

        using var response = await _httpClient.SendAsync(message, cancellationToken).ConfigureAwait(false);
        var rawBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new ClaudeOAuthRefreshException(
                "Claude OAuth refresh failed.",
                response.StatusCode,
                rawBodyExcerpt: BuildExcerpt(rawBody));
        }

        try
        {
            using var document = JsonDocument.Parse(rawBody);
            var root = document.RootElement;
            if (!root.TryGetProperty("access_token", out var accessTokenElement) ||
                string.IsNullOrWhiteSpace(accessTokenElement.GetString()))
            {
                throw new ClaudeOAuthRefreshException(
                    "Claude OAuth refresh did not return an access token.",
                    response.StatusCode,
                    rawBodyExcerpt: BuildExcerpt(rawBody));
            }

            var refreshToken = root.TryGetProperty("refresh_token", out var refreshTokenElement) &&
                               !string.IsNullOrWhiteSpace(refreshTokenElement.GetString())
                ? refreshTokenElement.GetString()!
                : snapshot.RefreshToken;

            var expiresIn = root.TryGetProperty("expires_in", out var expiresInElement) &&
                            expiresInElement.TryGetInt32(out var value)
                ? value
                : 36000;

            return new ClaudeOAuthSnapshot
            {
                AccessToken = accessTokenElement.GetString()!,
                RefreshToken = refreshToken,
                ExpiresAtUtc = DateTimeOffset.UtcNow.AddSeconds(expiresIn),
                OrganizationUuid = snapshot.OrganizationUuid,
                RateLimitTier = snapshot.RateLimitTier,
                Scopes = snapshot.Scopes,
                SubscriptionType = snapshot.SubscriptionType
            };
        }
        catch (JsonException exception)
        {
            throw new ClaudeOAuthRefreshException(
                "Claude OAuth refresh returned invalid JSON.",
                response.StatusCode,
                rawBodyExcerpt: BuildExcerpt(rawBody),
                innerException: exception);
        }
    }

    private static void ValidateRequest(ClaudeMessageRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Model))
        {
            throw new ClaudeRequestValidationException("The model is required.");
        }

        if (request.Messages.Count == 0)
        {
            throw new ClaudeRequestValidationException("At least one message is required.");
        }
    }

    private static void ValidateSnapshot(ClaudeOAuthSnapshot snapshot)
    {
        if (string.IsNullOrWhiteSpace(snapshot.AccessToken) || string.IsNullOrWhiteSpace(snapshot.RefreshToken))
        {
            throw new ClaudeAuthenticationException("The OAuth credential store returned an invalid Claude snapshot.");
        }
    }

    private JsonObject BuildOutgoingBody(ClaudeMessageRequest request, ToolBridgeResult toolBridge, bool stream)
    {
        var outgoingMessages = request.Messages
            .Select(message => BuildMessageNode(message, toolBridge.OutboundToolNameMap))
            .ToList();

        var extractedSystem = ExtractSystem(request.System);
        if (extractedSystem.RelocatedSystemText.Count > 0 &&
            !PrependSystemReminders(outgoingMessages, extractedSystem.RelocatedSystemText))
        {
            throw new ClaudeRequestValidationException(
                "System text can only be relocated in hermes-minimal mode when at least one user message exists.");
        }

        var effectiveMaxTokens = request.MaxTokens ?? _options.DefaultMaxTokens;
        var thinking = ApplyEffortDefaults(request.Thinking, request.Effort ?? _options.DefaultThinkingEffort);
        var output = ApplyEffortDefaults(request.Output, request.Effort);
        if (IsHaiku(request.Model))
        {
            thinking = RemoveEffort(thinking);
            output = RemoveEffort(output);
        }

        var billingText = BuildBillingHeaderValue(request.Messages, _options.ClaudeCodeVersion, ToEntrypointValue(_options.Entrypoint));
        var system = new JsonArray
        {
            new JsonObject
            {
                ["type"] = "text",
                ["text"] = billingText
            },
            new JsonObject
            {
                ["type"] = "text",
                ["text"] = IdentityText
            }
        };

        foreach (var preserved in extractedSystem.PreservedSystemEntries)
        {
            system.Add(preserved);
        }

        var payload = new JsonObject
        {
            ["model"] = request.Model,
            ["messages"] = new JsonArray(outgoingMessages.ToArray()),
            ["system"] = system,
            ["stream"] = stream
        };

        payload["max_tokens"] = effectiveMaxTokens;

        if (request.Temperature is not null && !ShouldStripTemperature(request.Model, request.Temperature.Value))
        {
            payload["temperature"] = request.Temperature.Value;
        }

        var thinkingNode = thinking is not null ? BuildThinkingNode(thinking, effectiveMaxTokens) : null;
        if (thinkingNode is not null)
        {
            payload["thinking"] = thinkingNode;
        }

        var outputNode = output is not null ? BuildOptionsNode(output) : null;
        if (outputNode is not null)
        {
            payload["output_config"] = outputNode;
        }

        if (toolBridge.MappedTools.Count > 0)
        {
            payload["tools"] = new JsonArray(toolBridge.MappedTools.Select(BuildToolNode).ToArray());
        }

        var mappedToolChoice = MapToolChoice(request.ToolChoice);
        if (mappedToolChoice is not null)
        {
            payload["tool_choice"] = mappedToolChoice;
        }

        if (thinkingNode is not null)
        {
            payload["context_management"] = new JsonObject
            {
                ["edits"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["type"] = "clear_thinking_20251015",
                        ["keep"] = new JsonObject
                        {
                            ["type"] = "thinking_turns",
                            ["value"] = 1
                        }
                    }
                }
            };
        }

        var userId = request.MetadataUserId ?? _options.MetadataUserId;
        if (!string.IsNullOrWhiteSpace(userId))
        {
            payload["metadata"] = new JsonObject
            {
                ["user_id"] = userId
            };
        }

        return payload;
    }

    private Dictionary<string, string> BuildHeaders(string accessToken, string requestId, IReadOnlyList<string> betas) =>
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["authorization"] = $"Bearer {accessToken}",
            ["anthropic-version"] = "2023-06-01",
            ["anthropic-beta"] = string.Join(",", betas),
            ["x-app"] = "cli",
            ["user-agent"] = $"claude-cli/{_options.ClaudeCodeVersion} (external, {ToEntrypointValue(_options.Entrypoint)})",
            ["x-client-request-id"] = requestId,
            ["x-claude-code-session-id"] = _sessionId,
            ["accept"] = "application/json",
            ["anthropic-dangerous-direct-browser-access"] = "true",
            ["x-stainless-arch"] = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
            ["x-stainless-lang"] = "js",
            ["x-stainless-os"] = GetStainlessOs(),
            ["x-stainless-package-version"] = "0.81.0",
            ["x-stainless-retry-count"] = "0",
            ["x-stainless-runtime"] = "node",
            ["x-stainless-runtime-version"] = "v24.14.1",
            ["x-stainless-timeout"] = "600"
        };

    private IReadOnlyList<string> BuildBetas(string model, bool hasTools)
    {
        var betas = new List<string>(BaseBetas);

        if (_options.Enable1MContext && Supports1MContext(model))
        {
            betas.Add("context-1m-2025-08-07");
        }

        if (hasTools)
        {
            betas.AddRange(ToolBetas);
        }

        if (model.Contains("4-6", StringComparison.OrdinalIgnoreCase))
        {
            betas.Add("effort-2025-11-24");
        }

        if (IsHaiku(model))
        {
            betas.Remove("interleaved-thinking-2025-05-14");
            betas.Remove("effort-2025-11-24");
        }

        return betas.Distinct(StringComparer.Ordinal).ToArray();
    }

    private static bool Supports1MContext(string model)
    {
        var lower = model.ToLowerInvariant();
        if (!lower.Contains("opus", StringComparison.Ordinal) && !lower.Contains("sonnet", StringComparison.Ordinal))
        {
            return false;
        }

        return lower.Contains("4-6", StringComparison.Ordinal) || lower.Contains("4.6", StringComparison.Ordinal);
    }

    private static bool IsHaiku(string model) =>
        model.Contains("haiku", StringComparison.OrdinalIgnoreCase);

    private static bool ShouldStripTemperature(string model, double temperature)
    {
        if (!(model.Contains("4-6", StringComparison.OrdinalIgnoreCase) ||
              model.Contains("4.6", StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        return Math.Abs(temperature - 1.0d) > double.Epsilon;
    }

    private static ClaudeThinkingOptions? ApplyEffortDefaults(ClaudeThinkingOptions? thinking, ClaudeEffortLevel? requestEffort)
    {
        if (thinking is null && requestEffort is null)
        {
            return null;
        }

        return new ClaudeThinkingOptions
        {
            Effort = thinking?.Effort ?? requestEffort,
            AdditionalData = CloneDictionary(thinking?.AdditionalData)
        };
    }

    private static ClaudeOutputOptions? ApplyEffortDefaults(ClaudeOutputOptions? output, ClaudeEffortLevel? requestEffort)
    {
        if (output is null && requestEffort is null)
        {
            return null;
        }

        return new ClaudeOutputOptions
        {
            Effort = output?.Effort ?? requestEffort,
            AdditionalData = CloneDictionary(output?.AdditionalData)
        };
    }

    private static ClaudeThinkingOptions? RemoveEffort(ClaudeThinkingOptions? thinking)
    {
        if (thinking is null)
        {
            return null;
        }

        var clonedAdditionalData = CloneDictionary(thinking.AdditionalData);
        if (clonedAdditionalData is null || clonedAdditionalData.Count == 0)
        {
            return null;
        }

        return new ClaudeThinkingOptions
        {
            Effort = null,
            AdditionalData = clonedAdditionalData
        };
    }

    private static ClaudeOutputOptions? RemoveEffort(ClaudeOutputOptions? output)
    {
        if (output is null)
        {
            return null;
        }

        var clonedAdditionalData = CloneDictionary(output.AdditionalData);
        if (clonedAdditionalData is null || clonedAdditionalData.Count == 0)
        {
            return null;
        }

        return new ClaudeOutputOptions
        {
            Effort = null,
            AdditionalData = clonedAdditionalData
        };
    }

    private static JsonObject? BuildThinkingNode(ClaudeThinkingOptions options, int maxTokens)
    {
        if (maxTokens <= 1024)
        {
            throw new ClaudeRequestValidationException(
                "Extended thinking requires max_tokens to be greater than 1024.");
        }

        var node = new JsonObject
        {
            ["type"] = "enabled"
        };

        if (options.Effort is not null)
        {
            node["budget_tokens"] = ResolveThinkingBudgetTokens(options.Effort.Value, maxTokens);
        }

        MergeAdditionalData(node, options.AdditionalData, ["effort"]);
        return node.Count > 0 ? node : null;
    }

    private static JsonObject? BuildOptionsNode(ClaudeOutputOptions options)
    {
        var node = new JsonObject();
        if (options.Effort is not null)
        {
            node["effort"] = ToEffortValue(options.Effort.Value);
        }

        MergeAdditionalData(node, options.AdditionalData, ["effort"]);
        return node.Count > 0 ? node : null;
    }

    private static string ToEffortValue(ClaudeEffortLevel effort) =>
        effort switch
        {
            ClaudeEffortLevel.Low => "low",
            ClaudeEffortLevel.Medium => "medium",
            ClaudeEffortLevel.High => "high",
            _ => "medium"
        };

    private static string ToEntrypointValue(ClaudeClientEntrypoint entrypoint) =>
        entrypoint switch
        {
            ClaudeClientEntrypoint.Cli => "cli",
            ClaudeClientEntrypoint.SdkCli => "sdk-cli",
            _ => "sdk-cli"
        };

    private static string ToMessageRoleValue(ClaudeMessageRole role) =>
        role switch
        {
            ClaudeMessageRole.User => "user",
            ClaudeMessageRole.Assistant => "assistant",
            _ => "user"
        };

    private static ClaudeMessageRole? ParseMessageRole(string? value) =>
        value switch
        {
            "user" => ClaudeMessageRole.User,
            "assistant" => ClaudeMessageRole.Assistant,
            _ => null
        };

    private static string ToContentBlockTypeValue(ClaudeContentBlockType type) =>
        type switch
        {
            ClaudeContentBlockType.Text => "text",
            ClaudeContentBlockType.Image => "image",
            ClaudeContentBlockType.ToolUse => "tool_use",
            ClaudeContentBlockType.ToolResult => "tool_result",
            ClaudeContentBlockType.Thinking => "thinking",
            ClaudeContentBlockType.RedactedThinking => "redacted_thinking",
            ClaudeContentBlockType.Document => "document",
            _ => "unknown"
        };

    private static ClaudeContentBlockType ParseContentBlockType(string? value) =>
        value switch
        {
            "text" => ClaudeContentBlockType.Text,
            "image" => ClaudeContentBlockType.Image,
            "tool_use" => ClaudeContentBlockType.ToolUse,
            "tool_result" => ClaudeContentBlockType.ToolResult,
            "thinking" => ClaudeContentBlockType.Thinking,
            "redacted_thinking" => ClaudeContentBlockType.RedactedThinking,
            "document" => ClaudeContentBlockType.Document,
            _ => ClaudeContentBlockType.Unknown
        };

    private static string ToToolChoiceTypeValue(ClaudeToolChoiceType type) =>
        type switch
        {
            ClaudeToolChoiceType.Auto => "auto",
            ClaudeToolChoiceType.Any => "any",
            ClaudeToolChoiceType.Tool => "tool",
            _ => "auto"
        };

    private static string ToCacheControlTypeValue(ClaudeCacheControlType type) =>
        type switch
        {
            ClaudeCacheControlType.Ephemeral => "ephemeral",
            _ => "ephemeral"
        };

    private static ClaudeCacheControlType? ParseCacheControlType(string? value) =>
        value switch
        {
            "ephemeral" => ClaudeCacheControlType.Ephemeral,
            _ => null
        };

    private static int ResolveThinkingBudgetTokens(ClaudeEffortLevel effort, int maxTokens)
    {
        var ceiling = maxTokens - 1;
        return effort switch
        {
            ClaudeEffortLevel.Low => Math.Min(ceiling, 1024),
            ClaudeEffortLevel.Medium => Math.Min(ceiling, Math.Max(1024, maxTokens / 2)),
            ClaudeEffortLevel.High => Math.Min(ceiling, Math.Max(1024, (maxTokens * 3) / 4)),
            _ => Math.Min(ceiling, Math.Max(1024, maxTokens / 2))
        };
    }

    private static ExtractedSystem ExtractSystem(IReadOnlyList<ClaudeSystemBlock> system)
    {
        var relocated = new List<ClaudeSystemBlock>();
        var preserved = new List<JsonNode>();

        foreach (var entry in system)
        {
            if (!string.Equals(entry.Type, "text", StringComparison.OrdinalIgnoreCase))
            {
                preserved.Add(BuildSystemNode(entry));
                continue;
            }

            var text = entry.Text ?? string.Empty;
            if (string.IsNullOrWhiteSpace(text))
            {
                continue;
            }

            if (text.StartsWith(BillingPrefix, StringComparison.Ordinal))
            {
                continue;
            }

            if (text.StartsWith(IdentityText, StringComparison.Ordinal))
            {
                var remainder = text[IdentityText.Length..].TrimStart('\r', '\n');
                if (!string.IsNullOrWhiteSpace(remainder))
                {
                    relocated.Add(new ClaudeSystemBlock
                    {
                        Type = "text",
                        Text = remainder,
                        CacheControl = entry.CacheControl,
                        AdditionalData = CloneDictionary(entry.AdditionalData)
                    });
                }

                continue;
            }

            relocated.Add(new ClaudeSystemBlock
            {
                Type = "text",
                Text = text,
                CacheControl = entry.CacheControl,
                AdditionalData = CloneDictionary(entry.AdditionalData)
            });
        }

        return new ExtractedSystem(relocated, preserved);
    }

    private static bool PrependSystemReminders(List<JsonObject> messages, IReadOnlyList<ClaudeSystemBlock> relocatedSystemText)
    {
        if (relocatedSystemText.Count == 0)
        {
            return true;
        }

        foreach (var message in messages)
        {
            if (!string.Equals(message["role"]?.GetValue<string>(), "user", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (message["content"] is not JsonArray contentArray)
            {
                contentArray = new JsonArray();
                message["content"] = contentArray;
            }

            var reminders = relocatedSystemText
                .Select(block => (JsonNode)BuildReminderBlock(block))
                .ToList();

            var existing = contentArray.ToList();
            contentArray.Clear();
            foreach (var reminder in reminders)
            {
                contentArray.Add(reminder);
            }

            foreach (var block in existing)
            {
                contentArray.Add(block);
            }

            return true;
        }

        return false;
    }

    private static JsonObject BuildReminderBlock(ClaudeSystemBlock block)
    {
        var node = new JsonObject
        {
            ["type"] = "text",
            ["text"] = $"<system-reminder>\n{block.Text}\n</system-reminder>"
        };

        if (block.CacheControl is not null)
        {
            node["cache_control"] = BuildCacheControlNode(block.CacheControl);
        }

        return node;
    }

    private static JsonObject BuildMessageNode(ClaudeMessage message, IReadOnlyDictionary<string, string> outboundToolNameMap)
    {
        var node = new JsonObject
        {
            ["role"] = ToMessageRoleValue(message.Role),
            ["content"] = new JsonArray(message.Content.Select(block => BuildContentNode(block, outboundToolNameMap)).ToArray())
        };

        MergeAdditionalData(node, message.AdditionalData, ["role", "content"]);
        return node;
    }

    private static JsonNode BuildContentNode(ClaudeContentBlock block, IReadOnlyDictionary<string, string> outboundToolNameMap)
    {
        var node = new JsonObject
        {
            ["type"] = ToContentBlockTypeValue(block.Type)
        };

        if (block.Text is not null)
        {
            node["text"] = block.Text;
        }

        if (block.Id is not null)
        {
            node["id"] = block.Id;
        }

        if (block.Name is not null)
        {
            var name = block.Type == ClaudeContentBlockType.ToolUse &&
                       outboundToolNameMap.TryGetValue(block.Name, out var mappedName)
                ? mappedName
                : block.Name;
            node["name"] = name;
        }

        if (block.Input is not null)
        {
            node["input"] = ToJsonNode(block.Input.Value);
        }

        if (block.Source is not null)
        {
            node["source"] = ToJsonNode(block.Source.Value);
        }

        if (!string.IsNullOrWhiteSpace(block.ToolUseId))
        {
            node["tool_use_id"] = block.ToolUseId;
        }

        if (block.IsError is not null)
        {
            node["is_error"] = block.IsError.Value;
        }

        if (block.Content is not null)
        {
            node["content"] = new JsonArray(block.Content.Select(item => BuildContentNode(item, outboundToolNameMap)).ToArray());
        }

        if (block.ThinkingText is not null)
        {
            node["thinking"] = block.ThinkingText;
        }

        if (block.Signature is not null)
        {
            node["signature"] = block.Signature;
        }

        if (block.Data is not null)
        {
            node["data"] = block.Data;
        }

        if (block.CacheControl is not null)
        {
            node["cache_control"] = BuildCacheControlNode(block.CacheControl);
        }

        MergeAdditionalData(
            (JsonObject)node,
            block.AdditionalData,
            ["type", "text", "id", "name", "input", "source", "tool_use_id", "is_error", "content", "thinking", "signature", "data", "cache_control"]);
        return node;
    }

    private static JsonNode BuildSystemNode(ClaudeSystemBlock block)
    {
        var node = new JsonObject
        {
            ["type"] = block.Type
        };

        if (block.Text is not null)
        {
            node["text"] = block.Text;
        }

        if (block.CacheControl is not null)
        {
            node["cache_control"] = BuildCacheControlNode(block.CacheControl);
        }

        MergeAdditionalData((JsonObject)node, block.AdditionalData, ["type", "text", "cache_control"]);
        return node;
    }

    private static JsonObject BuildToolNode(ClaudeToolDefinition tool)
    {
        var node = new JsonObject
        {
            ["name"] = tool.Name
        };

        if (!string.IsNullOrWhiteSpace(tool.Description))
        {
            node["description"] = tool.Description;
        }

        if (tool.InputSchema is not null)
        {
            node["input_schema"] = ToJsonNode(tool.InputSchema.Value);
        }
        else
        {
            node["input_schema"] = new JsonObject
            {
                ["type"] = "object"
            };
        }

        MergeAdditionalData(node, tool.AdditionalData, ["name", "description", "input_schema"]);
        return node;
    }

    private JsonObject? MapToolChoice(ClaudeToolChoice? toolChoice)
    {
        if (toolChoice is null)
        {
            return null;
        }

        var node = new JsonObject
        {
            ["type"] = ToToolChoiceTypeValue(toolChoice.Type)
        };

        if (!string.IsNullOrWhiteSpace(toolChoice.Name))
        {
            node["name"] = ResolveOfficialToolName(toolChoice.Name!);
        }

        MergeAdditionalData(node, toolChoice.AdditionalData, ["type", "name"]);
        return node;
    }

    private ToolBridgeResult BuildToolBridge(IReadOnlyList<ClaudeToolDefinition>? tools)
    {
        var mappedTools = new List<ClaudeToolDefinition>();
        var outbound = new Dictionary<string, string>(StringComparer.Ordinal);
        var reverse = new Dictionary<string, string>(StringComparer.Ordinal);

        if (tools is null || tools.Count == 0)
        {
            return new ToolBridgeResult(mappedTools, outbound, reverse);
        }

        foreach (var tool in tools)
        {
            var officialName = ResolveOfficialToolName(tool.Name);
            outbound[tool.Name] = officialName;
            reverse[officialName] = tool.Name;
            mappedTools.Add(new ClaudeToolDefinition
            {
                Name = officialName,
                Description = tool.Description,
                InputSchema = tool.InputSchema,
                AdditionalData = CloneDictionary(tool.AdditionalData)
            });
        }

        return new ToolBridgeResult(mappedTools, outbound, reverse);
    }

    private static string ResolveOfficialToolName(string openName)
    {
        if (OpenToOfficialToolName.TryGetValue(openName, out var officialName))
        {
            return officialName;
        }

        if (OpenToMcpAliasToolName.TryGetValue(openName, out var aliasName))
        {
            return aliasName;
        }

        if (openName.StartsWith("mcp__", StringComparison.Ordinal))
        {
            return openName;
        }

        if (openName.StartsWith("mcp_", StringComparison.Ordinal))
        {
            var suffix = openName[4..];
            var normalized = NormalizeImplicitMcpToolName(suffix);
            if (normalized is not null)
            {
                return normalized;
            }

            var separatorIndex = suffix.IndexOf('_');
            if (separatorIndex > 0)
            {
                return BuildMcpToolName(suffix[..separatorIndex], suffix[(separatorIndex + 1)..]);
            }

            return $"mcp__{suffix}";
        }

        var implicitMcp = NormalizeImplicitMcpToolName(openName);
        if (implicitMcp is not null)
        {
            return implicitMcp;
        }

        return BuildMcpToolName("local", openName);
    }

    private static string? NormalizeImplicitMcpToolName(string openName)
    {
        if (string.IsNullOrWhiteSpace(openName))
        {
            return null;
        }

        if (openName.StartsWith("__", StringComparison.Ordinal))
        {
            var trimmed = openName.Trim('_');
            var firstSeparator = trimmed.IndexOf('_');
            if (firstSeparator > 0)
            {
                return BuildMcpToolName(trimmed[..firstSeparator], trimmed[(firstSeparator + 1)..]);
            }
        }

        var parts = openName.Split("__", StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length >= 2)
        {
            return BuildMcpToolName(parts[0], string.Join("__", parts.Skip(1)));
        }

        var connectorMatch = openName.Split('_', 3, StringSplitOptions.RemoveEmptyEntries);
        if (connectorMatch.Length == 3 &&
            connectorMatch[0].Length >= 6 &&
            connectorMatch[1].Length >= 6 &&
            connectorMatch[0].All(Uri.IsHexDigit) &&
            connectorMatch[1].All(Uri.IsHexDigit))
        {
            return BuildMcpToolName($"{connectorMatch[0]}_{connectorMatch[1]}", connectorMatch[2]);
        }

        return null;
    }

    private static string BuildMcpToolName(string serverName, string toolName)
    {
        var normalizedServer = serverName.Trim('_');
        var normalizedTool = toolName.Trim('_');
        return $"mcp__{normalizedServer}__{normalizedTool}";
    }

    private static JsonObject BuildCacheControlNode(ClaudeCacheControl cacheControl)
    {
        var node = new JsonObject();
        if (cacheControl.Type is not null)
        {
            node["type"] = ToCacheControlTypeValue(cacheControl.Type.Value);
        }

        if (!string.IsNullOrWhiteSpace(cacheControl.Ttl))
        {
            node["ttl"] = cacheControl.Ttl;
        }

        if (!string.IsNullOrWhiteSpace(cacheControl.Scope))
        {
            node["scope"] = cacheControl.Scope;
        }

        MergeAdditionalData(node, cacheControl.AdditionalData, ["type", "ttl", "scope"]);
        return node;
    }

    private static JsonNode? ToJsonNode(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Undefined)
        {
            return null;
        }

        return JsonNode.Parse(element.GetRawText());
    }

    private static void MergeAdditionalData(
        JsonObject target,
        IReadOnlyDictionary<string, JsonElement>? additionalData,
        IReadOnlyCollection<string> reservedKeys)
    {
        if (additionalData is null)
        {
            return;
        }

        foreach (var pair in additionalData)
        {
            if (reservedKeys.Contains(pair.Key, StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }

            target[pair.Key] = ToJsonNode(pair.Value);
        }
    }

    private static Dictionary<string, JsonElement>? CloneDictionary(IReadOnlyDictionary<string, JsonElement>? source)
    {
        if (source is null || source.Count == 0)
        {
            return null;
        }

        return source.ToDictionary(
            pair => pair.Key,
            pair => pair.Value.Clone(),
            StringComparer.Ordinal);
    }

    private static string BuildBillingHeaderValue(
        IReadOnlyList<ClaudeMessage> messages,
        string version,
        string entrypoint)
    {
        var messageText = ExtractFirstUserMessageText(messages);
        var suffix = ComputeVersionSuffix(messageText, version);
        var cch = ComputeCch(messageText);
        return $"{BillingPrefix}: cc_version={version}.{suffix}; cc_entrypoint={entrypoint}; cch={cch};";
    }

    private static string ExtractFirstUserMessageText(IReadOnlyList<ClaudeMessage> messages)
    {
        foreach (var message in messages)
        {
            if (message.Role != ClaudeMessageRole.User)
            {
                continue;
            }

            var textBlock = message.Content.FirstOrDefault(block =>
                block.Type == ClaudeContentBlockType.Text &&
                !string.IsNullOrEmpty(block.Text));

            return textBlock?.Text ?? string.Empty;
        }

        return string.Empty;
    }

    private static string ComputeCch(string messageText)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(messageText));
        return Convert.ToHexString(hash).ToLowerInvariant()[..5];
    }

    private static string ComputeVersionSuffix(string messageText, string version)
    {
        var sampled = new[]
        {
            SampleCharacter(messageText, 4),
            SampleCharacter(messageText, 7),
            SampleCharacter(messageText, 20)
        };

        var payload = $"{BillingSalt}{new string(sampled)}{version}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(payload));
        return Convert.ToHexString(hash).ToLowerInvariant()[..3];
    }

    private static char SampleCharacter(string text, int index) =>
        index < text.Length ? text[index] : '0';

    private static ClaudeMessageResponse ParseMessageResponse(
        JsonElement root,
        ClaudeOperationMetadata metadata,
        IReadOnlyDictionary<string, string> reverseToolNameMap)
    {
        return new ClaudeMessageResponse
        {
            Id = GetString(root, "id"),
            Type = GetString(root, "type"),
            Role = ParseMessageRole(GetString(root, "role")),
            Model = GetString(root, "model"),
            StopReason = ParseStopReason(GetString(root, "stop_reason")),
            Content = root.TryGetProperty("content", out var contentElement) && contentElement.ValueKind == JsonValueKind.Array
                ? ParseContentBlocks(contentElement, reverseToolNameMap)
                : Array.Empty<ClaudeContentBlock>(),
            Usage = root.TryGetProperty("usage", out var usageElement) && usageElement.ValueKind == JsonValueKind.Object
                ? ParseUsage(usageElement)
                : null,
            Metadata = metadata,
            AdditionalData = CaptureAdditionalData(root, "id", "type", "role", "model", "stop_reason", "content", "usage")
        };
    }

    private static ClaudeStreamEvent? ParseSseFrame(
        string? eventName,
        IReadOnlyList<string> dataLines,
        IReadOnlyDictionary<string, string> reverseToolNameMap)
    {
        if (dataLines.Count == 0)
        {
            return null;
        }

        var data = string.Join("\n", dataLines);
        if (string.Equals(data, "[DONE]", StringComparison.Ordinal))
        {
            return new ClaudeStreamEvent
            {
                EventType = ClaudeStreamEventType.Done,
                EventName = eventName ?? "done"
            };
        }

        using var document = JsonDocument.Parse(data);
        var root = document.RootElement;
        var contentBlock = root.TryGetProperty("content_block", out var contentBlockElement) &&
                           contentBlockElement.ValueKind == JsonValueKind.Object
            ? ParseContentBlock(contentBlockElement, reverseToolNameMap)
            : null;

        var usage = TryFindUsage(root);
        var textDelta = root.TryGetProperty("delta", out var deltaElement) &&
                        deltaElement.ValueKind == JsonValueKind.Object &&
                        string.Equals(GetString(deltaElement, "type"), "text_delta", StringComparison.Ordinal) &&
                        deltaElement.TryGetProperty("text", out var textElement)
            ? textElement.GetString()
            : null;

        return new ClaudeStreamEvent
        {
            EventType = ParseStreamEventType(eventName, GetString(root, "type")),
            EventName = eventName,
            ContentBlock = contentBlock,
            TextDelta = textDelta,
            Usage = usage,
            Payload = root.Clone()
        };
    }

    private static ClaudeUsage? TryFindUsage(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (element.TryGetProperty("usage", out var usageElement) && usageElement.ValueKind == JsonValueKind.Object)
        {
            return ParseUsage(usageElement);
        }

        foreach (var property in element.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var nested = TryFindUsage(property.Value);
            if (nested is not null)
            {
                return nested;
            }
        }

        return null;
    }

    private static ClaudeUsage ParseUsage(JsonElement element)
    {
        var additional = CaptureAdditionalData(
            element,
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens");

        var inputTokens = GetInt32(element, "input_tokens");
        var outputTokens = GetInt32(element, "output_tokens");
        var cacheCreationInputTokens = GetInt32(element, "cache_creation_input_tokens");
        var cacheReadInputTokens = GetInt32(element, "cache_read_input_tokens");

        return new ClaudeUsage
        {
            InputTokens = inputTokens,
            OutputTokens = outputTokens,
            CacheCreationInputTokens = cacheCreationInputTokens,
            CacheReadInputTokens = cacheReadInputTokens,
            TotalTokens = SumNullable(inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens),
            AdditionalCounters = additional ?? new Dictionary<string, JsonElement>(StringComparer.Ordinal)
        };
    }

    private static int? SumNullable(params int?[] values)
    {
        var total = 0;
        var found = false;
        foreach (var value in values)
        {
            if (value is null)
            {
                continue;
            }

            total += value.Value;
            found = true;
        }

        return found ? total : null;
    }

    private static ClaudeUsage MergeUsage(ClaudeUsage? current, ClaudeUsage next)
    {
        if (current is null)
        {
            return next;
        }

        var additional = new Dictionary<string, JsonElement>(current.AdditionalCounters, StringComparer.Ordinal);
        foreach (var pair in next.AdditionalCounters)
        {
            additional[pair.Key] = pair.Value.Clone();
        }

        var merged = new ClaudeUsage
        {
            InputTokens = next.InputTokens ?? current.InputTokens,
            OutputTokens = next.OutputTokens ?? current.OutputTokens,
            CacheCreationInputTokens = next.CacheCreationInputTokens ?? current.CacheCreationInputTokens,
            CacheReadInputTokens = next.CacheReadInputTokens ?? current.CacheReadInputTokens,
            AdditionalCounters = additional
        };

        return new ClaudeUsage
        {
            InputTokens = merged.InputTokens,
            OutputTokens = merged.OutputTokens,
            CacheCreationInputTokens = merged.CacheCreationInputTokens,
            CacheReadInputTokens = merged.CacheReadInputTokens,
            TotalTokens = SumNullable(
                merged.InputTokens,
                merged.OutputTokens,
                merged.CacheCreationInputTokens,
                merged.CacheReadInputTokens),
            AdditionalCounters = merged.AdditionalCounters
        };
    }

    private static IReadOnlyList<ClaudeContentBlock> ParseContentBlocks(
        JsonElement array,
        IReadOnlyDictionary<string, string> reverseToolNameMap) =>
        array.EnumerateArray()
            .Select(element => ParseContentBlock(element, reverseToolNameMap))
            .ToArray();

    private static ClaudeContentBlock ParseContentBlock(
        JsonElement element,
        IReadOnlyDictionary<string, string> reverseToolNameMap)
    {
        var type = ParseContentBlockType(GetString(element, "type"));
        var name = GetString(element, "name");
        if (type == ClaudeContentBlockType.ToolUse &&
            name is not null &&
            reverseToolNameMap.TryGetValue(name, out var rewrittenName))
        {
            name = rewrittenName;
        }

        return new ClaudeContentBlock
        {
            Type = type,
            Text = GetString(element, "text"),
            Id = GetString(element, "id"),
            Name = name,
            Input = element.TryGetProperty("input", out var inputElement) ? inputElement.Clone() : null,
            Source = element.TryGetProperty("source", out var sourceElement) ? sourceElement.Clone() : null,
            ToolUseId = GetString(element, "tool_use_id"),
            IsError = GetBoolean(element, "is_error"),
            Content = ParseNestedContentBlocks(element, reverseToolNameMap),
            ThinkingText = GetString(element, "thinking"),
            Signature = GetString(element, "signature"),
            Data = GetString(element, "data"),
            CacheControl = element.TryGetProperty("cache_control", out var cacheControlElement) && cacheControlElement.ValueKind == JsonValueKind.Object
                ? ParseCacheControl(cacheControlElement)
                : null,
            AdditionalData = CaptureAdditionalData(
                element,
                "type",
                "text",
                "id",
                "name",
                "input",
                "source",
                "tool_use_id",
                "is_error",
                "content",
                "thinking",
                "signature",
                "data",
                "cache_control")
        };
    }

    private static IReadOnlyList<ClaudeContentBlock>? ParseNestedContentBlocks(
        JsonElement element,
        IReadOnlyDictionary<string, string> reverseToolNameMap)
    {
        if (!element.TryGetProperty("content", out var contentElement))
        {
            return null;
        }

        return contentElement.ValueKind switch
        {
            JsonValueKind.Array => ParseContentBlocks(contentElement, reverseToolNameMap),
            JsonValueKind.Object => new[] { ParseContentBlock(contentElement, reverseToolNameMap) },
            JsonValueKind.String => new[] { ClaudeContentBlock.TextBlock(contentElement.GetString() ?? string.Empty) },
            _ => null
        };
    }

    private static ClaudeCacheControl ParseCacheControl(JsonElement element) =>
        new()
        {
            Type = ParseCacheControlType(GetString(element, "type")),
            Ttl = GetString(element, "ttl"),
            Scope = GetString(element, "scope"),
            AdditionalData = CaptureAdditionalData(element, "type", "ttl", "scope")
        };

    private static ClaudeStopReason ParseStopReason(string? value) =>
        value switch
        {
            "end_turn" => ClaudeStopReason.EndTurn,
            "max_tokens" => ClaudeStopReason.MaxTokens,
            "stop_sequence" => ClaudeStopReason.StopSequence,
            "tool_use" => ClaudeStopReason.ToolUse,
            "pause_turn" => ClaudeStopReason.PauseTurn,
            "refusal" => ClaudeStopReason.Refusal,
            _ => ClaudeStopReason.Unknown
        };

    private static ClaudeStreamEventType ParseStreamEventType(string? eventName, string? payloadType) =>
        (eventName ?? payloadType) switch
        {
            "message_start" => ClaudeStreamEventType.MessageStart,
            "message_delta" => ClaudeStreamEventType.MessageDelta,
            "message_stop" => ClaudeStreamEventType.MessageStop,
            "content_block_start" => ClaudeStreamEventType.ContentBlockStart,
            "content_block_delta" => ClaudeStreamEventType.ContentBlockDelta,
            "content_block_stop" => ClaudeStreamEventType.ContentBlockStop,
            "ping" => ClaudeStreamEventType.Ping,
            _ => ClaudeStreamEventType.Unknown
        };

    private static string? GetString(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;

    private static int? GetInt32(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var property) && property.TryGetInt32(out var value)
            ? value
            : null;

    private static bool? GetBoolean(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var property) && (property.ValueKind is JsonValueKind.True or JsonValueKind.False)
            ? property.GetBoolean()
            : null;

    private static Dictionary<string, JsonElement>? CaptureAdditionalData(JsonElement element, params string[] knownProperties)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var known = knownProperties.ToHashSet(StringComparer.OrdinalIgnoreCase);
        Dictionary<string, JsonElement>? additional = null;
        foreach (var property in element.EnumerateObject())
        {
            if (known.Contains(property.Name))
            {
                continue;
            }

            additional ??= new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            additional[property.Name] = property.Value.Clone();
        }

        return additional;
    }

    private static string BuildExcerpt(string rawBody, int maxLength = 240)
    {
        var normalized = rawBody.Trim();
        if (normalized.Length <= maxLength)
        {
            return normalized;
        }

        return normalized[..(maxLength - 3)] + "...";
    }

    private static ClaudeSuscriptionException CreateResponseException(
        HttpStatusCode statusCode,
        string requestId,
        string rawBody)
    {
        var excerpt = BuildExcerpt(rawBody);
        if (DetectThirdPartyUsageClassification(rawBody))
        {
            return new ClaudeThirdPartyUsageException(
                $"Anthropic classified the request as third-party extra usage. {excerpt}",
                statusCode,
                requestId,
                excerpt);
        }

        if (statusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            return new ClaudeAuthenticationException(
                $"Anthropic rejected the OAuth credentials. {excerpt}",
                statusCode,
                requestId,
                excerpt);
        }

        return new ClaudeApiException(
            $"Anthropic returned an API error. {excerpt}",
            statusCode,
            requestId,
            excerpt);
    }

    private static bool DetectThirdPartyUsageClassification(string value)
    {
        var lower = value.ToLowerInvariant();
        return lower.Contains("third-party apps now draw from your extra usage", StringComparison.Ordinal) ||
               (lower.Contains("$200 credit", StringComparison.Ordinal) &&
                lower.Contains("claude.ai/settings/usage", StringComparison.Ordinal));
    }

    private static string GetStainlessOs()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return "Windows";
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return "MacOS";
        }

        return "Linux";
    }

    private sealed record PreparedRequest(
        string BodyJson,
        IReadOnlyDictionary<string, string> Headers,
        ClaudeOperationMetadata Metadata,
        IReadOnlyDictionary<string, string> ReverseToolNameMap);

    private sealed record AccessResult(
        ClaudeOAuthSnapshot Snapshot,
        ClaudeOAuthSnapshot? RefreshedSnapshot);

    private sealed record ExtractedSystem(
        IReadOnlyList<ClaudeSystemBlock> RelocatedSystemText,
        IReadOnlyList<JsonNode> PreservedSystemEntries);

    private sealed record ToolBridgeResult(
        IReadOnlyList<ClaudeToolDefinition> MappedTools,
        IReadOnlyDictionary<string, string> OutboundToolNameMap,
        IReadOnlyDictionary<string, string> ReverseToolNameMap)
    {
        public bool HasTools => MappedTools.Count > 0;
    }
}
