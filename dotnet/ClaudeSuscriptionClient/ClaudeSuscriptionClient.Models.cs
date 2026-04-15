using System.Text.Json;

namespace ClaudeSuscriptionClient;

public interface IClaudeOAuthCredentialStore
{
    Task<ClaudeOAuthSnapshot> GetAsync(CancellationToken cancellationToken);

    Task SaveAsync(ClaudeOAuthSnapshot snapshot, CancellationToken cancellationToken);
}

public sealed class ClaudeSuscriptionClientOptions
{
    public Uri MessagesEndpoint { get; init; } = new("https://api.anthropic.com/v1/messages?beta=true");

    public Uri OAuthTokenEndpoint { get; init; } = new("https://claude.ai/v1/oauth/token");

    public string ClaudeCodeVersion { get; init; } = "2.1.104";

    public ClaudeClientEntrypoint Entrypoint { get; init; } = ClaudeClientEntrypoint.SdkCli;

    public int DefaultMaxTokens { get; init; } = 4096;

    public ClaudeEffortLevel? DefaultThinkingEffort { get; init; } = ClaudeEffortLevel.High;

    public bool Enable1MContext { get; init; }

    public string? MetadataUserId { get; init; }

    public Func<ClaudeOAuthRefreshNotification, CancellationToken, Task>? OnOAuthRefreshedAsync { get; init; }
}

public sealed class ClaudeOAuthSnapshot
{
    public required string AccessToken { get; init; }

    public required string RefreshToken { get; init; }

    public DateTimeOffset ExpiresAtUtc { get; init; }

    public IReadOnlyList<string> Scopes { get; init; } = Array.Empty<string>();

    public string? SubscriptionType { get; init; }

    public string? RateLimitTier { get; init; }

    public string? OrganizationUuid { get; init; }
}

public sealed class ClaudeOAuthRefreshNotification
{
    public required ClaudeOAuthSnapshot PreviousSnapshot { get; init; }

    public required ClaudeOAuthSnapshot RefreshedSnapshot { get; init; }

    public required DateTimeOffset RefreshedAtUtc { get; init; }
}

public sealed class ClaudeOperationMetadata
{
    public bool OAuthRefreshed { get; init; }

    public ClaudeOAuthSnapshot? RefreshedSnapshot { get; init; }

    public required string SessionId { get; init; }

    public required string RequestId { get; init; }

    public IReadOnlyList<string> AppliedBetas { get; init; } = Array.Empty<string>();
}

public sealed class ClaudeMessageRequest
{
    public required string Model { get; init; }

    public IReadOnlyList<ClaudeMessage> Messages { get; init; } = Array.Empty<ClaudeMessage>();

    public IReadOnlyList<ClaudeSystemBlock> System { get; init; } = Array.Empty<ClaudeSystemBlock>();

    public int? MaxTokens { get; init; }

    public double? Temperature { get; init; }

    public string? MetadataUserId { get; init; }

    public IReadOnlyList<ClaudeToolDefinition>? Tools { get; init; }

    public ClaudeToolChoice? ToolChoice { get; init; }

    public ClaudeThinkingOptions? Thinking { get; init; }

    public ClaudeOutputOptions? Output { get; init; }

    public ClaudeEffortLevel? Effort { get; init; }
}

public sealed class ClaudeMessage
{
    public required ClaudeMessageRole Role { get; init; }

    public IReadOnlyList<ClaudeContentBlock> Content { get; init; } = Array.Empty<ClaudeContentBlock>();

    public Dictionary<string, JsonElement>? AdditionalData { get; init; }

    public static ClaudeMessage User(params ClaudeContentBlock[] content) =>
        new()
        {
            Role = ClaudeMessageRole.User,
            Content = content
        };

    public static ClaudeMessage Assistant(params ClaudeContentBlock[] content) =>
        new()
        {
            Role = ClaudeMessageRole.Assistant,
            Content = content
        };

    public static ClaudeMessage UserText(string text) =>
        User(ClaudeContentBlock.TextBlock(text));

    public static ClaudeMessage AssistantText(string text) =>
        Assistant(ClaudeContentBlock.TextBlock(text));
}

public sealed class ClaudeContentBlock
{
    public required ClaudeContentBlockType Type { get; init; }

    public string? Text { get; init; }

    public string? Id { get; init; }

    public string? Name { get; init; }

    public JsonElement? Input { get; init; }

    public JsonElement? Source { get; init; }

    public string? ToolUseId { get; init; }

    public bool? IsError { get; init; }

    public IReadOnlyList<ClaudeContentBlock>? Content { get; init; }

    public string? ThinkingText { get; init; }

    public string? Signature { get; init; }

    public string? Data { get; init; }

    public ClaudeCacheControl? CacheControl { get; init; }

    public Dictionary<string, JsonElement>? AdditionalData { get; init; }

    public static ClaudeContentBlock TextBlock(string text, ClaudeCacheControl? cacheControl = null) =>
        new()
        {
            Type = ClaudeContentBlockType.Text,
            Text = text,
            CacheControl = cacheControl
        };

    public static ClaudeContentBlock ImageBase64(
        string data,
        ClaudeImageMediaType mediaType,
        ClaudeCacheControl? cacheControl = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        ImageBase64(data, ToImageMediaTypeValue(mediaType), cacheControl, additionalData);

    public static ClaudeContentBlock ImageBase64(
        string data,
        string mediaType,
        ClaudeCacheControl? cacheControl = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Type = ClaudeContentBlockType.Image,
            Source = SerializeToElement(new
            {
                type = "base64",
                media_type = mediaType,
                data
            }),
            CacheControl = cacheControl,
            AdditionalData = additionalData
        };

    public static ClaudeContentBlock DocumentBase64(
        string data,
        ClaudeDocumentMediaType mediaType,
        ClaudeCacheControl? cacheControl = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        DocumentBase64(data, ToDocumentMediaTypeValue(mediaType), cacheControl, additionalData);

    public static ClaudeContentBlock DocumentBase64(
        string data,
        string mediaType,
        ClaudeCacheControl? cacheControl = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Type = ClaudeContentBlockType.Document,
            Source = SerializeToElement(new
            {
                type = "base64",
                media_type = mediaType,
                data
            }),
            CacheControl = cacheControl,
            AdditionalData = additionalData
        };

    public static ClaudeContentBlock ToolUse(
        string id,
        string name,
        object? input = null,
        ClaudeCacheControl? cacheControl = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Type = ClaudeContentBlockType.ToolUse,
            Id = id,
            Name = name,
            Input = SerializeNullableToElement(input),
            CacheControl = cacheControl,
            AdditionalData = additionalData
        };

    public static ClaudeContentBlock ToolResult(
        string toolUseId,
        IReadOnlyList<ClaudeContentBlock> content,
        bool isError = false,
        ClaudeCacheControl? cacheControl = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Type = ClaudeContentBlockType.ToolResult,
            ToolUseId = toolUseId,
            Content = content,
            IsError = isError ? true : null,
            CacheControl = cacheControl,
            AdditionalData = additionalData
        };

    public static ClaudeContentBlock ToolResultText(
        string toolUseId,
        string text,
        bool isError = false,
        ClaudeCacheControl? cacheControl = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        ToolResult(toolUseId, new[] { TextBlock(text) }, isError, cacheControl, additionalData);

    public static ClaudeContentBlock Thinking(
        string thinkingText,
        string? signature = null,
        ClaudeCacheControl? cacheControl = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Type = ClaudeContentBlockType.Thinking,
            ThinkingText = thinkingText,
            Signature = signature,
            CacheControl = cacheControl,
            AdditionalData = additionalData
        };

    public static ClaudeContentBlock RedactedThinking(
        string data,
        ClaudeCacheControl? cacheControl = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Type = ClaudeContentBlockType.RedactedThinking,
            Data = data,
            CacheControl = cacheControl,
            AdditionalData = additionalData
        };

    private static JsonElement SerializeToElement<TValue>(TValue value)
    {
        if (value is JsonElement element)
        {
            return element.Clone();
        }

        if (value is JsonDocument document)
        {
            return document.RootElement.Clone();
        }

        return JsonSerializer.SerializeToElement(value);
    }

    private static JsonElement? SerializeNullableToElement(object? value) =>
        value is null ? null : SerializeToElement(value);

    private static string ToImageMediaTypeValue(ClaudeImageMediaType mediaType) =>
        mediaType switch
        {
            ClaudeImageMediaType.Jpeg => "image/jpeg",
            ClaudeImageMediaType.Png => "image/png",
            ClaudeImageMediaType.Gif => "image/gif",
            ClaudeImageMediaType.Webp => "image/webp",
            _ => "image/png"
        };

    private static string ToDocumentMediaTypeValue(ClaudeDocumentMediaType mediaType) =>
        mediaType switch
        {
            ClaudeDocumentMediaType.Pdf => "application/pdf",
            _ => "application/pdf"
        };
}

public sealed class ClaudeSystemBlock
{
    public required string Type { get; init; }

    public string? Text { get; init; }

    public ClaudeCacheControl? CacheControl { get; init; }

    public Dictionary<string, JsonElement>? AdditionalData { get; init; }

    public static ClaudeSystemBlock TextBlock(string text, ClaudeCacheControl? cacheControl = null) =>
        new()
        {
            Type = "text",
            Text = text,
            CacheControl = cacheControl
        };

    public static ClaudeSystemBlock Custom(
        string type,
        string? text = null,
        ClaudeCacheControl? cacheControl = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Type = type,
            Text = text,
            CacheControl = cacheControl,
            AdditionalData = additionalData
        };
}

public sealed class ClaudeCacheControl
{
    public ClaudeCacheControlType? Type { get; init; }

    public string? Ttl { get; init; }

    public string? Scope { get; init; }

    public Dictionary<string, JsonElement>? AdditionalData { get; init; }

    public static ClaudeCacheControl Ephemeral(
        string? ttl = null,
        string? scope = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Type = ClaudeCacheControlType.Ephemeral,
            Ttl = ttl,
            Scope = scope,
            AdditionalData = additionalData
        };

    public static ClaudeCacheControl WorkspaceEphemeral(
        string? ttl = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        Ephemeral(ttl, "workspace", additionalData);
}

public sealed class ClaudeToolDefinition
{
    public required string Name { get; init; }

    public string? Description { get; init; }

    public JsonElement? InputSchema { get; init; }

    public Dictionary<string, JsonElement>? AdditionalData { get; init; }

    public static ClaudeToolDefinition Create(
        string name,
        JsonElement? inputSchema = null,
        string? description = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Name = name,
            Description = description,
            InputSchema = inputSchema,
            AdditionalData = additionalData
        };

    public static ClaudeToolDefinition Official(
        ClaudeOfficialTool tool,
        JsonElement? inputSchema = null,
        string? description = null,
        Dictionary<string, JsonElement>? additionalData = null) =>
        Create(ToOpenToolName(tool), inputSchema, description, additionalData);

    private static string ToOpenToolName(ClaudeOfficialTool tool) =>
        tool switch
        {
            ClaudeOfficialTool.Agent => "task",
            ClaudeOfficialTool.Bash => "bash",
            ClaudeOfficialTool.Edit => "edit",
            ClaudeOfficialTool.Glob => "glob",
            ClaudeOfficialTool.Grep => "grep",
            ClaudeOfficialTool.Read => "read",
            ClaudeOfficialTool.Write => "write",
            ClaudeOfficialTool.Skill => "skill",
            _ => "bash"
        };
}

public sealed class ClaudeToolChoice
{
    public required ClaudeToolChoiceType Type { get; init; }

    public string? Name { get; init; }

    public Dictionary<string, JsonElement>? AdditionalData { get; init; }

    public static ClaudeToolChoice Auto(Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Type = ClaudeToolChoiceType.Auto,
            AdditionalData = additionalData
        };

    public static ClaudeToolChoice Any(Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Type = ClaudeToolChoiceType.Any,
            AdditionalData = additionalData
        };

    public static ClaudeToolChoice Tool(
        string name,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Type = ClaudeToolChoiceType.Tool,
            Name = name,
            AdditionalData = additionalData
        };

    public static ClaudeToolChoice Official(
        ClaudeOfficialTool tool,
        Dictionary<string, JsonElement>? additionalData = null) =>
        Tool(ClaudeToolDefinition.Official(tool).Name, additionalData);
}

public sealed class ClaudeThinkingOptions
{
    public ClaudeEffortLevel? Effort { get; init; }

    public Dictionary<string, JsonElement>? AdditionalData { get; init; }

    public static ClaudeThinkingOptions Enabled(
        ClaudeEffortLevel effort,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Effort = effort,
            AdditionalData = additionalData
        };
}

public sealed class ClaudeOutputOptions
{
    public ClaudeEffortLevel? Effort { get; init; }

    public Dictionary<string, JsonElement>? AdditionalData { get; init; }

    public static ClaudeOutputOptions WithEffort(
        ClaudeEffortLevel effort,
        Dictionary<string, JsonElement>? additionalData = null) =>
        new()
        {
            Effort = effort,
            AdditionalData = additionalData
        };
}

public enum ClaudeEffortLevel
{
    Low,
    Medium,
    High
}

public enum ClaudeClientEntrypoint
{
    Cli,
    SdkCli
}

public enum ClaudeOfficialTool
{
    Agent,
    Bash,
    Edit,
    Glob,
    Grep,
    Read,
    Write,
    Skill
}

public enum ClaudeMessageRole
{
    User,
    Assistant
}

public enum ClaudeContentBlockType
{
    Text,
    Image,
    ToolUse,
    ToolResult,
    Thinking,
    RedactedThinking,
    Document,
    Unknown
}

public enum ClaudeImageMediaType
{
    Jpeg,
    Png,
    Gif,
    Webp
}

public enum ClaudeDocumentMediaType
{
    Pdf
}

public enum ClaudeToolChoiceType
{
    Auto,
    Any,
    Tool
}

public enum ClaudeCacheControlType
{
    Ephemeral
}

public enum ClaudeStopReason
{
    EndTurn,
    MaxTokens,
    StopSequence,
    ToolUse,
    PauseTurn,
    Refusal,
    Unknown
}

public sealed class ClaudeUsage
{
    public int? InputTokens { get; init; }

    public int? OutputTokens { get; init; }

    public int? CacheCreationInputTokens { get; init; }

    public int? CacheReadInputTokens { get; init; }

    public int? TotalTokens { get; init; }

    public Dictionary<string, JsonElement> AdditionalCounters { get; init; } = new(StringComparer.Ordinal);
}

public sealed class ClaudeMessageResponse
{
    public string? Id { get; init; }

    public string? Type { get; init; }

    public ClaudeMessageRole? Role { get; init; }

    public string? Model { get; init; }

    public ClaudeStopReason StopReason { get; init; }

    public IReadOnlyList<ClaudeContentBlock> Content { get; init; } = Array.Empty<ClaudeContentBlock>();

    public ClaudeUsage? Usage { get; init; }

    public required ClaudeOperationMetadata Metadata { get; init; }

    public Dictionary<string, JsonElement>? AdditionalData { get; init; }
}

public enum ClaudeStreamEventType
{
    MessageStart,
    MessageDelta,
    MessageStop,
    ContentBlockStart,
    ContentBlockDelta,
    ContentBlockStop,
    Ping,
    Done,
    Completed,
    Unknown
}

public sealed class ClaudeStreamEvent
{
    public ClaudeStreamEventType EventType { get; init; }

    public string? EventName { get; init; }

    public string? TextDelta { get; init; }

    public ClaudeContentBlock? ContentBlock { get; init; }

    public ClaudeUsage? Usage { get; init; }

    public ClaudeOperationMetadata? Metadata { get; init; }

    public JsonElement? Payload { get; init; }
}
