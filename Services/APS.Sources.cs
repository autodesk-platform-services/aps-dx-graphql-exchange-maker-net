using System;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

// How an exchange is created from a design, which decides the dialog the Viewer extension shows
public enum SourceKind
{
    // Revit file uploaded to ACC: the exchange is created from one of its published 3D views (viewName)
    Revit,
    // Revit cloud model (Revit Cloud Worksharing, "C4R"), available as AEC data: the exchange is created from an
    // AEC Data Model filter on category, family and type
    AecDataModel,
    // IFC file: the exchange is created from an IFC filter on ifcClass and ifcGlobalId
    Ifc,
    // Exchanges, and other file types, can't be the source of an exchange
    Unsupported
}

// Properties, not fields: System.Text.Json only serializes properties by default
public class SourceInfo
{
    public SourceKind Kind { get; set; }
    public string Reason { get; set; } // Why the design can't be used, when Kind is Unsupported
    public string FileName { get; set; }
    public string FileType { get; set; } // e.g., "rvt", "ifc"
    public string ItemId { get; set; }
    public string ItemType { get; set; } // e.g., "items:autodesk.bim360:File", "items:autodesk.bim360:C4RModel", "items:autodesk.bim360:FDX"
    public string FolderId { get; set; }
    public string Region { get; set; }
    public int VersionNumber { get; set; }
    // Exchanges are always created from the latest version of the source file
    public bool IsLatestVersion { get; set; }
    public int LatestVersionNumber { get; set; }
}

public partial class APS
{
    public async Task<SourceInfo> GetSourceInfo(string hubId, string projectId, string versionId, Tokens tokens)
    {
        var version = await GetAsync($"/data/v1/projects/{projectId}/versions/{Encode(versionId)}", tokens.InternalToken);
        var itemId = (string)version["data"]["relationships"]["item"]["data"]["id"];
        var item = await GetAsync($"/data/v1/projects/{projectId}/items/{Encode(itemId)}", tokens.InternalToken);
        var hub = await GetAsync($"/project/v1/hubs/{hubId}", tokens.InternalToken);
        var attributes = version["data"]["attributes"];
        // The item response includes its tip (latest) version
        var tipId = (string)item["data"]["relationships"]["tip"]?["data"]?["id"];
        var tip = item["included"]?.AsArray().FirstOrDefault(entry => (string)entry["id"] == tipId);
        var source = new SourceInfo
        {
            FileName = (string)attributes["name"],
            FileType = ((string)attributes["fileType"])?.ToLowerInvariant(),
            ItemId = itemId,
            ItemType = (string)item["data"]["attributes"]["extension"]?["type"],
            FolderId = (string)item["data"]["relationships"]["parent"]["data"]["id"],
            Region = (string)hub["data"]["attributes"]["region"] ?? "US",
            VersionNumber = (int?)attributes["versionNumber"] ?? 1,
            IsLatestVersion = tipId == null || tipId == versionId
        };
        source.LatestVersionNumber = (int?)tip?["attributes"]?["versionNumber"] ?? source.VersionNumber;
        (source.Kind, source.Reason) = Classify(source);
        return source;
    }

    private static (SourceKind, string) Classify(SourceInfo source)
    {
        if (source.ItemType?.EndsWith(":FDX", StringComparison.OrdinalIgnoreCase) == true)
        {
            return (SourceKind.Unsupported, "This design is an exchange. Exchanges are created from Revit or IFC files.");
        }
        if (source.ItemType?.EndsWith(":C4RModel", StringComparison.OrdinalIgnoreCase) == true)
        {
            return (SourceKind.AecDataModel, null);
        }
        return source.FileType switch
        {
            "rvt" => (SourceKind.Revit, null),
            "ifc" => (SourceKind.Ifc, null),
            _ => (SourceKind.Unsupported, $"Exchanges can't be created from {(source.FileType ?? "these").ToUpperInvariant()} files, only from Revit files, Revit cloud models and IFC files.")
        };
    }
}
