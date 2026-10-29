// APS settings. The credentials come from the flat keys APS_CLIENT_ID, APS_CLIENT_SECRET and APS_CALLBACK_URL
// (environment variables, or appsettings.Development.json for local runs), or from the nested "Aps" section
// (e.g., the environment variable Aps__ClientId)
public class ApsOptions
{
    public const string SectionName = "Aps";

    public string ClientId { get; set; }
    public string ClientSecret { get; set; }
    // Must match a callback URL registered in the APS app
    public string RedirectUri { get; set; } = "http://localhost:8080/api/auth/callback";
    // Trust the X-Forwarded-* headers of a reverse proxy (always on when the platform sets PORT, e.g., Dokku)
    public bool BehindProxy { get; set; }
}
