using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

public static class ApsConfigurationExtensions
{
    public const string ClientIdKey = "APS_CLIENT_ID";
    public const string ClientSecretKey = "APS_CLIENT_SECRET";
    public const string CallbackUrlKey = "APS_CALLBACK_URL";

    public static IServiceCollection AddExchangeMakerConfiguration(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<ApsOptions>(options => BindApsOptions(configuration, options));
        services.Configure<AppSettingsOptions>(configuration.GetSection(AppSettingsOptions.SectionName));
        return services;
    }

    public static ApsOptions GetApsOptions(IConfiguration configuration)
    {
        var options = new ApsOptions();
        BindApsOptions(configuration, options);
        return options;
    }

    private static void BindApsOptions(IConfiguration configuration, ApsOptions options)
    {
        configuration.GetSection(ApsOptions.SectionName).Bind(options);
        // The flat keys win over the nested section
        if (!string.IsNullOrWhiteSpace(configuration[ClientIdKey]))
        {
            options.ClientId = configuration[ClientIdKey];
        }
        if (!string.IsNullOrWhiteSpace(configuration[ClientSecretKey]))
        {
            options.ClientSecret = configuration[ClientSecretKey];
        }
        if (!string.IsNullOrWhiteSpace(configuration[CallbackUrlKey]))
        {
            options.RedirectUri = configuration[CallbackUrlKey];
        }
    }
}
