// Public address of the app, used to build the OAuth callback URL when APS_CALLBACK_URL points to localhost
public class AppSettingsOptions
{
    public const string SectionName = "AppSettings";

    public string AppUrl { get; set; } = "http://localhost:8080";
}
