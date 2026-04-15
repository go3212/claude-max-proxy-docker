using System.Net;

namespace ClaudeSuscriptionClient;

public class ClaudeSuscriptionException : Exception
{
    public ClaudeSuscriptionException(
        string message,
        HttpStatusCode? statusCode = null,
        string? requestId = null,
        string? rawBodyExcerpt = null,
        Exception? innerException = null)
        : base(message, innerException)
    {
        StatusCode = statusCode;
        RequestId = requestId;
        RawBodyExcerpt = rawBodyExcerpt;
    }

    public HttpStatusCode? StatusCode { get; }

    public string? RequestId { get; }

    public string? RawBodyExcerpt { get; }
}

public sealed class ClaudeAuthenticationException : ClaudeSuscriptionException
{
    public ClaudeAuthenticationException(
        string message,
        HttpStatusCode? statusCode = null,
        string? requestId = null,
        string? rawBodyExcerpt = null,
        Exception? innerException = null)
        : base(message, statusCode, requestId, rawBodyExcerpt, innerException)
    {
    }
}

public sealed class ClaudeOAuthRefreshException : ClaudeSuscriptionException
{
    public ClaudeOAuthRefreshException(
        string message,
        HttpStatusCode? statusCode = null,
        string? requestId = null,
        string? rawBodyExcerpt = null,
        Exception? innerException = null)
        : base(message, statusCode, requestId, rawBodyExcerpt, innerException)
    {
    }
}

public sealed class ClaudeRequestValidationException : ClaudeSuscriptionException
{
    public ClaudeRequestValidationException(string message, Exception? innerException = null)
        : base(message, null, null, null, innerException)
    {
    }
}

public sealed class ClaudeApiException : ClaudeSuscriptionException
{
    public ClaudeApiException(
        string message,
        HttpStatusCode? statusCode = null,
        string? requestId = null,
        string? rawBodyExcerpt = null,
        Exception? innerException = null)
        : base(message, statusCode, requestId, rawBodyExcerpt, innerException)
    {
    }
}

public sealed class ClaudeThirdPartyUsageException : ClaudeSuscriptionException
{
    public ClaudeThirdPartyUsageException(
        string message,
        HttpStatusCode? statusCode = null,
        string? requestId = null,
        string? rawBodyExcerpt = null,
        Exception? innerException = null)
        : base(message, statusCode, requestId, rawBodyExcerpt, innerException)
    {
    }
}

public sealed class ClaudeProtocolException : ClaudeSuscriptionException
{
    public ClaudeProtocolException(
        string message,
        HttpStatusCode? statusCode = null,
        string? requestId = null,
        string? rawBodyExcerpt = null,
        Exception? innerException = null)
        : base(message, statusCode, requestId, rawBodyExcerpt, innerException)
    {
    }
}

public sealed class ClaudeStreamingException : ClaudeSuscriptionException
{
    public ClaudeStreamingException(
        string message,
        HttpStatusCode? statusCode = null,
        string? requestId = null,
        string? rawBodyExcerpt = null,
        Exception? innerException = null)
        : base(message, statusCode, requestId, rawBodyExcerpt, innerException)
    {
    }
}
