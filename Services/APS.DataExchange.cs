using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

public class Exchange
{
    public string Id;
    public string Name;
}

public class ExchangeCreationStatus
{
    public string Status;
    public int? VersionNumber;
}

// What an exchange contains, read from its elements. Properties, not fields, since it's returned as JSON.
public class ExchangeContents
{
    public int ElementCount { get; set; }
    // Instances per category (Revit: "Revit Category Type Id"); type elements are counted separately
    public Dictionary<string, int> Categories { get; set; } = new();
    public int TypeCount { get; set; }
    // To find the elements in the source model: Revit UniqueIds (the viewer's external IDs), IFC GlobalIds
    public List<string> ExternalIds { get; set; } = new();
    public List<string> GlobalIds { get; set; } = new();
    // More elements than MaxContentPages pages
    public bool Truncated { get; set; }
}

public partial class APS
{
    private const string DataExchangeUrl = "https://developer.api.autodesk.com/dataexchange/2023-05/graphql";

    // operation names the call in error messages, since several calls can fail with the same generic error
    private static async Task<JsonNode> QueryDataExchange(string operation, string query, JsonObject variables, string region, Tokens tokens)
    {
        var headers = new Dictionary<string, string>();
        if (!string.IsNullOrEmpty(region) && region != "US")
        {
            headers["Region"] = region;
        }
        var result = await PostAsync(DataExchangeUrl, tokens.InternalToken, new JsonObject { ["query"] = query, ["variables"] = variables }, headers: headers);
        var errors = result["errors"]?.AsArray();
        if (errors != null && errors.Count > 0)
        {
            // Include the path and the error code (extensions) when present, they tell more than the message
            throw new ApplicationException($"Data Exchange {operation} failed: " + string.Join("; ", errors.Select(error =>
            {
                var details = new[] { error["path"]?.ToJsonString(), error["extensions"]?.ToJsonString() }.Where(d => d != null);
                return $"{(string)error["message"]} {string.Join(" ", details)}".Trim();
            })));
        }
        return result["data"];
    }

    // Data Exchange IDs are base64-encoded strings such as "fold~<hub>~<project>~<folder>" or
    // "item~<hub>~<project>~<folder>~<item>", built from the Data Management IDs. For ACC IDs the encoding never
    // needs padding or the characters where standard and URL-safe base64 differ, so any base64 encoder gives the same ID
    private static string DataExchangeId(params string[] parts)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join("~", parts)));
    }

    public async Task<string> GetDataExchangeFolderId(string hubId, string projectId, string folderId, string region, Tokens tokens)
    {
        const string query = "query GetFolder($folderId: ID!) { folder(folderId: $folderId) { id name } }";
        string id;
        try
        {
            var data = await QueryDataExchange("folder lookup", query, new JsonObject { ["folderId"] = DataExchangeId("fold", hubId, projectId, folderId) }, region, tokens);
            id = (string)data?["folder"]?["id"];
        }
        catch (Exception ex)
        {
            throw new ApplicationException($"Could not find the folder in the Data Exchange API. {ex.Message}");
        }
        return id ?? throw new ApplicationException("Could not find the folder in the Data Exchange API.");
    }

    public async Task<string> GetDataExchangeFileId(string dataExchangeFolderId, string hubId, string projectId, string folderId, string itemId, string fileName, string region, Tokens tokens)
    {
        const string query = @"query GetFolderItems($folderId: ID!) {
            folder(folderId: $folderId) {
                items {
                    ... on Items {
                        results { id name }
                    }
                }
            }
        }";
        try
        {
            var data = await QueryDataExchange("folder items", query, new JsonObject { ["folderId"] = dataExchangeFolderId }, region, tokens);
            var match = data["folder"]["items"]["results"].AsArray().FirstOrDefault(item => (string)item["name"] == fileName);
            if (match != null)
            {
                return (string)match["id"];
            }
        }
        catch (Exception)
        {
            // Fall back to building the ID ourselves
        }
        return DataExchangeId("item", hubId, projectId, folderId, itemId);
    }

    public async Task<Exchange> FindExchangeInFolder(string dataExchangeFolderId, string exchangeName, string region, Tokens tokens)
    {
        const string query = "query GetFolderExchanges($folderId: ID!) { folder(folderId: $folderId) { exchanges { results { id name } } } }";
        var data = await QueryDataExchange("folder exchanges", query, new JsonObject { ["folderId"] = dataExchangeFolderId }, region, tokens);
        var match = data["folder"]["exchanges"]["results"].AsArray().FirstOrDefault(exchange => (string)exchange["name"] == exchangeName);
        return match == null ? null : new Exchange { Id = (string)match["id"], Name = (string)match["name"] };
    }

    // Exactly one of viewName (Revit 3D view) and filter (AEC Data Model or IFC filter, in RSQL) must be given.
    // The mutation only starts the creation: the exchange's status tells when it's done (getExchangeCreationStatus).
    public async Task<Exchange> CreateExchange(string fileId, string folderId, string exchangeName, string viewName, string filter, string region, Tokens tokens)
    {
        const string mutation = @"mutation CreateExchange($input: CreateExchangeInput!) {
            createExchange(input: $input) {
                exchange { id name }
                error { exchangeId code message }
            }
        }";
        var input = new JsonObject
        {
            ["source"] = new JsonObject { ["fileId"] = fileId },
            ["target"] = new JsonObject { ["name"] = exchangeName, ["folderId"] = folderId }
        };
        if (viewName != null)
        {
            input["viewName"] = viewName;
        }
        else
        {
            input["filter"] = filter;
        }
        var data = await QueryDataExchange("createExchange", mutation, new JsonObject { ["input"] = input }, region, tokens);
        var result = data["createExchange"];
        var error = result?["error"];
        if (error != null && ((string)error["code"] != null || (string)error["message"] != null))
        {
            throw new ApplicationException($"Data Exchange createExchange failed: {(string)error["message"]} ({(string)error["code"]})");
        }
        var exchange = result?["exchange"] ?? throw new ApplicationException("Data Exchange createExchange returned no exchange.");
        return new Exchange { Id = (string)exchange["id"], Name = (string)exchange["name"] };
    }

    public async Task<ExchangeCreationStatus> GetExchangeCreationStatus(string exchangeId, string region, Tokens tokens)
    {
        const string query = @"query GetExchangeStatus($exchangeId: ID!) {
            getExchangeCreationStatus(exchangeId: $exchangeId) {
                status
                versionNumber
            }
        }";
        var data = await QueryDataExchange("getExchangeCreationStatus", query, new JsonObject { ["exchangeId"] = exchangeId }, region, tokens);
        var status = data?["getExchangeCreationStatus"] ?? throw new ApplicationException("Data Exchange getExchangeCreationStatus returned no status.");
        return new ExchangeCreationStatus { Status = (string)status["status"], VersionNumber = (int?)status["versionNumber"] };
    }

    private const int ContentPageSize = 100;
    private const int MaxContentPages = 100;

    public async Task<ExchangeContents> GetExchangeContents(string exchangeId, string region, Tokens tokens)
    {
        const string query = @"query GetExchangeElements($exchangeId: ID!, $pagination: PaginationInput) {
            exchange(exchangeId: $exchangeId) {
                elements(pagination: $pagination) {
                    pagination { cursor }
                    results {
                        properties(filter: { names: [""Revit Category Type Id"", ""category"", ""Element Context"", ""External ID"", ""IfcGUID"", ""GlobalId"", ""GLOBALID""] }) {
                            results { name value }
                        }
                    }
                }
            }
        }";
        var contents = new ExchangeContents();
        string cursor = null;
        for (var page = 0; ; page++)
        {
            if (page == MaxContentPages)
            {
                contents.Truncated = true;
                break;
            }
            var pagination = new JsonObject { ["limit"] = ContentPageSize };
            if (cursor != null)
            {
                pagination["cursor"] = cursor;
            }
            var data = await QueryDataExchange("exchange elements", query, new JsonObject { ["exchangeId"] = exchangeId, ["pagination"] = pagination }, region, tokens);
            var elements = data["exchange"]["elements"];
            foreach (var element in elements["results"].AsArray())
            {
                var properties = element["properties"]["results"].AsArray()
                    .GroupBy(property => (string)property["name"])
                    .ToDictionary(group => group.Key, group => group.First()["value"]?.ToString());
                contents.ElementCount++;
                if (properties.GetValueOrDefault("Element Context") == "Type")
                {
                    contents.TypeCount++;
                    continue;
                }
                var category = properties.GetValueOrDefault("Revit Category Type Id") ?? properties.GetValueOrDefault("category") ?? "(no category)";
                contents.Categories[category] = contents.Categories.GetValueOrDefault(category) + 1;
                if (properties.GetValueOrDefault("External ID") is string externalId)
                {
                    contents.ExternalIds.Add(externalId);
                }
                if ((properties.GetValueOrDefault("IfcGUID") ?? properties.GetValueOrDefault("GlobalId") ?? properties.GetValueOrDefault("GLOBALID")) is string globalId)
                {
                    contents.GlobalIds.Add(globalId);
                }
            }
            cursor = (string)elements["pagination"]?["cursor"];
            if (string.IsNullOrEmpty(cursor))
            {
                break;
            }
        }
        return contents;
    }
}
