import { typeKey } from './ModelData.js';
import { getRevitVersion } from '../viewer.js';

const MAX_LISTED_IDS = 100;
const STEP_ICONS = { pending: '○', inProgress: '', completed: '✓', failed: '✗' };
const KIND_LABELS = {
    revit: 'Revit file · 3D view exchange',
    aecDataModel: 'Revit cloud model · AEC Data Model exchange',
    ifc: 'IFC file · IFC filter exchange',
    unsupported: 'Not supported'
};

export class ExchangeMakerPanel extends Autodesk.Viewing.UI.DockingPanel {
    constructor(extension, id, title, options) {
        super(extension.viewer.container, id, title, options);
        this.extension = extension;
        this.container.style.left = (options?.x || 10) + 'px';
        this.container.style.top = (options?.y || 10) + 'px';
        this.container.style.width = (options?.width || 400) + 'px';
        this.container.style.height = (options?.height || 640) + 'px';
        this.container.style.resize = 'both';
        this._renderedFor = null; // What the source-specific section was built for
    }

    initialize() {
        this.title = this.createTitleBar(this.titleLabel || this.container.id);
        this.initializeMoveHandlers(this.title);
        this.container.appendChild(this.title);
        this.closer = this.createCloseButton();
        this.initializeCloseHandler(this.closer);
        this.container.appendChild(this.closer);

        this.content = document.createElement('div');
        this.content.className = 'ec-content';
        this.content.innerHTML = `
            <div class="ec-section">
                <div class="ec-label">Source</div>
                <div class="ec-design">Select a design version in the sidebar.</div>
                <div class="ec-hint em-kind"></div>
                <div class="ec-warning em-source-warning" hidden></div>
            </div>
            <div class="em-source-section"></div>
            <div class="ec-section em-filter-section" hidden>
                <label class="ec-field">Filter <textarea class="em-filter" rows="4" spellcheck="false"></textarea></label>
                <div class="ec-hint em-filter-hint"></div>
                <div class="ec-buttons"><button class="em-regenerate" hidden>Use the choices above</button></div>
            </div>
            <div class="ec-section em-create-section" hidden>
                <label class="ec-field">Exchange name <input class="em-exchange-name" type="text"></label>
                <div class="ec-hint em-target">Created in the folder of the source design.</div>
                <button class="ec-create ec-primary">Create exchange</button>
            </div>
            <div class="ec-section">
                <div class="ec-label">Progress</div>
                <ul class="ec-steps"><li class="ec-hint">No exchange created yet.</li></ul>
                <div class="ec-error em-progress-error"></div>
                <div class="em-contents" hidden>
                    <div class="ec-label em-spaced">Exchange content <span class="ec-badge em-contents-count">0</span></div>
                    <div class="ec-hint em-contents-summary"></div>
                    <ul class="ec-elements em-contents-categories"></ul>
                    <div class="ec-buttons"><button class="em-isolate-exchange" title="Isolate the elements of the exchange in the loaded model">Isolate in the viewer</button></div>
                    <div class="ec-hint">Read from the exchange's data. ACC previews an exchange created from a filter with the
                        views of its source model, so its preview shows more than the exchange contains.</div>
                </div>
            </div>
        `;
        this.container.appendChild(this.content);

        this._handle(this.content.querySelector('.ec-create'), () => this.extension.createExchange());
        this._handle(this.content.querySelector('.em-regenerate'), () => this.extension.regenerateFilter());
        this._handle(this.content.querySelector('.em-isolate-exchange'), () => this.extension.isolateExchange());
        this.content.querySelector('.em-exchange-name').oninput = (ev) => { this.extension.setInput('exchangeName', ev.target.value); this.update(); };
        this.content.querySelector('.em-filter').oninput = (ev) => { this.extension.setInput('filter', ev.target.value); this.update(); };
    }

    setVisible(show) {
        super.setVisible(show);
        if (!show) {
            this.extension?.onPanelClosed();
        }
    }

    _handle(button, action) {
        button.onclick = async () => {
            try {
                await action();
            } catch (err) {
                alert(`The operation failed: ${err.message}`);
                console.error(err);
            }
            this.update();
        };
    }

    update() {
        if (!this.extension || !this.isVisible()) {
            return;
        }
        const { design, source, sourceError, inputs, modelData, modelDataError, exchange, busy } = this.extension;
        const q = (selector) => this.content.querySelector(selector);

        // Source
        q('.ec-design').textContent = design ? design.name : 'Select a design version in the sidebar.';
        const kind = source?.kind;
        q('.em-kind').textContent = sourceError ? `Could not identify the design: ${sourceError}`
            : design && !source ? 'Identifying the design...'
            : source ? `${KIND_LABELS[kind]} · version ${source.versionNumber}${source.isLatestVersion ? ' (latest)' : ''}` : '';
        q('.em-source-warning').textContent = this._sourceWarning(source);
        q('.em-source-warning').hidden = !q('.em-source-warning').textContent;

        // Source-specific choices, rebuilt only when the source or the model data change
        const supported = kind === 'revit' || kind === 'aecDataModel' || kind === 'ifc';
        const section = q('.em-source-section');
        const renderKey = supported ? { versionId: design.versionId, kind, modelData, modelDataError } : null;
        if (!this._sameRender(renderKey)) {
            this._renderedFor = renderKey;
            section.replaceChildren();
            if (supported) {
                section.appendChild(this._renderSource(kind, modelData, modelDataError));
            }
        }
        if (supported && modelData) {
            this._updateSource(kind, modelData, inputs);
        }

        // Filter (AEC Data Model, IFC)
        const usesFilter = kind === 'aecDataModel' || kind === 'ifc';
        q('.em-filter-section').hidden = !usesFilter;
        if (usesFilter) {
            const filter = q('.em-filter');
            if (document.activeElement !== filter) {
                filter.value = inputs.filter;
            }
            filter.disabled = busy;
            q('.em-filter-hint').textContent = inputs.filterEdited
                ? 'Edited by hand: the choices above no longer change it.'
                : kind === 'ifc'
                    ? 'Generated from the choices above (IFC filters only support the =in= operator). You can edit it.'
                    : 'Generated from the choices above (AEC Data Model filters work on category, family and type). You can edit it.';
            q('.em-regenerate').hidden = !inputs.filterEdited;
        }

        // Exchange name and creation
        q('.em-create-section').hidden = !supported;
        if (supported) {
            const name = q('.em-exchange-name');
            if (document.activeElement !== name) {
                name.value = inputs.exchangeName;
            }
            name.disabled = busy;
            const ready = inputs.exchangeName.trim() && (kind === 'revit' ? !!inputs.viewName : !!inputs.filter.trim());
            const create = q('.ec-create');
            create.disabled = !ready || busy;
            create.classList.toggle('ec-busy', busy);
            create.textContent = this.extension.starting ? 'Requesting...' : busy ? 'Creating exchange...' : 'Create exchange';
        }

        this._renderProgress(exchange);
    }

    _sourceWarning(source) {
        if (!source) {
            return '';
        }
        if (source.kind === 'unsupported') {
            return source.reason;
        }
        const warnings = [];
        if (!source.isLatestVersion) {
            warnings.push(`You're looking at version ${source.versionNumber}, but exchanges are always created from the latest version ` +
                `(${source.latestVersionNumber}). The view or the elements you pick must exist there.`);
        }
        if (source.kind === 'aecDataModel') {
            warnings.push('Filters need the AEC Data Model to be enabled for the hub, with the model published from Revit 2024 or later.');
        }
        if (source.kind === 'revit') {
            const doc = this.extension.viewer.model?.getDocumentNode()?.getDocument();
            if (String(getRevitVersion(doc)) === '2024') {
                warnings.push('This file was saved with Revit 2024: exchanges from Revit 2024 files did not complete in our tests (see the Exchange Creator sample).');
            }
        }
        return warnings.join(' ');
    }

    _sameRender(key) {
        const previous = this._renderedFor;
        if (!key || !previous) {
            return key === previous;
        }
        return key.versionId === previous.versionId && key.kind === previous.kind
            && key.modelData === previous.modelData && key.modelDataError === previous.modelDataError;
    }

    _renderSource(kind, modelData, modelDataError) {
        const section = document.createElement('div');
        section.className = 'ec-section';
        if (modelDataError) {
            section.innerHTML = `<div class="ec-error"></div>`;
            section.firstChild.textContent = `Could not read the model: ${modelDataError}`;
            return section;
        }
        if (!modelData) {
            section.innerHTML = `<div class="ec-hint">Reading the model...</div>`;
            return section;
        }
        switch (kind) {
            case 'revit': return this._renderRevit(section, modelData);
            case 'aecDataModel': return this._renderAec(section, modelData);
            case 'ifc': return this._renderIfc(section, modelData);
        }
        return section;
    }

    // Revit file: one of the published 3D views
    _renderRevit(section, { views }) {
        section.innerHTML = `
            <label class="ec-field">Published 3D view <select class="em-view"></select></label>
            <div class="ec-buttons"><button class="em-open-view">Show in the viewer</button></div>
            <div class="ec-hint">Exchanges can only be created from the 3D views ACC extracted from the file
                (the views in its publish settings). The exchange contains the elements visible in the view.</div>
        `;
        const select = section.querySelector('.em-view');
        if (views.length === 0) {
            select.appendChild(new Option('No published 3D view', ''));
            select.disabled = true;
        }
        for (const view of views) {
            select.appendChild(new Option(view, view));
        }
        select.onchange = () => { this.extension.setInput('viewName', select.value); this.update(); };
        this._handle(section.querySelector('.em-open-view'), () => this.extension.openView(select.value));
        return section;
    }

    // Revit cloud model: categories > families > types, as in AEC Data Model filters
    _renderAec(section, { categories }) {
        section.innerHTML = `
            <div class="ec-label">Categories, families and types <span class="ec-badge em-count" title="Checked elements in the loaded view">0</span></div>
            <div class="ec-hint">The filter picks whole categories, families or types: the exchange gets every matching element
                of the model, not only the ones in the loaded view. The counts are for the loaded view.</div>
            <div class="ec-hint em-selection"></div>
            <div class="ec-buttons">
                <button class="em-check-selection" title="Check the types of the elements selected in the viewer (the exchange then gets every element of these types)">Check types of selected</button>
                <button class="em-isolate" title="Isolate the checked elements in the viewer">Isolate</button>
                <button class="em-clear">Clear</button>
            </div>
            <div class="em-tree"></div>
        `;
        this._handle(section.querySelector('.em-check-selection'), () => this.extension.checkViewerSelection());
        this._handle(section.querySelector('.em-isolate'), () => this.extension.isolateChoices());
        this._handle(section.querySelector('.em-clear'), () => this.extension.clearChoices());
        const tree = section.querySelector('.em-tree');
        if (categories.length === 0) {
            tree.innerHTML = `<div class="ec-hint">No categories found in the model tree.</div>`;
        }
        const count = (types) => types.reduce((sum, type) => sum + type.dbIds.length, 0);
        for (const category of categories) {
            const categoryKeys = category.families.flatMap(family => family.types.map(type => typeKey(category, family, type)));
            const categoryNode = this._createTreeNode(category.name, count(category.families.flatMap(f => f.types)), categoryKeys);
            for (const family of category.families) {
                const familyKeys = family.types.map(type => typeKey(category, family, type));
                const familyNode = this._createTreeNode(family.name, count(family.types), familyKeys);
                for (const type of family.types) {
                    familyNode.children.appendChild(this._createTreeLeaf(type.name, type.dbIds.length, [typeKey(category, family, type)]));
                }
                categoryNode.children.appendChild(familyNode.element);
            }
            tree.appendChild(categoryNode.element);
        }
        return section;
    }

    _createCheckbox(keys) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.keys = JSON.stringify(keys);
        checkbox.onchange = () => { this.extension.setTypesChecked(keys, checkbox.checked); this.update(); };
        return checkbox;
    }

    _createLabel(name, count, keys) {
        const label = document.createElement('label');
        const text = document.createElement('span');
        text.textContent = name || '(unnamed)';
        const badge = document.createElement('span');
        badge.className = 'ec-hint';
        badge.textContent = ` (${count})`;
        label.append(this._createCheckbox(keys), text, badge);
        return label;
    }

    _createTreeNode(name, count, keys) {
        const element = document.createElement('details');
        const summary = document.createElement('summary');
        summary.appendChild(this._createLabel(name, count, keys));
        const children = document.createElement('div');
        children.className = 'em-tree-children';
        element.append(summary, children);
        return { element, children };
    }

    _createTreeLeaf(name, count, keys) {
        const element = document.createElement('div');
        element.className = 'em-tree-leaf';
        element.appendChild(this._createLabel(name, count, keys));
        return element;
    }

    // IFC file: IFC classes, and GlobalIds of elements picked in the viewer
    _renderIfc(section, { ifc }) {
        section.innerHTML = `
            <div class="ec-label">IFC classes</div>
            <div class="ec-hint em-class-property"></div>
            <div class="em-tree em-classes"></div>
            <div class="ec-label em-spaced">Global IDs <span class="ec-badge em-guid-count">0</span></div>
            <div class="ec-hint em-selection"></div>
            <div class="ec-buttons">
                <button class="em-add-selection" title="Add the GlobalIds of the elements selected in the viewer">Add selected</button>
                <button class="em-isolate" title="Isolate the picked elements in the viewer">Isolate</button>
                <button class="em-clear">Clear</button>
            </div>
            <ul class="ec-elements em-guids"></ul>
        `;
        section.querySelector('.em-class-property').textContent = ifc.classProperty
            ? `Read from the "${ifc.classProperty}" property. Elements are counted in the loaded view.`
            : 'No IFC class property found in the model. Type the filter below instead.';
        const list = section.querySelector('.em-classes');
        for (const ifcClass of ifc.classes) {
            const label = document.createElement('label');
            label.className = 'em-tree-leaf';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.ifcClass = ifcClass.name;
            checkbox.onchange = () => { this.extension.setClassChecked(ifcClass.name, checkbox.checked); this.update(); };
            const text = document.createElement('span');
            text.textContent = ifcClass.name;
            const badge = document.createElement('span');
            badge.className = 'ec-hint';
            badge.textContent = ` (${ifcClass.dbIds.length})`;
            label.append(checkbox, text, badge);
            list.appendChild(label);
        }
        this._handle(section.querySelector('.em-add-selection'), () => {
            if (this.extension.addViewerSelectionGlobalIds() === 0 && this.extension.viewerSelectionCount > 0) {
                alert('The selected elements have no GlobalId, or are already in the list.');
            }
        });
        this._handle(section.querySelector('.em-isolate'), () => this.extension.isolateChoices());
        this._handle(section.querySelector('.em-clear'), () => this.extension.clearChoices());
        return section;
    }

    // Updates the checkboxes and counters of the source-specific section
    _updateSource(kind, modelData, inputs) {
        const section = this.content.querySelector('.em-source-section');
        const busy = this.extension.busy;
        const selection = section.querySelector('.em-selection');
        if (selection) {
            selection.textContent = `${this.extension.viewerSelectionCount} object(s) selected in the viewer`;
        }
        for (const button of section.querySelectorAll('button')) {
            button.disabled = busy;
        }
        if (kind === 'revit') {
            const select = section.querySelector('.em-view');
            select.value = inputs.viewName;
            select.disabled = busy || modelData.views.length === 0;
            section.querySelector('.em-open-view').disabled = !inputs.viewName || inputs.viewName === modelData.loadedView;
            return;
        }
        const chosen = this.extension.chosenElementCount;
        for (const button of section.querySelectorAll('.em-isolate, .em-clear')) {
            button.disabled = busy || (chosen === 0 && inputs.globalIds.size === 0 && inputs.ifcClasses.size === 0 && inputs.checkedTypes.size === 0);
        }
        for (const button of section.querySelectorAll('.em-check-selection, .em-add-selection')) {
            button.disabled = busy || this.extension.viewerSelectionCount === 0;
        }
        if (kind === 'aecDataModel') {
            section.querySelector('.em-count').textContent = chosen;
            for (const checkbox of section.querySelectorAll('input[data-keys]')) {
                const keys = JSON.parse(checkbox.dataset.keys);
                const checked = keys.filter(key => inputs.checkedTypes.has(key)).length;
                checkbox.checked = checked > 0 && checked === keys.length;
                checkbox.indeterminate = checked > 0 && checked < keys.length;
                checkbox.disabled = busy;
            }
        } else {
            for (const checkbox of section.querySelectorAll('input[data-ifc-class]')) {
                checkbox.checked = inputs.ifcClasses.has(checkbox.dataset.ifcClass);
                checkbox.disabled = busy;
            }
            section.querySelector('.em-guid-count').textContent = inputs.globalIds.size;
            const list = section.querySelector('.em-guids');
            list.replaceChildren();
            const ids = [...inputs.globalIds.keys()];
            for (const id of ids.slice(0, MAX_LISTED_IDS)) {
                const li = document.createElement('li');
                li.textContent = id;
                list.appendChild(li);
            }
            if (ids.length > MAX_LISTED_IDS) {
                const li = document.createElement('li');
                li.className = 'ec-hint';
                li.textContent = `... and ${ids.length - MAX_LISTED_IDS} more`;
                list.appendChild(li);
            }
        }
    }

    _renderProgress(exchange) {
        const steps = this.content.querySelector('.ec-steps');
        const error = this.content.querySelector('.em-progress-error');
        steps.replaceChildren();
        error.textContent = '';
        if (!exchange && !this.extension.starting) {
            steps.innerHTML = `<li class="ec-hint">No exchange created yet.</li>`;
            return;
        }
        const requested = this.extension.starting ? 'inProgress' : exchange.id ? 'completed' : 'failed';
        const created = !exchange?.id ? 'pending' : exchange.status;
        this._addStep(steps, requested, `Requested the exchange "${exchange?.name || this.extension.inputs.exchangeName.trim()}"`,
            exchange?.id ? `Exchange ${exchange.id}` : null);
        this._addStep(steps, created, created === 'completed' ? 'Created the exchange' : 'Creating the exchange',
            exchange?.details);
        if (exchange?.status === 'failed') {
            error.textContent = exchange.error;
        }
        this._renderContents(exchange?.status === 'completed' ? exchange.contents : null);
    }

    _renderContents(contents) {
        const section = this.content.querySelector('.em-contents');
        section.hidden = !contents;
        if (!contents) {
            return;
        }
        const summary = section.querySelector('.em-contents-summary');
        const list = section.querySelector('.em-contents-categories');
        const isolate = section.querySelector('.em-isolate-exchange');
        list.replaceChildren();
        isolate.disabled = true;
        if (contents.loading || contents.error) {
            section.querySelector('.em-contents-count').textContent = '–';
            summary.textContent = contents.loading ? 'Reading the exchange...' : `Could not read the exchange: ${contents.error}`;
            return;
        }
        const instances = contents.elementCount - contents.typeCount;
        section.querySelector('.em-contents-count').textContent = contents.elementCount;
        summary.textContent = `${instances} element(s)` + (contents.typeCount ? ` and ${contents.typeCount} type(s)` : '') +
            (contents.truncated ? ' (first pages only)' : '') +
            `. ${contents.dbIds.length} of them are in the loaded view.`;
        for (const [category, count] of Object.entries(contents.categories).sort((a, b) => b[1] - a[1])) {
            const li = document.createElement('li');
            li.textContent = `${category}: ${count}`;
            list.appendChild(li);
        }
        isolate.disabled = contents.dbIds.length === 0;
    }

    _addStep(steps, status, title, details) {
        const li = document.createElement('li');
        li.className = `ec-step ec-step-${status}`;
        const icon = document.createElement('span');
        icon.className = 'ec-step-icon';
        icon.textContent = STEP_ICONS[status];
        const text = document.createElement('div');
        const titleElement = document.createElement('div');
        titleElement.className = 'ec-step-title';
        titleElement.textContent = title + (status === 'inProgress' ? ' ...' : '');
        text.appendChild(titleElement);
        if (details) {
            const detailsElement = document.createElement('div');
            detailsElement.className = 'ec-step-details';
            detailsElement.textContent = details;
            text.appendChild(detailsElement);
        }
        li.append(icon, text);
        steps.appendChild(li);
    }
}
