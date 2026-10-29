using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

public class CreateExchangeRequest
{
    public string HubId { get; set; }
    public string ProjectId { get; set; }
    public string VersionId { get; set; }
    public string ExchangeName { get; set; }
    // Revit files: name of a published 3D view
    public string ViewName { get; set; }
    // Revit cloud models (AEC Data Model) and IFC files: RSQL filter
    public string Filter { get; set; }
}

[ApiController]
[Route("api/[controller]")]
public class ExchangesController : ControllerBase
{
    private readonly APS _aps;

    public ExchangesController(APS aps)
    {
        _aps = aps;
    }

    // Tells the Viewer extension what kind of source the design is, and so which dialog to show
    [HttpGet("source")]
    public async Task<ActionResult> GetSource([FromQuery] string hubId, [FromQuery] string projectId, [FromQuery] string versionId)
    {
        var tokens = await AuthController.PrepareTokens(Request, Response, _aps);
        if (tokens == null)
        {
            return Unauthorized();
        }
        if (string.IsNullOrEmpty(hubId) || string.IsNullOrEmpty(projectId) || string.IsNullOrEmpty(versionId))
        {
            return BadRequest("Missing hub, project, or version ID.");
        }
        return Ok(await _aps.GetSourceInfo(hubId, projectId, versionId, tokens));
    }

    // Starts the creation of an exchange in the folder of the source design
    [HttpPost()]
    public async Task<ActionResult> CreateExchange([FromBody] CreateExchangeRequest request)
    {
        var tokens = await AuthController.PrepareTokens(Request, Response, _aps);
        if (tokens == null)
        {
            return Unauthorized();
        }
        if (string.IsNullOrEmpty(request.HubId) || string.IsNullOrEmpty(request.ProjectId) || string.IsNullOrEmpty(request.VersionId))
        {
            return BadRequest("Missing hub, project, or version ID.");
        }
        var exchangeName = request.ExchangeName?.Trim();
        if (string.IsNullOrEmpty(exchangeName))
        {
            return BadRequest("The exchange name must not be empty.");
        }
        var source = await _aps.GetSourceInfo(request.HubId, request.ProjectId, request.VersionId, tokens);
        string viewName = null, filter = null;
        switch (source.Kind)
        {
            case SourceKind.Revit:
                viewName = request.ViewName?.Trim();
                if (string.IsNullOrEmpty(viewName))
                {
                    return BadRequest("Pick the published 3D view to create the exchange from.");
                }
                break;
            case SourceKind.AecDataModel:
            case SourceKind.Ifc:
                filter = request.Filter?.Trim();
                if (string.IsNullOrEmpty(filter))
                {
                    return BadRequest("The filter must not be empty.");
                }
                break;
            default:
                return BadRequest(source.Reason);
        }

        try
        {
            var folderId = await _aps.GetDataExchangeFolderId(request.HubId, request.ProjectId, source.FolderId, source.Region, tokens);
            // Data Exchange doesn't create a second exchange with the same name in a folder
            if (await _aps.FindExchangeInFolder(folderId, exchangeName, source.Region, tokens) != null)
            {
                return Conflict($"An exchange named \"{exchangeName}\" already exists in this folder. Choose another name.");
            }
            var fileId = await _aps.GetDataExchangeFileId(folderId, request.HubId, request.ProjectId, source.FolderId, source.ItemId, source.FileName, source.Region, tokens);
            var exchange = await _aps.CreateExchange(fileId, folderId, exchangeName, viewName, filter, source.Region, tokens);
            return Accepted(new { id = exchange.Id, name = exchange.Name, region = source.Region });
        }
        catch (ApplicationException ex)
        {
            // Data Exchange GraphQL errors (e.g., an unknown view, an invalid filter), reported as they are
            return StatusCode(StatusCodes.Status502BadGateway, ex.Message);
        }
    }

    // Status of an exchange being created: IN_PROGRESS, COMPLETED or FAILED, or UNAVAILABLE right after the creation
    // was requested, when Data Exchange doesn't know the exchange yet (it answers "404 Not Found" for a while)
    [HttpGet("status")]
    public async Task<ActionResult> GetStatus([FromQuery] string id, [FromQuery] string region)
    {
        var tokens = await AuthController.PrepareTokens(Request, Response, _aps);
        if (tokens == null)
        {
            return Unauthorized();
        }
        if (string.IsNullOrEmpty(id))
        {
            return BadRequest("Missing exchange ID.");
        }
        try
        {
            var status = await _aps.GetExchangeCreationStatus(id, region, tokens);
            return Ok(new { status = status.Status, versionNumber = status.VersionNumber });
        }
        catch (Exception ex) when (ex is ApplicationException or APSException)
        {
            return Ok(new { status = "UNAVAILABLE", message = ex.Message });
        }
    }

    // What a created exchange contains (counts per category, and IDs to find its elements in the source model).
    // ACC can preview an exchange created from a filter with the views of its source, so the panel shows this instead.
    [HttpGet("contents")]
    public async Task<ActionResult> GetContents([FromQuery] string id, [FromQuery] string region)
    {
        var tokens = await AuthController.PrepareTokens(Request, Response, _aps);
        if (tokens == null)
        {
            return Unauthorized();
        }
        if (string.IsNullOrEmpty(id))
        {
            return BadRequest("Missing exchange ID.");
        }
        try
        {
            return Ok(await _aps.GetExchangeContents(id, region, tokens));
        }
        catch (ApplicationException ex)
        {
            return StatusCode(StatusCodes.Status502BadGateway, ex.Message);
        }
    }
}
