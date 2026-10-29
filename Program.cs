using System;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

// Always load the local settings (credentials for local runs), then let environment variables win (Dokku config vars)
builder.Configuration.AddJsonFile("appsettings.Development.json", optional: true, reloadOnChange: true);
builder.Configuration.AddEnvironmentVariables();

// Dokku (and Heroku-style platforms) set PORT: listen on it, behind the platform's nginx
var port = Environment.GetEnvironmentVariable("PORT");
var onPlatform = !string.IsNullOrEmpty(port);
if (onPlatform)
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
}

builder.Services.AddExchangeMakerConfiguration(builder.Configuration);
var apsOptions = ApsConfigurationExtensions.GetApsOptions(builder.Configuration);
if (string.IsNullOrEmpty(apsOptions.ClientId) || string.IsNullOrEmpty(apsOptions.ClientSecret))
{
    throw new ApplicationException("Missing required settings APS_CLIENT_ID or APS_CLIENT_SECRET (environment variables or appsettings.Development.json).");
}

builder.Services.AddControllers().AddJsonOptions(options =>
{
    options.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
});
builder.Services.AddSingleton(new APS(apsOptions.ClientId, apsOptions.ClientSecret));
builder.Services.AddSingleton<OAuthRedirectUriResolver>();

var app = builder.Build();

if (apsOptions.BehindProxy || onPlatform)
{
    // nginx terminates HTTPS: take the scheme and client address from its forwarded headers
    var forwardedHeaders = new ForwardedHeadersOptions
    {
        ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
    };
    forwardedHeaders.KnownNetworks.Clear();
    forwardedHeaders.KnownProxies.Clear();
    app.UseForwardedHeaders(forwardedHeaders);
}
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapControllers();

app.Run();
