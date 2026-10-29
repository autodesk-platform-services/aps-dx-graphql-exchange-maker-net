using System;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;

// The OAuth callback URL for the current request. A configured URL is used as is, unless it points to localhost while the
// app runs on a server (e.g., a local default left in place on Dokku): then it's built from AppSettings:AppUrl or from the
// request's host, so sign-in doesn't redirect to localhost
public class OAuthRedirectUriResolver
{
    private const string CallbackPath = "/api/auth/callback";
    private readonly ApsOptions _apsOptions;
    private readonly AppSettingsOptions _appSettings;

    public OAuthRedirectUriResolver(IOptions<ApsOptions> apsOptions, IOptions<AppSettingsOptions> appSettings)
    {
        _apsOptions = apsOptions.Value;
        _appSettings = appSettings.Value;
    }

    public string Resolve(HttpRequest request)
    {
        var configured = _apsOptions.RedirectUri;
        if (!string.IsNullOrWhiteSpace(configured) && !IsLoopbackUrl(configured))
        {
            return configured.TrimEnd('/');
        }
        var appUrl = _appSettings.AppUrl;
        if (!string.IsNullOrWhiteSpace(appUrl) && !IsLoopbackUrl(appUrl))
        {
            return appUrl.TrimEnd('/') + CallbackPath;
        }
        if (!IsLoopbackHost(request.Host.Host))
        {
            return $"{request.Scheme}://{request.Host}{CallbackPath}";
        }
        // Running locally: the configured localhost URL, if any
        return !string.IsNullOrWhiteSpace(configured) ? configured.TrimEnd('/') : $"{request.Scheme}://{request.Host}{CallbackPath}";
    }

    private static bool IsLoopbackUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && IsLoopbackHost(uri.Host);

    private static bool IsLoopbackHost(string host) =>
        string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase) || host == "127.0.0.1";
}
