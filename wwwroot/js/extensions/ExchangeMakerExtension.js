import { BaseExtension } from './BaseExtension.js';
import { ExchangeMakerPanel } from './ExchangeMakerPanel.js';
import {
    getPublished3DViews, getLoadedViewName, findViewNode, getCategoryTree, getCategoryPath, getIfcData, findGlobalId,
    buildAecFilter, buildIfcFilter, typeKey
} from './ModelData.js';

const POLLING_INTERVAL = 5000; // ms
// Right after createExchange, the status query answers "404 Not Found" for a while
const MAX_STATUS_ERRORS = 30; // about 2.5 minutes at the polling interval

// Whenever the viewer loads another model or view while one is already loaded, it unloads all extensions and
// creates new instances (see Viewer3D.loadDocumentNode: tearDown() + setUp()). What must survive this is kept
// here at module level; the exchange being created is also saved in localStorage and tracked again in onModelLoaded.
const session = {
    design: null, // { hubId, projectId, itemId, versionId, viewGuid, name }, from the sidebar
    source: null, // What the server found out about the design (see SourceInfo in APS.Sources.cs)
    sourceError: null,
    sourcePromise: null,
    inputs: null, // What was picked in the dialog, see _resetInputs
    panelVisible: false,
    current: null // The extension instance in use
};

// Creates a Data Exchange from the design open in the viewer, with the dialog that fits the kind of design:
// - Revit file: one of its published 3D views,
// - Revit cloud model (AEC Data Model): elements picked by category, family and type,
// - IFC file: elements picked by IFC class and GlobalId.
class ExchangeMakerExtension extends BaseExtension {
    constructor(viewer, options) {
        super(viewer, options);
        this._button = null;
        this._panel = null;
        this._unloaded = false;
        this._modelData = null; // { views, loadedView } | { categories } | { ifc }, read from the loaded model
        this._modelDataError = null;
        this._exchange = null; // { id, name, region, status, details, error, statusErrors }
        this._starting = false; // A creation request is on its way
        this._pollingTimer = null;
    }

    load() {
        super.load();
        session.current = this;
        console.log('ExchangeMakerExtension loaded.');
        return true;
    }

    unload() {
        super.unload();
        this._unloaded = true;
        this._stopPolling();
        if (session.current === this) {
            session.current = null;
        }
        if (this._button) {
            this.removeToolbarButton(this._button);
            this._button = null;
        }
        if (this._panel) {
            this._panel.setVisible(false);
            this._panel.uninitialize();
            this._panel = null;
        }
        console.log('ExchangeMakerExtension unloaded.');
        return true;
    }

    onToolbarCreated() {
        this._panel = new ExchangeMakerPanel(this, 'exchange-maker-panel', 'Exchange Maker');
        this._button = this.createToolbarButton('exchange-maker-button',
            'https://raw.githubusercontent.com/primer/octicons/main/icons/package-dependents-24.svg',
            'Create an exchange from this design');
        this._button.onClick = () => this._setPanelVisible(!this._panel.isVisible());
        if (session.panelVisible) {
            this._setPanelVisible(true);
        }
    }

    _setPanelVisible(visible) {
        session.panelVisible = visible;
        this._panel.setVisible(visible);
        this._button.setState(visible ? Autodesk.Viewing.UI.Button.State.ACTIVE : Autodesk.Viewing.UI.Button.State.INACTIVE);
        this._panel.update();
    }

    // Called by the panel when it's closed with its own close button
    onPanelClosed() {
        if (this._unloaded) {
            return; // Hidden because the viewer is replacing this instance, not by the user
        }
        session.panelVisible = false;
        this._button?.setState(Autodesk.Viewing.UI.Button.State.INACTIVE);
    }

    get design() { return session.design; }
    get source() { return session.source; }
    get sourceError() { return session.sourceError; }
    get inputs() { return session.inputs; }
    get modelData() { return this._modelData; }
    get modelDataError() { return this._modelDataError; }
    get exchange() { return this._exchange; }
    get starting() { return this._starting; }
    get busy() { return this._starting || this._exchange?.status === 'inProgress'; }
    get viewerSelectionCount() { return this.viewer.getSelection().length; }

    // Called when a design version (or one of its views) is picked in the sidebar.
    // Note that this instance is usually replaced right after, when the viewer loads the new model.
    setDesign(design) {
        const sameVersion = session.design?.versionId === design.versionId;
        session.design = design;
        if (sameVersion) {
            return;
        }
        this._stopPolling();
        this._exchange = null;
        this._modelData = null;
        session.source = null;
        session.sourceError = null;
        session.inputs = this._resetInputs(design);
        // Ask the server what kind of source this is (Revit file, Revit cloud model, IFC file), which decides the dialog
        const query = new URLSearchParams({ hubId: design.hubId, projectId: design.projectId, versionId: design.versionId });
        const promise = session.sourcePromise = fetch(`/api/exchanges/source?${query}`)
            .then(async resp => {
                if (!resp.ok) {
                    throw new Error(await resp.text());
                }
                return resp.json();
            })
            .then(source => {
                if (session.sourcePromise === promise) {
                    session.source = source;
                }
                return source;
            })
            .catch(err => {
                console.error(err);
                if (session.sourcePromise === promise) {
                    session.sourceError = err.message;
                }
                return null;
            })
            .finally(() => session.current?._panel?.update());
        this._panel?.update();
    }

    async onModelLoaded(model) {
        super.onModelLoaded(model);
        if (!session.design) {
            return;
        }
        const versionId = session.design.versionId;
        const source = await session.sourcePromise;
        if (this._unloaded || !source || versionId !== session.design?.versionId) {
            return;
        }
        try {
            switch (source.kind) {
                case 'revit':
                    this._modelData = { views: getPublished3DViews(model), loadedView: getLoadedViewName(model) };
                    // Default to the view open in the viewer, if it's one that was published
                    if (!this._modelData.views.includes(session.inputs.viewName)) {
                        session.inputs.viewName = this._modelData.views.includes(this._modelData.loadedView)
                            ? this._modelData.loadedView : (this._modelData.views[0] || '');
                    }
                    break;
                case 'aecDataModel':
                    this._modelData = { categories: getCategoryTree(model) };
                    break;
                case 'ifc':
                    this._modelData = { ifc: await getIfcData(model) };
                    break;
            }
            this._modelDataError = null;
        } catch (err) {
            console.error(err);
            this._modelDataError = err.message || String(err);
        }
        if (this._unloaded) {
            return;
        }
        this._updateFilter();
        // Resume tracking of the last exchange requested for this design version, if any
        const saved = JSON.parse(localStorage.getItem(this._storageKey()) || 'null');
        if (saved && !this._exchange) {
            this._exchange = { ...saved, status: 'inProgress', details: 'Checking the status...', statusErrors: 0 };
            this._pollStatus();
        }
        this._panel?.update();
    }

    onSelectionChanged(model, dbids) {
        super.onSelectionChanged(model, dbids);
        this._panel?.update();
    }

    // Changes made in the dialog

    setInput(key, value) {
        session.inputs[key] = value;
        if (key === 'filter') {
            session.inputs.filterEdited = true;
        }
    }

    // Revit: opens one of the published views in the viewer (which replaces this extension instance)
    async openView(viewName) {
        const node = findViewNode(this.viewer.model, viewName);
        if (node) {
            await this.viewer.loadDocumentNode(node.getDocument(), node);
        }
    }

    // AEC Data Model: checks or unchecks types (a category or family checks all its types)
    setTypesChecked(keys, checked) {
        for (const key of keys) {
            if (checked) {
                session.inputs.checkedTypes.add(key);
            } else {
                session.inputs.checkedTypes.delete(key);
            }
        }
        this._updateFilter();
    }

    // AEC Data Model: checks the categories, families or types of the elements selected in the viewer
    checkViewerSelection() {
        const categories = this._modelData?.categories || [];
        const keys = [];
        for (const dbId of this.viewer.getSelection()) {
            const [categoryName, familyName, typeName] = getCategoryPath(this.viewer.model, dbId);
            for (const category of categories.filter(c => c.name === categoryName)) {
                for (const family of category.families.filter(f => familyName === undefined || f.name === familyName)) {
                    for (const type of family.types.filter(t => typeName === undefined || t.name === typeName)) {
                        keys.push(typeKey(category, family, type));
                    }
                }
            }
        }
        this.setTypesChecked(keys, true);
        return keys.length;
    }

    // IFC: checks or unchecks an IFC class
    setClassChecked(name, checked) {
        if (checked) {
            session.inputs.ifcClasses.add(name);
        } else {
            session.inputs.ifcClasses.delete(name);
        }
        this._updateFilter();
    }

    // IFC: adds the GlobalIds of the elements selected in the viewer
    addViewerSelectionGlobalIds() {
        const globalIds = this._modelData?.ifc?.globalIds;
        let added = 0;
        for (const dbId of this.viewer.getSelection()) {
            const found = globalIds && findGlobalId(this.viewer.model, globalIds, dbId);
            if (found && !session.inputs.globalIds.has(found.globalId)) {
                session.inputs.globalIds.set(found.globalId, found.dbId);
                added++;
            }
        }
        this._updateFilter();
        return added;
    }

    clearChoices() {
        session.inputs.checkedTypes.clear();
        session.inputs.ifcClasses.clear();
        session.inputs.globalIds.clear();
        this._updateFilter();
    }

    // Shows in the viewer the elements the current choices pick
    isolateChoices() {
        const dbIds = this._getChosenDbIds();
        this.viewer.isolate(dbIds);
        if (dbIds.length > 0) {
            this.viewer.fitToView(dbIds);
        }
    }

    get chosenElementCount() {
        return this._getChosenDbIds().length;
    }

    // Replaces the filter by the one generated from the choices, discarding manual edits
    regenerateFilter() {
        session.inputs.filterEdited = false;
        this._updateFilter();
    }

    _getChosenDbIds() {
        const inputs = session.inputs;
        const dbIds = [];
        for (const category of this._modelData?.categories || []) {
            for (const family of category.families) {
                for (const type of family.types) {
                    if (inputs.checkedTypes.has(typeKey(category, family, type))) {
                        dbIds.push(...type.dbIds);
                    }
                }
            }
        }
        for (const ifcClass of this._modelData?.ifc?.classes || []) {
            if (inputs.ifcClasses.has(ifcClass.name)) {
                dbIds.push(...ifcClass.dbIds);
            }
        }
        dbIds.push(...inputs.globalIds.values());
        return [...new Set(dbIds)];
    }

    // The filter follows the choices, until it's edited by hand
    _updateFilter() {
        const inputs = session.inputs;
        if (!inputs || inputs.filterEdited) {
            return;
        }
        if (this._modelData?.categories) {
            inputs.filter = buildAecFilter(this._modelData.categories, inputs.checkedTypes);
        } else if (this._modelData?.ifc) {
            // Classes in the order of the list, global IDs in the order they were added
            const classes = this._modelData.ifc.classes.map(c => c.name).filter(name => inputs.ifcClasses.has(name));
            inputs.filter = buildIfcFilter(classes, [...inputs.globalIds.keys()]);
        }
    }

    _resetInputs(design) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
        return {
            exchangeName: `${design.name.replace(/\.(rvt|ifc)$/i, '')} - Exchange ${stamp}`,
            viewName: '',
            checkedTypes: new Set(), // typeKey(category, family, type)
            ifcClasses: new Set(),
            globalIds: new Map(), // GlobalId -> dbId
            filter: '',
            filterEdited: false
        };
    }

    // Exchange creation

    async createExchange() {
        if (this.busy || !session.source) {
            return; // Ignore repeated clicks
        }
        const inputs = session.inputs;
        const isRevitFile = session.source.kind === 'revit';
        this._starting = true;
        this._exchange = null;
        this._panel?.update(); // Show the busy state before the request even leaves
        try {
            const resp = await fetch('/api/exchanges', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    hubId: session.design.hubId,
                    projectId: session.design.projectId,
                    versionId: session.design.versionId,
                    exchangeName: inputs.exchangeName.trim(),
                    viewName: isRevitFile ? inputs.viewName : null,
                    filter: isRevitFile ? null : inputs.filter.trim()
                })
            });
            if (!resp.ok) {
                throw new Error(await resp.text());
            }
            const { id, name, region } = await resp.json();
            localStorage.setItem(this._storageKey(), JSON.stringify({ id, name, region }));
            // notify: tell the page once the exchange exists (not when tracking resumes after a reload)
            this._exchange = { id, name, region, status: 'inProgress', details: 'Waiting for its status...', statusErrors: 0, notify: true };
            this._schedulePolling(1000);
        } catch (err) {
            this._exchange = { status: 'failed', name: inputs.exchangeName.trim(), error: err.message };
        } finally {
            this._starting = false;
            this._panel?.update();
        }
    }

    _storageKey() {
        return `exchange-maker:exchange:${session.design.versionId}`;
    }

    async _pollStatus() {
        const exchange = this._exchange;
        const query = new URLSearchParams({ id: exchange.id, region: exchange.region || '' });
        try {
            const resp = await fetch(`/api/exchanges/status?${query}`);
            if (!resp.ok) {
                throw new Error(await resp.text());
            }
            const { status, versionNumber, message } = await resp.json();
            if (this._unloaded || this._exchange !== exchange) {
                return; // This instance was replaced, or another exchange is tracked now
            }
            switch (status) {
                case 'COMPLETED':
                    exchange.status = 'completed';
                    exchange.details = `Version ${versionNumber ?? 1} of exchange ${exchange.id}`;
                    this._loadContents(exchange);
                    if (exchange.notify) {
                        // Lets the page show the new exchange in the tree
                        window.dispatchEvent(new CustomEvent('exchange-maker:created', { detail: { id: exchange.id, name: exchange.name } }));
                    }
                    break;
                case 'FAILED':
                    exchange.status = 'failed';
                    exchange.error = `Data Exchange could not create the exchange (exchange ${exchange.id}). Check that the view or the filter matches elements of the latest version of the design.`;
                    break;
                case 'UNAVAILABLE':
                    if (++exchange.statusErrors >= MAX_STATUS_ERRORS) {
                        exchange.status = 'failed';
                        exchange.error = `The exchange was requested, but its status stayed unavailable: ${message}`;
                    } else {
                        exchange.details = `Exchange ${exchange.id} requested, waiting for its status (attempt ${exchange.statusErrors})`;
                    }
                    break;
                default:
                    exchange.statusErrors = 0;
                    exchange.details = `Exchange ${exchange.id}: ${status}`;
            }
            if (exchange.status === 'inProgress') {
                this._schedulePolling();
            }
        } catch (err) {
            console.error('Could not get the exchange status, retrying.', err);
            this._schedulePolling();
        }
        this._panel?.update();
    }

    // What the exchange contains, read from its data: ACC previews an exchange created from a filter with the views of
    // its source model, which shows more than the exchange has
    async _loadContents(exchange) {
        exchange.contents = { loading: true };
        this._panel?.update();
        try {
            const query = new URLSearchParams({ id: exchange.id, region: exchange.region || '' });
            const resp = await fetch(`/api/exchanges/contents?${query}`);
            if (!resp.ok) {
                throw new Error(await resp.text());
            }
            const contents = await resp.json();
            contents.dbIds = await this._findInModel(contents);
            exchange.contents = contents;
        } catch (err) {
            console.error(err);
            exchange.contents = { error: err.message };
        }
        if (!this._unloaded) {
            this._panel?.update();
        }
    }

    // Elements of the loaded model that are in the exchange: Revit elements by external ID (UniqueId), IFC elements by GlobalId
    async _findInModel(contents) {
        const model = this.viewer.model;
        const dbIds = new Set();
        if (contents.externalIds.length > 0) {
            const mapping = await new Promise((resolve, reject) => model.getExternalIdMapping(resolve, reject));
            for (const externalId of contents.externalIds) {
                if (mapping[externalId] !== undefined) {
                    dbIds.add(mapping[externalId]);
                }
            }
        }
        const globalIds = this._modelData?.ifc?.globalIds;
        if (globalIds && contents.globalIds.length > 0) {
            const wanted = new Set(contents.globalIds);
            for (const [dbId, globalId] of globalIds) {
                if (wanted.has(globalId)) {
                    dbIds.add(dbId);
                }
            }
        }
        return [...dbIds];
    }

    isolateExchange() {
        const dbIds = this._exchange?.contents?.dbIds || [];
        this.viewer.isolate(dbIds);
        if (dbIds.length > 0) {
            this.viewer.fitToView(dbIds);
        }
    }

    _schedulePolling(delay = POLLING_INTERVAL) {
        this._stopPolling();
        if (this._unloaded) {
            return;
        }
        this._pollingTimer = setTimeout(() => this._pollStatus(), delay);
    }

    _stopPolling() {
        if (this._pollingTimer) {
            clearTimeout(this._pollingTimer);
            this._pollingTimer = null;
        }
    }
}

Autodesk.Viewing.theExtensionManager.registerExtension('ExchangeMakerExtension', ExchangeMakerExtension);
