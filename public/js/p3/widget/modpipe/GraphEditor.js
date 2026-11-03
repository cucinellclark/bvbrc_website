/*
 * Graph editor for modpipe pipelines: a module palette, a canvas where tools are wired port-to-port, an
 * inspector for the selection, and a status bar with live server validation.
 *
 * - Wiring is checked instantly in the browser (PipelineModel.canConnect / TypeLogic) while dragging: input ports
 *   turn green (fits), amber (may fit, depends on the actual input), blue (fits via an automatic converter) or
 *   grey (refused, with the reason). The editor never creates cycles.
 * - After every edit the pipeline is validated on the server (POST /api/validate, debounced); errors and warnings
 *   are attached to the step/port they concern, resolved types and per-sample (scatter) badges are shown, and
 *   converters the server would insert appear on their edge ("auto"), with "Make explicit".
 * - Layout: positions are stored in pipeline.ui.positions; nodes without one are placed by a layered layout.
 *
 * owner: the ModularPipeline page (api(), templates, catalog cache).
 */
define([
  'require', 'dojo/_base/declare', 'dojo/_base/lang', 'dojo/_base/array', 'dojo/on', 'dojo/dom-class',
  'dojo/dom-construct', 'dojo/dom-style', 'dojo/keys',
  'dijit/_WidgetBase', 'dijit/form/Select', 'dijit/form/TextBox', 'dijit/form/ValidationTextBox',
  'dijit/form/CheckBox', 'dijit/form/Button', 'dijit/Dialog', 'dijit/registry',
  './TypeLogic', './PipelineModel', './SourceEditor', './ParamEditor',
  '../WorkspaceObjectSelector', '../../WorkspaceManager'
], function (
  require, declare, lang, array, on, domClass,
  domConstruct, domStyle, keys,
  _WidgetBase, Select, TextBox, ValidationTextBox,
  CheckBox, Button, Dialog, registry,
  T, PipelineModel, SourceEditor, ParamEditor,
  WorkspaceObjectSelector, WorkspaceManager
) {

  var esc = SourceEditor.esc;

  // geometry (stage pixels)
  var STEP_W = 250;
  var INPUT_W = 200;
  var HEAD_H = 42;
  var ROW_H = 20;
  var PAD = 8;

  var STATUS_TEXT = { yes: 'fits', maybe: 'may fit (depends on the actual input)', convert: 'fits via an automatic converter', no: 'not allowed' };

  function loadCss() {
    if (document.getElementById('modpipe-graph-css')) { return; }
    domConstruct.create('link', {
      id: 'modpipe-graph-css', rel: 'stylesheet', type: 'text/css', href: require.toUrl('./modpipe.css')
    }, document.getElementsByTagName('head')[0]);
  }

  function refStep(ref) { return ref.indexOf('$inputs.') === 0 ? null : ref.split('.')[0]; }
  function nodeKeyOfRef(ref) { return ref.indexOf('$inputs.') === 0 ? 'in:' + ref.slice(8) : 'step:' + refStep(ref); }
  function shortType(t) { return String(t || '').replace(/^sequences\./, 'seq.'); }

  return declare([_WidgetBase], {
    owner: null,
    catalog: null,
    model: null,
    sel: null,                // {kind: 'node'|'edge'|'port'|'auto', key, ...}
    view: null,               // {tx, ty, k}
    issues: null,             // indexed server issues
    autoEdges: null,          // "<from>><step>.<port>" -> {step, module}
    _seq: 0,
    _timer: null,
    _sourceOptions: null,     // cache "<type>|<collection>" -> promise of options

    baseClass: 'mpGraph',

    buildRendering: function () {
      loadCss();
      this.domNode = domConstruct.create('div', { 'class': 'mpGraph' });
      var tb = this.toolbarNode = domConstruct.create('div', { 'class': 'mpToolbar' }, this.domNode);
      var main = domConstruct.create('div', { 'class': 'mpMain' }, this.domNode);
      this.paletteNode = domConstruct.create('div', { 'class': 'mpPalette' }, main);
      this.wrapNode = domConstruct.create('div', { 'class': 'mpCanvasWrap', tabindex: 0 }, main);
      this.stageNode = domConstruct.create('div', { 'class': 'mpStage' }, this.wrapNode);
      this.svgNode = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.svgNode.setAttribute('class', 'mpEdges');
      this.stageNode.appendChild(this.svgNode);
      this.nodesNode = domConstruct.create('div', { 'class': 'mpNodes' }, this.stageNode);
      this.hintNode = domConstruct.create('div', { 'class': 'mpHint' }, this.wrapNode);
      this.inspectorNode = domConstruct.create('div', { 'class': 'mpInspector' }, main);
      this.statusNode = domConstruct.create('div', { 'class': 'mpStatus' }, this.domNode);
      this._tbNode = tb;
    },

    postCreate: function () {
      this.inherited(arguments);
      this.view = { tx: 30, ty: 30, k: 1 };
      this.issues = { byNode: {}, byPort: {}, global: [] };
      this.autoEdges = {};
      this._sourceOptions = {};
      this.model = new PipelineModel(this.catalog);
      this.model.onChange(lang.hitch(this, '_onModelChange'));
      this._knownKeys = {};
      this._buildToolbar();
      this._buildPalette();
      this._bindCanvas();
      this.render();
      this.renderInspector();
      this._renderStatus(null);
    },

    // ================================================================== toolbar

    _btn: function (label, title, fn, parent) {
      var b = new Button({ label: label, title: title, onClick: lang.hitch(this, fn) });
      b.placeAt(parent || this._tbNode);
      return b;
    },

    _buildToolbar: function () {
      var self = this;
      this._btn('New', 'Start an empty pipeline', function () {
        if (Object.keys(this.model.p.steps).length && !window.confirm('Discard the current pipeline? (Undo can bring it back.)')) { return; }
        this.model.reset();
        this.select(null);
      });
      var opts = array.map(this.owner.templates || [], function (t) {
        return { value: t.template, label: esc('[' + (t.category || 'other') + '] ' + t.label) };
      });
      opts.sort(function (a, b) { return a.label < b.label ? -1 : 1; });
      this.templateSel = new Select({ options: opts, style: 'width:260px;', maxHeight: 400 });
      this.templateSel.placeAt(this._tbNode);
      this._btn('Load template', 'Open the selected template as a graph', function () {
        this.loadTemplate(this.templateSel.get('value'));
      });
      domConstruct.create('span', { 'class': 'mpSep' }, this._tbNode);
      this._btn('Auto-layout', 'Arrange all nodes left to right', function () { this.autoLayout(); });
      this._btn('Fit', 'Zoom to fit the whole pipeline', function () { this.fit(); });
      this._btn('-', 'Zoom out', function () { this.zoomBy(1 / 1.2); });
      this._btn('+', 'Zoom in', function () { this.zoomBy(1.2); });
      domConstruct.create('span', { 'class': 'mpSep' }, this._tbNode);
      this.undoBtn = this._btn('Undo', 'Undo (Ctrl+Z)', function () { this.model.undo(); });
      this.redoBtn = this._btn('Redo', 'Redo (Ctrl+Shift+Z)', function () { this.model.redo(); });
      domConstruct.create('span', { 'class': 'mpSep' }, this._tbNode);
      this._btn('Open...', 'Open a pipeline saved in your workspace', function () { this.openFromWorkspace(); });
      this._btn('Save...', 'Save this pipeline (with its layout) to your workspace', function () { this.saveToWorkspace(); });
      this._btn('Download', 'Download the pipeline JSON', function () { this.download(); });
      self._updateUndo();
    },

    _updateUndo: function () {
      if (this.undoBtn) {
        this.undoBtn.set('disabled', !this.model.canUndo());
        this.redoBtn.set('disabled', !this.model.canRedo());
      }
    },

    // ================================================================== palette

    _buildPalette: function () {
      var p = this.paletteNode;
      var top = domConstruct.create('div', { 'class': 'mpPaletteTop' }, p);
      this.searchBox = new TextBox({ placeHolder: 'Search tools...', intermediateChanges: true, style: 'width:100%;' });
      this.searchBox.placeAt(top);
      on(this.searchBox, 'change', lang.hitch(this, '_renderPalette'));
      var fl = domConstruct.create('div', { 'class': 'mpFilterRow' }, top);
      this.compatBox = new CheckBox({ checked: true });
      this.compatBox.placeAt(fl);
      on(this.compatBox, 'change', lang.hitch(this, '_renderPalette'));
      this.compatLabel = domConstruct.create('label', { innerHTML: ' only tools that fit the selected output' }, fl);
      this._btn('+ Pipeline input', 'Add a data input (reads, genomes, files...)', function () { this.addInputDialog(); }, top);
      this.paletteList = domConstruct.create('div', { 'class': 'mpPaletteList' }, p);
      this._renderPalette();
    },

    _selectedOutRef: function () {
      return this.sel && this.sel.kind === 'port' && this.sel.dir === 'out' ? this.sel.ref : null;
    },

    /* Best connection status of `fromRef` into any input of module `mid`. */
    moduleFit: function (fromRef, mid) {
      var t = this.model.types()[fromRef];
      if (!t) { return 'no'; }
      var rank = { yes: 3, convert: 2, maybe: 1, no: 0 };
      var best = 'no';
      var cat = this.catalog;
      array.forEach(cat.modules[mid].inputs, function (port) {
        var c = T.connection(cat, t.type, port.type, t.derived);
        if (rank[c] > rank[best]) { best = c; }
      });
      return best;
    },

    _renderPalette: function () {
      var cat = this.catalog;
      var q = String(this.searchBox.get('value') || '').toLowerCase();
      var fromRef = this._selectedOutRef();
      var filter = fromRef && this.compatBox.get('checked');
      domClass.toggle(this.compatLabel.parentNode, 'mpDim', !fromRef);
      domConstruct.empty(this.paletteList);
      var self = this;
      if (fromRef) {
        domConstruct.create('div', { 'class': 'mpPaletteNote', innerHTML: 'Click a tool to add it after <b>' + esc(fromRef) + '</b>' }, this.paletteList);
      } else {
        domConstruct.create('div', { 'class': 'mpPaletteNote', innerHTML: 'Drag a tool onto the canvas, or select an output port to see what fits next.' }, this.paletteList);
      }
      Object.keys(cat.categories).sort().forEach(function (c) {
        var mods = cat.categories[c].filter(function (mid) {
          var m = cat.modules[mid];
          var text = (mid + ' ' + (m.label || '') + ' ' + (m.description || '')).toLowerCase();
          if (q && text.indexOf(q) < 0) { return false; }
          if (filter && self.moduleFit(fromRef, mid) === 'no') { return false; }
          return true;
        });
        if (!mods.length) { return; }
        domConstruct.create('div', { 'class': 'mpCat', innerHTML: esc(c.replace(/_/g, ' ')) }, self.paletteList);
        mods.forEach(function (mid) {
          var m = cat.modules[mid];
          var fit = fromRef ? self.moduleFit(fromRef, mid) : null;
          var item = domConstruct.create('div', {
            'class': 'mpPaletteItem' + (fit ? ' mpFit-' + fit : ''), draggable: 'true',
            title: (m.description || '') + (fit ? '\n\n' + fromRef + ': ' + STATUS_TEXT[fit] : ''),
            innerHTML: '<b>' + esc(mid) + '</b> <span>' + esc((m.label || '').replace(/^[^:]*:\s*/, '')) + '</span>'
          }, self.paletteList);
          on(item, 'dragstart', function (evt) { evt.dataTransfer.setData('text/plain', 'modpipe-module:' + mid); });
          on(item, 'click', function () { self.addModule(mid); });
        });
      });
    },

    addModule: function (mid, pos) {
      var fromRef = this._selectedOutRef();
      try {
        var sid;
        if (fromRef && !pos && this.moduleFit(fromRef, mid) !== 'no') {
          var src = this.model.p.ui.positions[nodeKeyOfRef(fromRef)] || { x: 0, y: 0 };
          sid = this.model.addStepAfter(mid, fromRef, { x: src.x + STEP_W + 90, y: src.y });
        } else {
          sid = this.model.addStep(mid, pos || this._visibleCenter());
        }
        this.select({ kind: 'node', key: 'step:' + sid });
      } catch (e) {
        this.flash(e.message);
      }
    },

    // ================================================================== templates, files

    loadTemplate: function (name, done) {
      if (!name) { return; }
      var self = this;
      this.owner.api('GET', '/api/templates/' + encodeURIComponent(name)).then(function (res) {
        self._rememberSourceOptions(res);
        self.model.load(res.pipeline);
        self.templateSel.set('value', name, false);
        self.select(null);
        self.autoLayout(true);
        self.fit();
        if (done) { done(res); }
      }, function (err) { self.flash(err.error || 'could not load template'); });
    },

    _rememberSourceOptions: function (res) {
      var self = this;
      Object.keys(res.source_options || {}).forEach(function (name) {
        var d = res.pipeline.inputs[name];
        self._sourceOptions[d.type + '|' + (d.collection ? 1 : 0)] = res.source_options[name];
      });
    },

    sourceOptions: function (type, collection) {
      var key = type + '|' + (collection ? 1 : 0);
      var c = this._sourceOptions[key];
      if (c && c.then) { return c; }
      if (c) { return { then: function (fn) { fn(c); } }; }
      var self = this;
      var pr = this.owner.api('GET', '/api/source_options?type=' + encodeURIComponent(type) + '&collection=' + (collection ? 1 : 0));
      this._sourceOptions[key] = pr;
      pr.then(function (opts) { self._sourceOptions[key] = opts; }, function () { delete self._sourceOptions[key]; });
      return pr;
    },

    download: function () {
      var blob = new Blob([JSON.stringify(this.model.toJSON(), null, 2)], { type: 'application/json' });
      var a = domConstruct.create('a', { href: URL.createObjectURL(blob), download: (this.model.p.name || 'pipeline').replace(/[^A-Za-z0-9_.-]+/g, '_') + '.json' }, document.body);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); domConstruct.destroy(a); }, 1000);
    },

    saveToWorkspace: function () {
      var self = this;
      var d = new Dialog({ title: 'Save pipeline to workspace', style: 'width:480px' });
      var box = domConstruct.create('div', {});
      domConstruct.create('div', { innerHTML: 'Folder', 'class': 'mpLabel' }, box);
      var folder = new WorkspaceObjectSelector({ type: ['folder'], multi: false, required: true, autoSelectCurrent: true,
        allowUpload: false, title: 'Select a folder', selectionText: 'Destination', style: 'width:95%' });
      folder.placeAt(box);
      domConstruct.create('div', { innerHTML: 'File name', 'class': 'mpLabel' }, box);
      var name = new ValidationTextBox({ value: (this.model.p.name || 'pipeline').replace(/[^A-Za-z0-9_.()+ -]+/g, '_') + '.json',
        regExp: '[A-Za-z0-9_.()+ -]{1,100}', required: true, style: 'width:95%' });
      name.placeAt(box);
      var owRow = domConstruct.create('div', { style: 'margin-top:6px' }, box);
      var ow = new CheckBox({});
      ow.placeAt(owRow);
      domConstruct.create('label', { innerHTML: ' overwrite if it exists' }, owRow);
      var msg = domConstruct.create('div', { style: 'color:#c00;margin-top:6px;' }, box);
      var row = domConstruct.create('div', { style: 'margin-top:10px;text-align:right;' }, box);
      new Button({ label: 'Cancel', onClick: function () { d.hide(); } }).placeAt(row);
      new Button({ label: 'Save', onClick: function () {
        if (!folder.get('value') || !name.isValid()) { msg.innerHTML = 'Choose a folder and a valid name.'; return; }
        WorkspaceManager.create({ path: folder.get('value'), name: name.get('value'), type: 'json',
          content: JSON.stringify(self.model.toJSON(), null, 1) }, false, !!ow.get('checked')).then(function () {
          d.hide();
          self.flash('Saved ' + folder.get('value') + '/' + name.get('value'), true);
        }, function (e) {
          msg.innerHTML = esc((e && (e.message || e)) || 'save failed') + ' (tick "overwrite" to replace an existing file)';
        });
      } }).placeAt(row);
      d.set('content', box);
      on(d, 'hide', function () { setTimeout(function () { d.destroyRecursive(); }, 0); });
      d.show();
    },

    openFromWorkspace: function () {
      var self = this;
      var d = new Dialog({ title: 'Open pipeline from workspace', style: 'width:480px' });
      var box = domConstruct.create('div', {});
      domConstruct.create('div', { innerHTML: 'Pipeline JSON file', 'class': 'mpLabel' }, box);
      var file = new WorkspaceObjectSelector({ type: ['json', 'unspecified', 'txt'], multi: false, required: true,
        allowUpload: true, title: 'Select a pipeline file', style: 'width:95%' });
      file.placeAt(box);
      var msg = domConstruct.create('div', { style: 'color:#c00;margin-top:6px;' }, box);
      var row = domConstruct.create('div', { style: 'margin-top:10px;text-align:right;' }, box);
      new Button({ label: 'Cancel', onClick: function () { d.hide(); } }).placeAt(row);
      new Button({ label: 'Open', onClick: function () {
        if (!file.get('value')) { msg.innerHTML = 'Choose a file.'; return; }
        WorkspaceManager.getObject(file.get('value')).then(function (res) {
          var p;
          try {
            p = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          } catch (e) {
            msg.innerHTML = 'Not JSON: ' + esc(e.message);
            return;
          }
          if (!p || p.schema !== 'modpipe/pipeline/v1') { msg.innerHTML = 'Not a modpipe pipeline (schema modpipe/pipeline/v1).'; return; }
          self.model.load(p);
          self.select(null);
          self.fit();
          d.hide();
        }, function (e) { msg.innerHTML = esc((e && e.message) || 'could not read the file'); });
      } }).placeAt(row);
      d.set('content', box);
      on(d, 'hide', function () { setTimeout(function () { d.destroyRecursive(); }, 0); });
      d.show();
    },

    addInputDialog: function (preset) {
      var self = this;
      preset = preset || {};
      var cat = this.catalog;
      var d = new Dialog({ title: 'Add pipeline input', style: 'width:520px' });
      var box = domConstruct.create('div', {});
      domConstruct.create('div', { innerHTML: 'Name', 'class': 'mpLabel' }, box);
      var name = new ValidationTextBox({ value: preset.name || this.model.uniqueName(this.model.p.inputs, 'input'),
        regExp: '[A-Za-z][A-Za-z0-9_-]{0,63}', required: true, style: 'width:95%' });
      name.placeAt(box);
      domConstruct.create('div', { innerHTML: 'Data type', 'class': 'mpLabel' }, box);
      var types = (preset.type ? T.concreteSubtypes(cat, preset.type) : Object.keys(cat.types).filter(function (t) {
        return !cat.types[t].abstract && !cat.types[t].registry_only;
      }).sort()).filter(function (t) { return t.indexOf('database') !== 0; });
      var typeSel = new Select({ options: array.map(types, function (t) {
        return { value: t, label: esc(t + (cat.types[t].description ? ' - ' + cat.types[t].description : '')) };
      }), style: 'width:95%', maxHeight: 350 });
      typeSel.placeAt(box);
      if (types.indexOf('reads.short.paired') >= 0 && !preset.type) { typeSel.set('value', 'reads.short.paired'); }
      var cRow = domConstruct.create('div', { style: 'margin-top:6px' }, box);
      var coll = new CheckBox({ checked: !!preset.collection });
      coll.placeAt(cRow);
      domConstruct.create('label', { innerHTML: ' one or more samples (downstream steps run once per sample)' }, cRow);
      var msg = domConstruct.create('div', { style: 'color:#c00;margin-top:6px;' }, box);
      var row = domConstruct.create('div', { style: 'margin-top:10px;text-align:right;' }, box);
      new Button({ label: 'Cancel', onClick: function () { d.hide(); } }).placeAt(row);
      new Button({ label: 'Add', onClick: function () {
        try {
          var n;
          if (preset.forStep) {
            n = self.model.addInputFor(preset.forStep, preset.forPort, typeSel.get('value'), !!coll.get('checked'));
            if (name.get('value') !== n) { self.model.renameInput(n, name.get('value')); n = name.get('value'); }
          } else {
            n = self.model.addInput(name.get('value'), typeSel.get('value'), !!coll.get('checked'), self._visibleCenter());
          }
          d.hide();
          self.select({ kind: 'node', key: 'in:' + n });
        } catch (e) { msg.innerHTML = esc(e.message); }
      } }).placeAt(row);
      d.set('content', box);
      on(d, 'hide', function () { setTimeout(function () { d.destroyRecursive(); }, 0); });
      d.show();
    },

    // ================================================================== model events, validation

    _onModelChange: function (what) {
      this._updateUndo();
      // keep the previous check's badges until the new one answers (no flicker); a load starts clean
      if (what === 'load') { this.autoEdges = {}; this.issues = { byNode: {}, byPort: {}, global: [] }; }
      if (this.sel && this.sel.key && !this._exists(this.sel.key)) { this.sel = null; }
      this._placeNewNodes(what);
      this.render();
      if (!this._fromInspector) { this.renderInspector(); }
      this._renderPalette();
      this._scheduleValidate();
      if (this.onPipelineChange) { this.onPipelineChange(what); }
    },

    /* Nodes added by this edit (created inputs, tools from the palette or a menu, explicit converters) must not land on
       top of existing nodes: nudge each one down until it is clear. Loads, undo and redo keep positions as they are. */
    _placeNewNodes: function (what) {
      var keysNow = PipelineModel.nodeKeys(this.model);
      var known = this._knownKeys;
      this._knownKeys = {};
      var self = this;
      keysNow.forEach(function (k) { self._knownKeys[k] = true; });
      if (!known || /^(load|undo|redo|renameStep|renameInput)$/.test(what)) { return; }
      var added = keysNow.filter(function (k) { return !known[k]; });
      if (!added.length) { return; }
      this._placeMissing();
      var size = lang.hitch(this, 'nodeSize');
      added.forEach(function (k) { PipelineModel.avoidOverlap(self.model, k, size); });
    },

    _exists: function (key) {
      var p = this.model.p;
      if (key.indexOf('in:') === 0) { return !!p.inputs[key.slice(3)]; }
      if (key.indexOf('step:') === 0) { return !!p.steps[key.slice(5)]; }
      return true;
    },

    _scheduleValidate: function () {
      if (this._timer) { clearTimeout(this._timer); }
      this._renderStatus({ pending: true });
      this._timer = setTimeout(lang.hitch(this, 'validateNow'), 600);
    },

    validateNow: function () {
      var self = this;
      var seq = ++this._seq;
      var rev = this.model.revision;
      if (!Object.keys(this.model.p.steps).length) { this._renderStatus({ empty: true }); return null; }
      return this.owner.api('POST', '/api/validate', { pipeline: this.model.toJSON() }).then(function (res) {
        if (seq !== self._seq || rev !== self.model.revision) { return res; }
        self.model.server = res;
        self._indexIssues(res);
        self.render();
        self._renderStatus(res);
        self._refreshInspectorIssues();
        self._renderPalette();
        return res;
      }, function (err) {
        if (seq === self._seq) { self._renderStatus({ error: err.error || (err.errors || []).join('; ') }); }
        return err;
      });
    },

    _indexIssues: function (res) {
      var ix = { byNode: {}, byPort: {}, global: [] };
      array.forEach(res.issues || [], function (it) {
        var w = it.where || '';
        var m = /^steps\.([^.]+)(?:\.(in|out|params)\.(.+))?$/.exec(w);
        var mi = /^inputs\.(.+)$/.exec(w);
        var mo = /^outputs\.(.+)$/.exec(w);
        var key = null;
        if (m) {
          key = 'step:' + m[1];
          if (m[2] === 'in' || m[2] === 'out') {
            var pk = key + '|' + m[2] + '|' + m[3];
            (ix.byPort[pk] = ix.byPort[pk] || []).push(it);
          }
        } else if (mi) {
          key = 'in:' + mi[1];
        } else if (mo && res.pipeline && res.pipeline.outputs && res.pipeline.outputs[mo[1]]) {
          key = nodeKeyOfRef(res.pipeline.outputs[mo[1]]);
        }
        if (key) { (ix.byNode[key] = ix.byNode[key] || []).push(it); } else { ix.global.push(it); }
      });
      this.issues = ix;
      // converters the server inserted: map original edge -> converter step
      var auto = {};
      var sp = res.pipeline && res.pipeline.steps;
      if (sp) {
        Object.keys(sp).forEach(function (a) {
          if (!sp[a].auto) { return; }
          var firstPort = Object.keys(sp[a].in || {})[0];
          var orig = sp[a].in[firstPort];
          if (Array.isArray(orig)) { orig = orig[0]; }
          Object.keys(sp).forEach(function (cs) {
            if (sp[cs].auto) { return; }
            var ins = sp[cs].in || {};
            Object.keys(ins).forEach(function (port) {
              (Array.isArray(ins[port]) ? ins[port] : [ins[port]]).forEach(function (r) {
                if (refStep(r) === a) { auto[orig + '>' + cs + '.' + port] = { step: a, module: sp[a].module }; }
              });
            });
          });
        });
      }
      this.autoEdges = auto;
    },

    _renderStatus: function (res) {
      var n = this.statusNode;
      if (!res || res.empty) {
        n.innerHTML = '<span class="mpMuted">Add tools from the palette or load a template to start.</span>';
        return;
      }
      if (res.pending) {
        domClass.add(n, 'mpPending');
        return;
      }
      domClass.remove(n, 'mpPending');
      if (res.error) { n.innerHTML = '<span class="mpErr">Check failed: ' + esc(res.error) + '</span>'; return; }
      var errs = array.filter(res.issues || [], function (i) { return i.severity === 'error'; });
      var warns = array.filter(res.issues || [], function (i) { return i.severity !== 'error'; });
      var h = res.ok ? '<span class="mpOk">&#10004; Pipeline is valid</span>'
        : '<span class="mpErr">' + errs.length + ' problem' + (errs.length === 1 ? '' : 's') + '</span>';
      if (warns.length) { h += ' &middot; <span class="mpWarn">' + warns.length + ' note' + (warns.length === 1 ? '' : 's') + '</span>'; }
      if (res.ok && res.resources) {
        var r = res.resources;
        h += ' &middot; estimated ' + esc(r.cpu) + ' CPUs, ' + esc(Math.round(r.memory_gb)) + ' GB, ~' + esc(r.runtime) +
          (r.partition ? ' (' + esc(r.partition) + ')' : '');
      }
      h += ' <a href="#" class="mpToggleIssues">' + (this._showIssues ? 'hide details' : 'details') + '</a>';
      if (this._showIssues) {
        h += '<ul class="mpIssueList">' + array.map(res.issues || [], function (it, i) {
          return '<li class="mpSev-' + esc(it.severity) + '" data-i="' + i + '"><b>' + esc(it.where) + '</b>: ' + esc(it.msg) + '</li>';
        }).join('') + '</ul>';
      }
      n.innerHTML = h;
      var self = this;
      var tg = n.querySelector('a.mpToggleIssues');
      on(tg, 'click', function (evt) { evt.preventDefault(); self._showIssues = !self._showIssues; self._renderStatus(res); });
      array.forEach(n.querySelectorAll('li[data-i]'), function (li) {
        on(li, 'click', function () {
          var it = res.issues[Number(li.getAttribute('data-i'))];
          var m = /^steps\.([^.]+)/.exec(it.where) || [];
          var mi = /^inputs\.([^.]+)/.exec(it.where) || [];
          if (m[1] && self.model.p.steps[m[1]]) { self.select({ kind: 'node', key: 'step:' + m[1] }); }
          if (mi[1] && self.model.p.inputs[mi[1]]) { self.select({ kind: 'node', key: 'in:' + mi[1] }); }
        });
      });
    },

    flash: function (msg, good) {
      var h = this.hintNode;
      h.innerHTML = esc(msg);
      domClass.toggle(h, 'mpHintGood', !!good);
      domClass.add(h, 'mpHintShow');
      if (this._flashTimer) { clearTimeout(this._flashTimer); }
      this._flashTimer = setTimeout(function () { domClass.remove(h, 'mpHintShow'); }, 4000);
    },

    // ================================================================== geometry, layout

    nodeSize: function (key) {
      if (key.indexOf('in:') === 0) { return { w: INPUT_W, h: HEAD_H + ROW_H + PAD }; }
      var mod = this.model.module(key.slice(5));
      var rows = mod ? Math.max(mod.inputs.length, mod.outputs.length, 1) : 1;
      return { w: STEP_W, h: HEAD_H + rows * ROW_H + PAD };
    },

    portPos: function (key, dir, portId) {
      var pos = this.model.p.ui.positions[key] || { x: 0, y: 0 };
      if (key.indexOf('in:') === 0) { return { x: pos.x + INPUT_W, y: pos.y + HEAD_H + ROW_H / 2 }; }
      var mod = this.model.module(key.slice(5));
      var list = dir === 'in' ? mod.inputs : mod.outputs;
      var i = 0;
      for (var j = 0; j < list.length; j++) { if (list[j].id === portId) { i = j; } }
      return { x: pos.x + (dir === 'in' ? 0 : STEP_W), y: pos.y + HEAD_H + i * ROW_H + ROW_H / 2 };
    },

    /* Place nodes that have no position yet (silently: positions are presentation, not an edit). */
    _placeMissing: function () {
      var p = this.model.p;
      var keysAll = Object.keys(p.inputs).map(function (n) { return 'in:' + n; })
        .concat(Object.keys(p.steps).map(function (s) { return 'step:' + s; }));
      var missing = keysAll.filter(function (k) { return !p.ui.positions[k]; });
      if (!missing.length) { return; }
      var laid = PipelineModel.layout(this.model, lang.hitch(this, 'nodeSize'));
      var placed = keysAll.length - missing.length;
      if (!placed) {
        missing.forEach(function (k) { p.ui.positions[k] = laid[k]; });
        return;
      }
      // keep existing nodes where they are; put new ones right of their upstream neighbour (or the layout spot)
      var self = this;
      missing.forEach(function (k) {
        var pos = laid[k];
        if (k.indexOf('step:') === 0) {
          var ins = p.steps[k.slice(5)].in || {};
          var refs = [].concat.apply([], Object.keys(ins).map(function (x) { return [].concat(ins[x]); }));
          var up = refs.length ? p.ui.positions[nodeKeyOfRef(refs[0])] : null;
          if (up) { pos = { x: up.x + self.nodeSize(nodeKeyOfRef(refs[0])).w + 90, y: up.y }; }
        }
        p.ui.positions[k] = pos;
      });
    },

    autoLayout: function (silent) {
      var laid = PipelineModel.layout(this.model, lang.hitch(this, 'nodeSize'));
      if (silent) {
        var pos = this.model.p.ui.positions;
        Object.keys(laid).forEach(function (k) { pos[k] = laid[k]; });
        this.render();
      } else {
        this.model.setPositions(laid);
      }
    },

    _applyView: function () {
      var v = this.view;
      domStyle.set(this.stageNode, 'transform', 'translate(' + v.tx + 'px,' + v.ty + 'px) scale(' + v.k + ')');
    },

    zoomBy: function (f, cx, cy) {
      var v = this.view;
      var r = this.wrapNode.getBoundingClientRect();
      if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
      var k = Math.max(0.25, Math.min(2, v.k * f));
      v.tx = cx - (cx - v.tx) * (k / v.k);
      v.ty = cy - (cy - v.ty) * (k / v.k);
      v.k = k;
      this._applyView();
    },

    fit: function () {
      var p = this.model.p;
      var keysAll = Object.keys(p.ui.positions).filter(lang.hitch(this, '_exists'));
      var r = this.wrapNode.getBoundingClientRect();
      if (!keysAll.length || !r.width) { this.view = { tx: 30, ty: 30, k: 1 }; this._applyView(); return; }
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      var self = this;
      keysAll.forEach(function (k) {
        var pos = p.ui.positions[k];
        var s = self.nodeSize(k);
        x0 = Math.min(x0, pos.x); y0 = Math.min(y0, pos.y);
        x1 = Math.max(x1, pos.x + s.w); y1 = Math.max(y1, pos.y + s.h);
      });
      var k = Math.min(1.1, Math.min((r.width - 60) / (x1 - x0), (r.height - 60) / (y1 - y0)));
      k = Math.max(0.25, k);
      this.view = { k: k, tx: (r.width - (x1 - x0) * k) / 2 - x0 * k, ty: (r.height - (y1 - y0) * k) / 2 - y0 * k };
      this._applyView();
    },

    _toStage: function (evt) {
      var r = this.wrapNode.getBoundingClientRect();
      return { x: (evt.clientX - r.left - this.view.tx) / this.view.k, y: (evt.clientY - r.top - this.view.ty) / this.view.k };
    },

    _visibleCenter: function () {
      var r = this.wrapNode.getBoundingClientRect();
      var n = Object.keys(this.model.p.steps).length % 5;
      return { x: (r.width / 2 - this.view.tx) / this.view.k - STEP_W / 2 + n * 20, y: (r.height / 3 - this.view.ty) / this.view.k + n * 20 };
    },

    // ================================================================== rendering

    render: function () {
      this._placeMissing();
      this._applyView();
      var p = this.model.p;
      var self = this;
      var types = this.model.types();
      var srv = this.model.server;
      domConstruct.empty(this.nodesNode);
      this._nodeEls = {};

      Object.keys(p.inputs).forEach(function (name) {
        var key = 'in:' + name;
        var d = p.inputs[name];
        var pos = p.ui.positions[key];
        var iss = self.issues.byNode[key] || [];
        var ref = '$inputs.' + name;
        var outName = self.model.outputNameFor(ref);
        var hasSource = d.source && Object.keys(d.source).length;
        var el = domConstruct.create('div', {
          'class': 'mpNode mpInputNode' + self._selClass(key) + (iss.length ? ' mpHasIssues' : ''),
          style: 'left:' + pos.x + 'px;top:' + pos.y + 'px;width:' + INPUT_W + 'px;height:' + self.nodeSize(key).h + 'px;',
          'data-node': key,
          innerHTML: '<div class="mpNodeHead" data-node="' + esc(key) + '"><div class="mpNodeTitle">' + esc(name) +
            self._badges(iss) + (d.collection ? ' <span class="mpBadge mpScatter" title="a collection: one item per sample">samples</span>' : '') +
            '</div><div class="mpNodeSub">' + (hasSource ? esc(Object.keys(d.source)[0].replace(/_/g, ' ')) : '<i>choose data</i>') + '</div></div>' +
            self._portHtml(key, 'out', { id: name, type: d.type }, 0, ref, outName, types[ref])
        }, self.nodesNode);
        self._nodeEls[key] = el;
      });

      Object.keys(p.steps).forEach(function (sid) {
        var key = 'step:' + sid;
        var st = p.steps[sid];
        var mod = self.catalog.modules[st.module];
        var pos = p.ui.positions[key];
        var iss = self.issues.byNode[key] || [];
        var disabled = self.model.isDisabled(sid);
        var scatter = srv && srv.steps && srv.steps[sid] ? srv.steps[sid].scatter : null;
        var scatterN = srv && srv.steps && srv.steps[sid] ? srv.steps[sid].scatter_size : null;
        if (!srv && mod && mod.outputs.length) { scatter = (types[sid + '.' + mod.outputs[0].id] || {}).collection; }
        var h = '<div class="mpNodeHead" data-node="' + esc(key) + '"><div class="mpNodeTitle">' + esc(sid) + self._badges(iss) +
          (scatter ? ' <span class="mpBadge mpScatter" title="runs once per item of ' + esc(scatter) + '">&times;' + esc(scatterN || 'N') + ' per sample</span>' : '') +
          (disabled ? ' <span class="mpBadge mpOff">off</span>' : '') +
          '</div><div class="mpNodeSub">' + esc(mod ? (mod.label || mod.id) : 'unknown module ' + st.module) + '</div></div>';
        if (mod) {
          mod.inputs.forEach(function (port, i) { h += self._portHtml(key, 'in', port, i, null, null, null); });
          mod.outputs.forEach(function (port, i) {
            var ref = sid + '.' + port.id;
            h += self._portHtml(key, 'out', port, i, ref, self.model.outputNameFor(ref), types[ref]);
          });
        }
        var el = domConstruct.create('div', {
          'class': 'mpNode mpStepNode' + self._selClass(key) + (disabled ? ' mpDisabled' : '') + (iss.length ? ' mpHasIssues' : '') +
            (mod ? ' mpCat-' + esc(mod.category || 'other') : ''),
          style: 'left:' + pos.x + 'px;top:' + pos.y + 'px;width:' + STEP_W + 'px;height:' + self.nodeSize(key).h + 'px;',
          'data-node': key,
          title: mod ? (mod.description || '') : '',
          innerHTML: h
        }, self.nodesNode);
        self._nodeEls[key] = el;
      });
      this.drawEdges();
    },

    _selClass: function (key) {
      return this.sel && this.sel.kind === 'node' && this.sel.key === key ? ' mpSelected' : '';
    },

    _badges: function (iss) {
      var e = array.filter(iss, function (i) { return i.severity === 'error'; }).length;
      var w = iss.length - e;
      var title = esc(array.map(iss, function (i) { return i.msg; }).join('\n'));
      return (e ? ' <span class="mpBadge mpBadgeErr" title="' + title + '">' + e + '</span>' : '') +
        (w ? ' <span class="mpBadge mpBadgeWarn" title="' + title + '">' + w + '</span>' : '');
    },

    _portHtml: function (key, dir, port, i, ref, outName, t) {
      var piss = this.issues.byPort[key + '|' + dir + '|' + port.id] || [];
      var sel = this.sel && this.sel.kind === 'port' && this.sel.key === key && this.sel.port === port.id && this.sel.dir === dir;
      var typeTxt = t ? t.type : port.type;
      var title = (dir === 'in' ? 'input ' : 'output ') + port.id + ': ' + typeTxt +
        (port.cardinality === 'many' ? ' (accepts several)' : '') + (port.required === false ? ' (optional)' : '') +
        (port.description ? '\n' + port.description : '') +
        (piss.length ? '\n\n' + array.map(piss, function (x) { return x.msg; }).join('\n') : '') +
        (dir === 'out' ? '\n\nDrag to an input to connect; right-click for tools that fit.' : '');
      var connected = dir === 'in' && this.model.p.steps[key.slice(5)] && (this.model.p.steps[key.slice(5)].in || {})[port.id] !== undefined;
      var cls = 'mpPort mpPort' + (dir === 'in' ? 'In' : 'Out') + (piss.length ? ' mpPortIssue' : '') + (sel ? ' mpPortSel' : '') +
        (outName ? ' mpSaved' : '') + (port.cardinality === 'many' ? ' mpMany' : '') +
        (dir === 'in' && port.required !== false && !connected ? ' mpNeeds' : '');
      var top = HEAD_H + i * ROW_H;
      var label = esc(port.id) + (dir === 'out' && key.indexOf('in:') === 0 ? ' <span class="mpPortType">' + esc(shortType(typeTxt)) + '</span>' : '') +
        (outName ? ' <span class="mpSavedTag" title="saved to the workspace as ' + esc(outName) + '">&#8615;' + esc(outName) + '</span>' : '');
      return '<div class="' + cls + '" style="top:' + top + 'px" data-node="' + esc(key) + '" data-port="' + esc(port.id) +
        '" data-dir="' + dir + '"' + (ref ? ' data-ref="' + esc(ref) + '"' : '') + ' title="' + esc(title) + '">' +
        '<span class="mpDot"></span><span class="mpPortLabel">' + label + '</span></div>';
    },

    _path: function (a, b) {
      var dx = Math.max(40, Math.abs(b.x - a.x) / 2);
      return 'M' + a.x + ',' + a.y + ' C' + (a.x + dx) + ',' + a.y + ' ' + (b.x - dx) + ',' + b.y + ' ' + b.x + ',' + b.y;
    },

    drawEdges: function () {
      var svg = this.svgNode;
      while (svg.firstChild) { svg.removeChild(svg.firstChild); }
      var NS = 'http://www.w3.org/2000/svg';
      var self = this;
      this._edgeList = this.model.edges();
      this._edgeList.forEach(function (e, i) {
        var a = self.portPos(nodeKeyOfRef(e.from), 'out', e.from.indexOf('$inputs.') === 0 ? e.from.slice(8) : e.from.split('.').slice(1).join('.'));
        var b = self.portPos('step:' + e.toStep, 'in', e.toPort);
        var auto = self.autoEdges[e.from + '>' + e.toStep + '.' + e.toPort];
        var piss = self.issues.byPort['step:' + e.toStep + '|in|' + e.toPort] || [];
        var hasErr = array.some(piss, function (x) { return x.severity === 'error'; });
        var selected = self.sel && self.sel.kind === 'edge' && self.sel.index === i;
        var off = self.model.isDisabled(e.toStep) || (refStep(e.from) && self.model.isDisabled(refStep(e.from)));
        var d = self._path(a, b);
        var vis = document.createElementNS(NS, 'path');
        vis.setAttribute('d', d);
        vis.setAttribute('class', 'mpEdge' + (auto ? ' mpEdgeAuto' : '') + (hasErr ? ' mpEdgeErr' : '') +
          (selected ? ' mpEdgeSel' : '') + (off ? ' mpEdgeOff' : ''));
        svg.appendChild(vis);
        var hit = document.createElementNS(NS, 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('class', 'mpEdgeHit');
        hit.setAttribute('data-edge', String(i));
        svg.appendChild(hit);
        if (auto) {
          var t = document.createElementNS(NS, 'text');
          t.setAttribute('x', String((a.x + b.x) / 2));
          t.setAttribute('y', String((a.y + b.y) / 2 - 6));
          t.setAttribute('class', 'mpAutoLabel');
          t.setAttribute('data-auto', auto.step);
          t.textContent = 'auto: ' + auto.module;
          svg.appendChild(t);
        }
      });
    },

    // ================================================================== canvas interaction

    _bindCanvas: function () {
      var self = this;
      var w = this.wrapNode;
      on(w, 'mousedown', lang.hitch(this, '_onMouseDown'));
      on(w, 'contextmenu', lang.hitch(this, '_onContextMenu'));
      on(w, 'wheel', function (evt) {
        evt.preventDefault();
        var r = w.getBoundingClientRect();
        self.zoomBy(evt.deltaY < 0 ? 1.1 : 1 / 1.1, evt.clientX - r.left, evt.clientY - r.top);
      });
      on(w, 'dragover', function (evt) { evt.preventDefault(); });
      on(w, 'drop', function (evt) {
        evt.preventDefault();
        var d = evt.dataTransfer.getData('text/plain') || '';
        if (d.indexOf('modpipe-module:') === 0) {
          var pos = self._toStage(evt);
          var keep = self.sel;
          self.sel = null;           // dropping places the tool where it lands, unwired
          self.addModule(d.slice('modpipe-module:'.length), { x: pos.x - STEP_W / 2, y: pos.y - HEAD_H / 2 });
          if (!self.sel) { self.sel = keep; }
        }
      });
      on(this.domNode, 'keydown', lang.hitch(this, '_onKey'));   // whole editor: also after clicking inspector buttons
      this.own(on(document, 'mousedown', function (evt) {
        if (self._menu && !self._menu.contains(evt.target)) { self._closeMenu(); }
      }));
    },

    _onKey: function (evt) {
      var tag = (evt.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') { return; }
      var z = evt.keyCode === 90;
      if ((evt.ctrlKey || evt.metaKey) && z && !evt.shiftKey) { evt.preventDefault(); this.model.undo(); return; }
      if ((evt.ctrlKey || evt.metaKey) && ((z && evt.shiftKey) || evt.keyCode === 89)) { evt.preventDefault(); this.model.redo(); return; }
      if (evt.keyCode === keys.DELETE || evt.keyCode === keys.BACKSPACE) { evt.preventDefault(); this.deleteSelection(); return; }
      if (evt.keyCode === keys.ESCAPE) { this._closeMenu(); this.select(null); }
    },

    deleteSelection: function () {
      var s = this.sel;
      if (!s) { return; }
      if (s.kind === 'node' && s.key.indexOf('step:') === 0) { this.model.removeStep(s.key.slice(5)); }
      if (s.kind === 'node' && s.key.indexOf('in:') === 0) { this.model.removeInput(s.key.slice(3)); }
      if (s.kind === 'edge') {
        var e = this._edgeList[s.index];
        if (e) { this.model.disconnect(e.toStep, e.toPort, e.from); }
      }
      this.select(null);
    },

    _closest: function (el, cls) {
      while (el && el !== this.wrapNode) {
        if (el.classList && el.classList.contains(cls)) { return el; }
        el = el.parentNode;
      }
      return null;
    },

    _onMouseDown: function (evt) {
      if (evt.button !== 0) { return; }
      try { this.wrapNode.focus({ preventScroll: true }); } catch (e) { this.wrapNode.focus(); }
      var t = evt.target;
      var port = this._closest(t, 'mpPort');
      var head = this._closest(t, 'mpNode');
      var self = this;
      var start = { x: evt.clientX, y: evt.clientY };
      var moved = false;
      var move, up;
      var listen = function () {
        var h1 = on(document, 'mousemove', function (e) {
          if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 3) { moved = true; }
          move(e);
        });
        var h2 = on(document, 'mouseup', function (e) { h1.remove(); h2.remove(); up(e); });
      };
      evt.preventDefault();

      if (t.getAttribute && t.getAttribute('data-auto')) {
        this.select({ kind: 'auto', step: t.getAttribute('data-auto') });
        return;
      }
      if (t.getAttribute && t.getAttribute('data-edge') !== null && t.getAttribute('data-edge') !== undefined && t.classList.contains('mpEdgeHit')) {
        this.select({ kind: 'edge', index: Number(t.getAttribute('data-edge')) });
        return;
      }
      if (port && port.getAttribute('data-dir') === 'out') {
        // ---- wiring from an output port
        var ref = port.getAttribute('data-ref');
        var from = this.portPos(port.getAttribute('data-node'), 'out', port.getAttribute('data-port'));
        var temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        temp.setAttribute('class', 'mpEdge mpEdgeTemp');
        var statuses = this._markTargets(ref);
        var target = null;
        move = function (e) {
          if (!moved) { return; }
          if (!temp.parentNode) { self.svgNode.appendChild(temp); }
          var p = self._toStage(e);
          temp.setAttribute('d', self._path(from, p));
          var over = self._closest(e.target, 'mpPortIn');
          target = over;
          var hint = '';
          if (over) {
            var st = statuses[over.getAttribute('data-node') + '|' + over.getAttribute('data-port')];
            hint = st ? (STATUS_TEXT[st.status] + ': ' + st.reason + (st.replaces ? ' (replaces ' + st.replaces + ')' : '')) : '';
          }
          if (hint) { self.hintNode.innerHTML = esc(hint); domClass.add(self.hintNode, 'mpHintShow'); } else { domClass.remove(self.hintNode, 'mpHintShow'); }
        };
        up = function (e) {
          if (temp.parentNode) { temp.parentNode.removeChild(temp); }
          self._clearTargets();
          domClass.remove(self.hintNode, 'mpHintShow');
          if (!moved) {
            self.select({ kind: 'port', key: port.getAttribute('data-node'), port: port.getAttribute('data-port'), dir: 'out', ref: ref });
            return;
          }
          if (target) {
            var sid = target.getAttribute('data-node').slice(5);
            var pid = target.getAttribute('data-port');
            try {
              var c = self.model.connect(ref, sid, pid);
              if (c.status === 'convert') { self.flash('Connected; a converter will be inserted automatically', true); }
              if (c.status === 'maybe') { self.flash('Connected; the check will confirm the types once inputs are known', true); }
            } catch (err) {
              self.flash(err.message);
            }
          } else if (!self._closest(e.target, 'mpNode')) {
            // dropped on empty canvas: offer the tools that fit here
            self._menuForRef(ref, e, self._toStage(e));
          }
        };
        listen();
        return;
      }
      if (port && port.getAttribute('data-dir') === 'in') {
        this.select({ kind: 'node', key: port.getAttribute('data-node'), focusPort: port.getAttribute('data-port') });
        return;
      }
      if (head) {
        // ---- dragging a node
        var key = head.getAttribute('data-node');
        var pos0 = lang.mixin({}, this.model.p.ui.positions[key]);
        var dragId = 'move.' + key + '.' + (++this._seq);
        move = function (e) {
          if (!moved) { return; }
          var nx = pos0.x + (e.clientX - start.x) / self.view.k;
          var ny = pos0.y + (e.clientY - start.y) / self.view.k;
          self.model.p.ui.positions[key] = { x: Math.round(nx), y: Math.round(ny) };   // live preview
          domStyle.set(head, { left: Math.round(nx) + 'px', top: Math.round(ny) + 'px' });
          self.drawEdges();
        };
        up = function () {
          if (!moved) { self.select({ kind: 'node', key: key }); return; }
          var fin = self.model.p.ui.positions[key];
          self.model.p.ui.positions[key] = pos0;                     // record the move as one undoable edit
          self.model.setPosition(key, fin.x, fin.y, dragId);
          self.model.endCoalesce();
        };
        listen();
        return;
      }
      // ---- panning the background
      var v0 = lang.mixin({}, this.view);
      move = function (e) {
        if (!moved) { return; }
        self.view.tx = v0.tx + (e.clientX - start.x);
        self.view.ty = v0.ty + (e.clientY - start.y);
        self._applyView();
      };
      up = function () { if (!moved) { self.select(null); } };
      listen();
    },

    _markTargets: function (ref) {
      var statuses = {};
      var self = this;
      array.forEach(this.nodesNode.querySelectorAll('.mpPortIn'), function (el) {
        var sid = el.getAttribute('data-node').slice(5);
        var c = self.model.canConnect(ref, sid, el.getAttribute('data-port'));
        statuses[el.getAttribute('data-node') + '|' + el.getAttribute('data-port')] = c;
        domClass.add(el, 'mpTarget-' + c.status);
      });
      domClass.add(this.wrapNode, 'mpWiring');
      return statuses;
    },

    _clearTargets: function () {
      domClass.remove(this.wrapNode, 'mpWiring');
      array.forEach(this.nodesNode.querySelectorAll('.mpPortIn'), function (el) {
        domClass.remove(el, ['mpTarget-yes', 'mpTarget-maybe', 'mpTarget-convert', 'mpTarget-no']);
      });
    },

    _onContextMenu: function (evt) {
      var port = this._closest(evt.target, 'mpPortOut');
      if (!port) { return; }
      evt.preventDefault();
      var ref = port.getAttribute('data-ref');
      var src = this.model.p.ui.positions[port.getAttribute('data-node')];
      this._menuForRef(ref, evt, { x: src.x + STEP_W + 90, y: src.y });
    },

    /* Menu of tools that can consume `ref`; choosing one adds it wired, at stage position `pos`. */
    _menuForRef: function (ref, evt, pos) {
      this._closeMenu();
      var self = this;
      var cat = this.catalog;
      var rank = { yes: 0, convert: 1, maybe: 2 };
      var fits = Object.keys(cat.modules).map(function (mid) { return { mid: mid, fit: self.moduleFit(ref, mid) }; })
        .filter(function (x) { return x.fit !== 'no'; })
        .sort(function (a, b) { return rank[a.fit] - rank[b.fit] || (a.mid < b.mid ? -1 : 1); });
      var r = this.wrapNode.getBoundingClientRect();
      var menu = this._menu = domConstruct.create('div', { 'class': 'mpMenu',
        style: 'left:' + (evt.clientX - r.left) + 'px;top:' + (evt.clientY - r.top) + 'px;' }, this.wrapNode);
      domConstruct.create('div', { 'class': 'mpMenuHead', innerHTML: 'Tools that can use <b>' + esc(ref) + '</b>' }, menu);
      if (!fits.length) { domConstruct.create('div', { 'class': 'mpMenuItem mpMuted', innerHTML: 'none in the catalog' }, menu); }
      fits.forEach(function (x) {
        var m = cat.modules[x.mid];
        var it = domConstruct.create('div', { 'class': 'mpMenuItem mpFit-' + x.fit, title: STATUS_TEXT[x.fit],
          innerHTML: '<b>' + esc(x.mid) + '</b> <span>' + esc((m.label || '').replace(/^[^:]*:\s*/, '')) + '</span>' +
            (x.fit !== 'yes' ? ' <i>(' + esc(x.fit === 'convert' ? 'via converter' : 'maybe') + ')</i>' : '') }, menu);
        on(it, 'mousedown', function (e) { e.stopPropagation(); });
        on(it, 'click', function () {
          self._closeMenu();
          try {
            var sid = self.model.addStepAfter(x.mid, ref, pos);
            self.select({ kind: 'node', key: 'step:' + sid });
          } catch (err) { self.flash(err.message); }
        });
      });
    },

    _closeMenu: function () {
      if (this._menu) { domConstruct.destroy(this._menu); this._menu = null; }
    },

    // ================================================================== selection & inspector

    select: function (sel) {
      this.sel = sel;
      this.render();
      this.renderInspector();
      this._renderPalette();
    },

    _clearInspector: function () {
      array.forEach(registry.findWidgets(this.inspectorNode), function (w) { w.destroyRecursive(); });
      domConstruct.empty(this.inspectorNode);
      this._inspIssuesNode = null;
    },

    /* Run an edit coming from an inspector widget without rebuilding the inspector (keeps focus). */
    _inspEdit: function (fn) {
      this._fromInspector = true;
      try {
        fn.call(this);
        return true;
      } catch (e) {
        this.flash(e.message);
        return false;
      } finally {
        this._fromInspector = false;
      }
    },

    _section: function (title, parent) {
      var s = domConstruct.create('div', { 'class': 'mpInspSection' }, parent || this.inspectorNode);
      if (title) { domConstruct.create('div', { 'class': 'mpInspTitle', innerHTML: title }, s); }
      return s;
    },

    renderInspector: function () {
      this._clearInspector();
      var s = this.sel;
      if (s && s.kind === 'node' && s.key.indexOf('step:') === 0 && this.model.p.steps[s.key.slice(5)]) { return this._inspectStep(s.key.slice(5), s.focusPort); }
      if (s && s.kind === 'node' && s.key.indexOf('in:') === 0 && this.model.p.inputs[s.key.slice(3)]) { return this._inspectInput(s.key.slice(3)); }
      if (s && s.kind === 'edge' && this._edgeList && this._edgeList[s.index]) { return this._inspectEdge(this._edgeList[s.index]); }
      if (s && s.kind === 'port') { return this._inspectPort(s); }
      if (s && s.kind === 'auto') { return this._inspectAuto(s.step); }
      return this._inspectPipeline();
    },

    _refreshInspectorIssues: function () {
      if (!this._inspIssuesNode || !this._inspIssuesKey) { return; }
      var iss = this.issues.byNode[this._inspIssuesKey] || [];
      this._inspIssuesNode.innerHTML = iss.length ? '<ul class="mpIssueList">' + array.map(iss, function (i) {
        return '<li class="mpSev-' + esc(i.severity) + '"><b>' + esc(i.where.replace(/^steps\.[^.]+\.?/, '').replace(/^inputs\.[^.]+\.?/, '') || 'step') +
          '</b> ' + esc(i.msg) + '</li>';
      }).join('') + '</ul>' : '<span class="mpOk">No problems.</span>';
    },

    _issuesSection: function (key) {
      var sec = this._section('Check');
      this._inspIssuesNode = domConstruct.create('div', {}, sec);
      this._inspIssuesKey = key;
      if (this.model.server) { this._refreshInspectorIssues(); } else { this._inspIssuesNode.innerHTML = '<span class="mpMuted">checking...</span>'; }
    },

    _inspectPipeline: function () {
      var p = this.model.p;
      var self = this;
      var sec = this._section('Pipeline');
      domConstruct.create('div', { 'class': 'mpLabel', innerHTML: 'Name' }, sec);
      var nm = new TextBox({ value: p.name || '', style: 'width:95%', intermediateChanges: true });
      nm.placeAt(sec);
      on(nm, 'change', function (v) { self._inspEdit(function () { self.model.setMeta('name', v); }); });
      domConstruct.create('div', { 'class': 'mpLabel', innerHTML: 'Description' }, sec);
      var ds = new TextBox({ value: p.description || '', style: 'width:95%', intermediateChanges: true });
      ds.placeAt(sec);
      on(ds, 'change', function (v) { self._inspEdit(function () { self.model.setMeta('description', v); }); });
      var outs = Object.keys(p.outputs);
      domConstruct.create('div', { 'class': 'mpInspText', innerHTML:
        Object.keys(p.inputs).length + ' inputs, ' + Object.keys(p.steps).length + ' steps, ' + outs.length + ' saved outputs' +
        (outs.length ? ': ' + esc(outs.join(', ')) : '') }, sec);
      var help = this._section('How to');
      help.innerHTML += '<ul class="mpHelp">' +
        '<li><b>Add a tool:</b> drag it from the palette, or click it.</li>' +
        '<li><b>Connect:</b> drag from an output port (right side) to an input port. While dragging, inputs show ' +
        '<span class="mpKey mpKeyYes">fits</span> <span class="mpKey mpKeyConvert">via converter</span> ' +
        '<span class="mpKey mpKeyMaybe">maybe</span> <span class="mpKey mpKeyNo">no</span>.</li>' +
        '<li><b>What fits next:</b> right-click an output port, or drop a connection on empty canvas.</li>' +
        '<li><b>Data:</b> "+ Pipeline input", then choose its data in this panel. Unconnected inputs of a step offer "Create input".</li>' +
        '<li><b>Save results:</b> select a step and tick the outputs to save to your workspace.</li>' +
        '<li>Delete removes the selection; Ctrl+Z undoes. Scroll to zoom, drag the background to pan.</li></ul>';
    },

    _inspectInput: function (name) {
      var self = this;
      var d = this.model.p.inputs[name];
      var key = 'in:' + name;
      var sec = this._section('Pipeline input');
      domConstruct.create('div', { 'class': 'mpLabel', innerHTML: 'Name' }, sec);
      var nm = new ValidationTextBox({ value: name, regExp: '[A-Za-z][A-Za-z0-9_-]{0,63}', style: 'width:95%' });
      nm.placeAt(sec);
      on(nm, 'change', function (v) {
        if (v === name || !nm.isValid()) { return; }
        try { self.model.renameInput(name, v); self.select({ kind: 'node', key: 'in:' + v }); } catch (e) { self.flash(e.message); }
      });
      domConstruct.create('div', { 'class': 'mpLabel', innerHTML: 'Data type' }, sec);
      var root = d.type.split('.')[0];
      var types = T.concreteSubtypes(this.catalog, root);
      var ts = new Select({ options: array.map(types, function (t) { return { value: t, label: esc(t) }; }), style: 'width:95%', maxHeight: 300 });
      ts.placeAt(sec);
      ts.set('value', d.type, false);
      on(ts, 'change', function (v) {
        if (v === d.type) { return; }
        try { self.model.updateInput(name, { type: v, source: {} }); } catch (e) { self.flash(e.message); }
      });
      var td = this.catalog.types[d.type] || {};
      if (td.description) { domConstruct.create('div', { 'class': 'mpInspText', innerHTML: esc(td.description) }, sec); }
      var cRow = domConstruct.create('div', { style: 'margin-top:6px;' }, sec);
      var cb = new CheckBox({ checked: !!d.collection });
      cb.placeAt(cRow);
      domConstruct.create('label', { innerHTML: ' one or more samples (downstream steps run once per sample)' }, cRow);
      on(cb, 'change', function (v) { try { self.model.updateInput(name, { collection: !!v, source: {} }); } catch (e) { self.flash(e.message); } });

      var srcSec = this._section('Data');
      var body = domConstruct.create('div', {}, srcSec);
      body.innerHTML = '<span class="mpMuted">loading choices...</span>';
      var probs = domConstruct.create('div', { 'class': 'mpProblems' }, srcSec);
      this.sourceOptions(d.type, !!d.collection).then(function (opts) {
        if (!self.sel || self.sel.key !== key) { return; }
        domConstruct.empty(body);
        if (!opts.length) { body.innerHTML = '<span class="mpErr">No data sources available for this type yet.</span>'; return; }
        var kindSel = new Select({ options: array.map(opts, function (o) { return { value: o.kind, label: esc(o.label) }; }), style: 'width:95%' });
        kindSel.placeAt(body);
        var edBody = domConstruct.create('div', { style: 'margin-top:6px;' }, body);
        var editor = null;
        var push = function () {
          if (!editor) { return; }
          var pr = editor.problems();
          probs.innerHTML = pr.length ? esc(pr.join('; ')) : '';
          self._inspEdit(function () { self.model.updateInput(name, { source: editor.getSource() }); });
        };
        var build = function (kind, init) {
          if (editor) { editor.destroy(); }
          var opt = array.filter(opts, function (o) { return o.kind === kind; })[0];
          editor = SourceEditor.create({ inp: { name: name, collection: d.collection }, opt: opt, node: edBody, init: init, onChange: push });
        };
        var cur = SourceEditor.kindOf(d.source, opts);
        kindSel.set('value', cur || opts[0].kind, false);
        build(cur || opts[0].kind, cur ? d.source : null);
        if (!cur) { push(); }
        on(kindSel, 'change', function (k) { build(k, null); push(); });
      }, function (err) { body.innerHTML = '<span class="mpErr">' + esc(err.error || 'could not load data sources') + '</span>'; });

      var used = array.filter(this.model.edges(), function (e) { return e.from === '$inputs.' + name; });
      var useSec = this._section('Used by');
      useSec.innerHTML += used.length ? esc(array.map(used, function (e) { return e.toStep + '.' + e.toPort; }).join(', ')) : '<span class="mpMuted">not connected yet</span>';
      this._issuesSection(key);
      var act = this._section('');
      this._btn('Delete input', 'Remove this input and its connections', function () { this.model.removeInput(name); this.select(null); }, act);
    },

    _inspectStep: function (sid, focusPort) {
      var self = this;
      var st = this.model.p.steps[sid];
      var mod = this.catalog.modules[st.module];
      var key = 'step:' + sid;
      var types = this.model.types();
      var sec = this._section(esc(mod ? mod.label || mod.id : st.module));
      if (mod) {
        domConstruct.create('div', { 'class': 'mpInspText', innerHTML: esc(mod.description || '') +
          (mod.tool ? '<br><span class="mpMuted">' + esc(mod.tool.id) + ' ' + esc(mod.tool.version || '') + ' &middot; ' +
            esc((mod.resources || {}).cpu || 1) + ' CPU, ' + esc((mod.resources || {}).memory || '') + ', ' + esc((mod.resources || {}).runtime || '') + '</span>' : '') }, sec);
      }
      domConstruct.create('div', { 'class': 'mpLabel', innerHTML: 'Step name' }, sec);
      var nm = new ValidationTextBox({ value: sid, regExp: '[A-Za-z][A-Za-z0-9_-]{0,63}', style: 'width:95%' });
      nm.placeAt(sec);
      on(nm, 'change', function (v) {
        if (v === sid || !nm.isValid()) { return; }
        try { self.model.renameStep(sid, v); self.select({ kind: 'node', key: 'step:' + v }); } catch (e) { self.flash(e.message); }
      });
      var opt = (this.model.p.ui.optional || {})[sid];
      if (opt) {
        var oRow = domConstruct.create('div', { style: 'margin-top:6px;' }, sec);
        var ocb = new CheckBox({ checked: !this.model.isDisabled(sid) });
        ocb.placeAt(oRow);
        domConstruct.create('label', { innerHTML: ' ' + esc(opt.label || 'Run this step') + ' <span class="mpMuted">(optional step)</span>' }, oRow);
        on(ocb, 'change', function (v) { self.model.setDisabled(sid, !v); });
      }
      if (!mod) { return; }

      // ---- inputs
      var ins = this._section('Inputs');
      mod.inputs.forEach(function (port) {
        var row = domConstruct.create('div', { 'class': 'mpInspPort' + (focusPort === port.id ? ' mpFocus' : '') }, ins);
        var refs = [].concat((st.in || {})[port.id] === undefined ? [] : st.in[port.id]);
        domConstruct.create('div', { innerHTML: '<b>' + esc(port.id) + '</b> <span class="mpMuted">' + esc(port.type) +
          (port.cardinality === 'many' ? ', several' : '') + (port.required === false ? ', optional' : '') + '</span>' }, row);
        refs.forEach(function (r) {
          var line = domConstruct.create('div', { 'class': 'mpInspRef', innerHTML: '&larr; ' + esc(r) +
            (types[r] ? ' <span class="mpMuted">(' + esc(types[r].type) + ')</span>' : '') + ' ' }, row);
          var x = domConstruct.create('a', { href: '#', innerHTML: 'disconnect' }, line);
          on(x, 'click', function (evt) { evt.preventDefault(); self.model.disconnect(sid, port.id, r); });
        });
        if (!refs.length) {
          var line = domConstruct.create('div', { 'class': 'mpInspRef' }, row);
          domConstruct.create('span', { 'class': port.required === false ? 'mpMuted' : 'mpErr', innerHTML: 'not connected ' }, line);
          var a = domConstruct.create('a', { href: '#', innerHTML: 'create pipeline input', title: 'Add a pipeline input for this port and connect it' }, line);
          on(a, 'click', function (evt) {
            evt.preventDefault();
            var concrete = T.concreteSubtypes(self.catalog, port.type);
            if (concrete.length === 1) {
              try {
                var n = self.model.addInputFor(sid, port.id, concrete[0], false);
                self.select({ kind: 'node', key: 'in:' + n });
              } catch (e) { self.flash(e.message); }
            } else {
              self.addInputDialog({ name: self.model.uniqueName(self.model.p.inputs, port.id), type: port.type, forStep: sid, forPort: port.id });
            }
          });
        }
      });

      // ---- outputs
      var outs = this._section('Outputs <span class="mpMuted">(tick to save to the workspace)</span>');
      mod.outputs.forEach(function (port) {
        var ref = sid + '.' + port.id;
        var row = domConstruct.create('div', { 'class': 'mpInspPort' }, outs);
        var cur = self.model.outputNameFor(ref);
        var cb = new CheckBox({ checked: !!cur });
        cb.placeAt(row);
        domConstruct.create('span', { innerHTML: ' <b>' + esc(port.id) + '</b> <span class="mpMuted">' +
          esc((types[ref] || {}).type || port.type) + (port.when ? ' (conditional)' : '') + '</span>' }, row);
        var nmBox = new ValidationTextBox({ value: cur || self.model.uniqueName(self.model.p.outputs, port.id === 'report' ? sid + '_report' : port.id),
          regExp: '[A-Za-z][A-Za-z0-9_-]{0,63}', style: 'width:60%;margin-left:22px;', disabled: !cur });
        nmBox.placeAt(row);
        on(cb, 'change', function (v) {
          nmBox.set('disabled', !v);
          self._inspEdit(function () { self.model.setOutput(ref, v ? nmBox.get('value') : null); });
        });
        on(nmBox, 'change', function (v) {
          if (!cb.get('checked') || !nmBox.isValid()) { return; }
          self._inspEdit(function () { self.model.setOutput(ref, v); });
        });
      });

      // ---- parameters
      if (mod.params.length) {
        var ps = this._section('Parameters');
        var adv = null;
        var links = this.model.p.ui.links || {};
        mod.params.forEach(function (spec) {
          var parent = ps;
          if (spec.advanced) {
            if (!adv) {
              var tog = domConstruct.create('a', { href: '#', innerHTML: 'Advanced parameters &#9662;', 'class': 'mpAdvToggle' }, ps);
              adv = domConstruct.create('div', { 'class': 'dijitHidden' }, ps);
              on(tog, 'click', function (evt) { evt.preventDefault(); domClass.toggle(adv, 'dijitHidden'); });
            }
            parent = adv;
          }
          var row = domConstruct.create('div', { 'class': 'mpParam' }, parent);
          var linked = links[sid + '.params.' + spec.id];
          domConstruct.create('div', { 'class': 'mpLabel', title: spec.description || '',
            innerHTML: esc(spec.label || spec.id) + (linked ? ' <span class="mpMuted">(follows ' + esc(linked.replace('.params.', '.')) + ')</span>' : '') }, row);
          var cur = (st.params || {})[spec.id];
          var prob = domConstruct.create('div', { 'class': 'mpProblems' }, row);
          var ed = null;
          ed = ParamEditor.create(spec, cur, row, function () {
            if (!ed) { return; }
            var pr = ed.problem();
            prob.innerHTML = pr ? esc(pr) : '';
            if (pr) { return; }
            var v = ed.getValue();
            var def = spec['default'];
            self._inspEdit(function () { self.model.setParam(sid, spec.id, (def !== undefined && v === def) ? undefined : v); });
          });
          if (linked) { ed.widget.set('disabled', true); }
        });
      }
      this._issuesSection(key);
      var act = this._section('');
      this._btn('Delete step', 'Remove this step and its connections (Delete key)', function () { this.model.removeStep(sid); this.select(null); }, act);
    },

    _inspectEdge: function (e) {
      var self = this;
      var types = this.model.types();
      var mod = this.model.module(e.toStep);
      var port = mod && this.model.port(mod, 'in', e.toPort);
      var t = types[e.from];
      var c = t && port ? T.connection(this.catalog, t.type, port.type, t.derived) : 'no';
      var sec = this._section('Connection');
      sec.innerHTML += '<div class="mpInspText"><b>' + esc(e.from) + '</b><br>&rarr; <b>' + esc(e.toStep + '.' + e.toPort) + '</b></div>' +
        '<div class="mpInspText">' + esc(t ? t.type : '?') + ' into ' + esc(port ? port.type : '?') + ': <span class="mpFitText-' + c + '">' + esc(STATUS_TEXT[c]) + '</span></div>';
      var auto = this.autoEdges[e.from + '>' + e.toStep + '.' + e.toPort];
      if (auto) { sec.innerHTML += '<div class="mpInspText">The check inserts <b>' + esc(auto.module) + '</b> on this connection.</div>'; }
      var act = this._section('');
      this._btn('Delete connection', 'Remove this connection (Delete key)', function () {
        this.model.disconnect(e.toStep, e.toPort, e.from);
        this.select(null);
      }, act);
      if (auto) {
        this._btn('Make converter explicit', 'Add the converter as a normal step', function () { self._makeExplicit(auto.step); }, act);
      }
    },

    _inspectPort: function (s) {
      var types = this.model.types();
      var t = types[s.ref] || {};
      var sec = this._section('Output ' + esc(s.ref));
      sec.innerHTML += '<div class="mpInspText">Type <b>' + esc(t.type || '?') + '</b>' + (t.collection ? ' (one per sample of ' + esc(t.collection) + ')' : '') +
        (t.derived ? '<br><span class="mpMuted">The exact type depends on what is connected upstream.</span>' : '') + '</div>' +
        '<div class="mpInspText">The palette now shows the tools that can use this output; click one to add it connected. ' +
        'Or drag from the port to an input.</div>';
      var td = this.catalog.types[t.type] || {};
      if (td.description) { sec.innerHTML += '<div class="mpInspText mpMuted">' + esc(td.description) + '</div>'; }
    },

    _inspectAuto: function (step) {
      var self = this;
      var srv = this.model.server;
      var st = srv && srv.pipeline && srv.pipeline.steps[step];
      var sec = this._section('Automatic converter');
      if (!st) { sec.innerHTML += '<span class="mpMuted">No longer needed.</span>'; return; }
      var m = this.catalog.modules[st.module] || {};
      sec.innerHTML += '<div class="mpInspText">The check inserts <b>' + esc(st.module) + '</b> (' + esc(m.label || '') +
        ') here so the connected types fit. It runs automatically; make it explicit to see or change its parameters.</div>';
      var act = this._section('');
      this._btn('Make explicit', 'Add the converter as a normal step', function () { self._makeExplicit(step); }, act);
    },

    _makeExplicit: function (autoStep) {
      try {
        var sid = this.model.makeExplicit(autoStep, this.model.server ? this.model.server.pipeline : { steps: {} });
        this.select({ kind: 'node', key: 'step:' + sid });
      } catch (e) { this.flash(e.message); }
    }
  });
});
