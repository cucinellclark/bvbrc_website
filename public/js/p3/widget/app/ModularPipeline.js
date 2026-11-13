/*
 * Modular Pipeline (prototype) workbench: a full-width page (not an AppBase service form) for building and running
 * modpipe pipelines through the prototype modpipe API (ModularService `bin/modpipe serve --backend gowe`), which
 * compiles each pipeline into a GoWe workflow: one ModularStep job per step, results in one folder per run.
 * The API URL comes from p3-web.conf `modularPipelineServiceURL` (default http://localhost:8765).
 *
 * Views (tabs):
 *  - Pipelines: curated templates as cards, the user's saved pipelines, a blank pipeline, recent runs.
 *  - Build: the graph editor (../modpipe/GraphEditor, embedded) with the run-setup panel (../modpipe/RunSetup) in its
 *    inspector when nothing is selected: inputs, options, results folder + run name, live check, Run.
 *  - Runs: the user's runs with per-step state, logs and outputs (../modpipe/RunsView).
 * Design notes: ModularService docs/UI.md "Workbench".
 */
define([
  'dojo/_base/declare', 'dojo/_base/lang', 'dojo/_base/array', 'dojo/on', 'dojo/dom-class', 'dojo/dom-construct',
  'dojo/request', 'dojo/Deferred', 'dojo/dom-geometry', 'dijit/_WidgetBase', 'dijit/form/Button', 'dijit/form/SimpleTextarea', 'dijit/Dialog',
  '../modpipe/GraphEditor', '../modpipe/RunSetup', '../modpipe/RunsView', '../modpipe/SourceEditor'
], function (
  declare, lang, array, on, domClass, domConstruct,
  xhr, Deferred, domGeometry, _WidgetBase, Button, SimpleTextarea, Dialog,
  GraphEditor, RunSetup, RunsView, SourceEditor
) {
  var esc = SourceEditor.esc;
  var VIEWS = [['pipelines', 'Pipelines'], ['build', 'Build'], ['runs', 'Runs']];

  function resolved(x) { var d = new Deferred(); d.resolve(x); return d.promise; }

  return declare([_WidgetBase], {
    baseClass: 'mpWorkbench',
    pageTitle: 'Modular Pipeline (prototype) | BV-BRC',
    templates: null,          // GET /api/templates rows
    catalog: null,
    graph: null,
    view: 'pipelines',
    origin: null,             // {kind: 'template'|'saved'|'blank'|'run', label}
    check: null,              // last check result from the graph editor
    setup: null,              // run-setup values kept across panel re-renders {folder, runName}
    backend: null,
    editing: false,

    // ------------------------------------------------------------------ API

    apiURL: function (path) {
      var base = (window.App && window.App.modularPipelineServiceURL) || 'http://localhost:8765';
      return base.replace(/\/+$/, '') + path;
    },

    api: function (method, path, body) {
      var headers = { 'Content-Type': 'application/json', 'X-Requested-With': null };
      if (window.App && window.App.authorizationToken) { headers.Authorization = window.App.authorizationToken; }
      var opts = { method: method, headers: headers, handleAs: 'json' };
      if (body !== undefined) { opts.data = JSON.stringify(body); }
      return xhr(this.apiURL(path), opts).then(null, function (err) {
        var r = err && err.response && err.response.data;
        throw (r && (r.errors || r.error)) ? r : { error: 'Cannot reach the modpipe API at ' +
          ((window.App && window.App.modularPipelineServiceURL) || 'http://localhost:8765') + ' (is `modpipe serve` running?)' };
      });
    },

    signedIn: function () { return !!(window.App && window.App.authorizationToken); },

    userId: function () {
      var u = window.App && window.App.user;
      return (u && (u.id || u.l_id)) || '';
    },

    // ------------------------------------------------------------------ shell

    buildRendering: function () {
      this.domNode = domConstruct.create('div', { 'class': 'mpWorkbench' });
      var head = domConstruct.create('div', { 'class': 'mpWbHead' }, this.domNode);
      domConstruct.create('div', { 'class': 'mpWbTitle', innerHTML: 'Modular Pipeline<small>prototype</small>' }, head);
      var tabs = domConstruct.create('div', { 'class': 'mpTabs' }, head);
      this.tabNodes = {};
      array.forEach(VIEWS, lang.hitch(this, function (v) {
        var t = this.tabNodes[v[0]] = domConstruct.create('div', { 'class': 'mpTab', innerHTML: v[1], 'data-view': v[0] }, tabs);
        on(t, 'click', lang.hitch(this, 'show', v[0]));
      }));
      this.statusNode = domConstruct.create('div', { 'class': 'mpWbStatus' }, head);
      var body = this.bodyNode = domConstruct.create('div', { 'class': 'mpWbBody' }, this.domNode);
      this.bannerNode = domConstruct.create('div', {}, body);
      this.viewNodes = {};
      array.forEach(VIEWS, lang.hitch(this, function (v) {
        this.viewNodes[v[0]] = domConstruct.create('div', { 'class': 'mpView' }, body);
      }));
    },

    postCreate: function () {
      this.inherited(arguments);
      this.setup = { folder: this._lastFolder(), runName: '' };
      this.runs = new RunsView({ page: this, node: this.viewNodes.runs });
    },

    startup: function () {
      if (this._started) { return; }
      this.inherited(arguments);
      document.title = this.pageTitle;
      if (!this.signedIn()) {
        this.viewNodes.pipelines.innerHTML = '<div class="mpBanner mpBannerWarn">Sign in to BV-BRC (top right) to build and run pipelines.</div>';
        this.show('pipelines');
        return;
      }
      this.show('pipelines');
      this.api('GET', '/api/health').then(lang.hitch(this, function (h) {
        this.backend = h.backend;
        this.statusNode.innerHTML = esc(h.modules) + ' tools &middot; runs on ' + esc(h.backend === 'gowe' ? 'GoWe' : h.backend);
        if (h.backend !== 'gowe') {
          this.bannerNode.innerHTML = '<div class="mpBanner mpBannerWarn">The modpipe API runs with <b>--backend ' + esc(h.backend) +
            '</b>. This page expects <b>--backend gowe</b> (per-step runs); restart it with ' +
            '<code>bin/modpipe serve ... --backend gowe --gowe-server http://localhost:12007</code>.</div>';
        }
      }), lang.hitch(this, function (err) {
        this.bannerNode.innerHTML = '<div class="mpBanner mpBannerErr">' + esc(err.error || err) + '</div>';
      }));
      this.api('GET', '/api/templates').then(lang.hitch(this, function (rows) {
        this.templates = rows;
        this.renderPipelines();
      }), lang.hitch(this, function (err) {
        this.viewNodes.pipelines.innerHTML = '<div class="mpBanner mpBannerErr">' + esc(err.error || err) + '</div>';
      }));
    },

    /* The site's ApplicationContainer (a BorderContainer, with the workspace bar as its bottom region) gives the
       page its box here; the graph then takes the height left in the Build view. */
    resize: function (changeSize) {
      if (changeSize) { domGeometry.setMarginBox(this.domNode, changeSize); }
      this._sizeGraph();
    },

    _sizeGraph: function () {
      if (!this.graph || this.view !== 'build') { return; }
      var main = this.graph.domNode.querySelector('.mpMain');
      if (!main) { return; }
      var body = this.bodyNode;
      var cs = window.getComputedStyle(body);
      var avail = body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      var used = this.bannerNode.offsetHeight;
      var n = this.viewNodes.build;
      array.forEach(n.childNodes, function (c) { if (c.nodeType === 1 && !c.contains(main)) { used += c.offsetHeight; } });
      array.forEach(this.graph.domNode.childNodes, function (c) { if (c !== main.parentNode && c !== main) { used += c.offsetHeight; } });
      var h = Math.max(360, Math.floor(avail - used - 12));   // margin: no scrollbar in the Build view
      if (main.style.height !== h + 'px') {
        main.style.height = h + 'px';
        this._fitSoon();
      }
    },

    destroy: function () {
      if (this.runs) { this.runs.destroy(); }
      this.inherited(arguments);
    },

    show: function (view) {
      this.view = view;
      array.forEach(VIEWS, lang.hitch(this, function (v) {
        domClass.toggle(this.tabNodes[v[0]], 'mpTabOn', v[0] === view);
        domClass.toggle(this.viewNodes[v[0]], 'mpViewOn', v[0] === view);
      }));
      if (view === 'build' && !this.graph) { this.renderBuildEmpty(); }
      if (view === 'build') { this._sizeGraph(); }
      if (this.runs) { this.runs.setActive(view === 'runs' && this.signedIn()); }
      if (view === 'pipelines' && this.templates) { this.renderRecent(); }
    },

    _fitSoon: function () {
      var g = this.graph;
      setTimeout(function () { if (g) { g.fit(); } }, 50);
    },

    _lastFolder: function () {
      try {
        var f = window.localStorage.getItem('modpipe.resultsFolder');
        if (f) { return f; }
      } catch (e) { /* storage blocked */ }
      return this.userId() ? '/' + this.userId() + '/home' : '';
    },

    // ------------------------------------------------------------------ Pipelines view

    renderPipelines: function () {
      var n = this.viewNodes.pipelines;
      domConstruct.empty(n);
      domConstruct.create('div', { 'class': 'mpMuted', style: 'margin-bottom:10px',
        innerHTML: 'Start from a curated pipeline, one you saved, or a blank canvas. Each step runs as its own job; ' +
          'a run\'s results go to one folder in your workspace.' }, n);

      domConstruct.create('div', { 'class': 'mpH2', innerHTML: 'Start' }, n);
      var start = domConstruct.create('div', { 'class': 'mpCards' }, n);
      var blank = domConstruct.create('div', { 'class': 'mpCard mpCardNew mpBlank', innerHTML: '+ Blank pipeline' }, start);
      on(blank, 'click', lang.hitch(this, 'openBlank'));
      var other = domConstruct.create('div', { 'class': 'mpCard mpCardNew', innerHTML: 'Open a pipeline file...' }, start);
      on(other, 'click', lang.hitch(this, function () {
        this.ensureGraph().then(lang.hitch(this, function (g) {
          var orig = g.openWorkspacePipeline;
          var self = this;
          // the editor's open dialog loads into the graph; route it through Build like the other entries
          g.openWorkspacePipeline = function (path) {
            g.openWorkspacePipeline = orig;
            return self.openSaved(path);
          };
          g.openFromWorkspace();
        }));
      }));

      domConstruct.create('div', { 'class': 'mpH2', innerHTML: 'Your pipelines <span class="mpMuted" style="font-weight:normal">(home/pipeline)</span>' }, n);
      this.mineNode = domConstruct.create('div', { 'class': 'mpRows', innerHTML: '<div class="mpRowItem mpMuted">loading...</div>' }, n);
      this.renderMine();

      domConstruct.create('div', { 'class': 'mpH2', innerHTML: 'Recent runs' }, n);
      this.recentNode = domConstruct.create('div', { 'class': 'mpRows' }, n);
      this.renderRecent();

      domConstruct.create('div', { 'class': 'mpH2', innerHTML: 'Curated pipelines' }, n);
      var byCat = {};
      array.forEach(this.templates || [], function (t) { (byCat[t.category || 'other'] = byCat[t.category || 'other'] || []).push(t); });
      Object.keys(byCat).sort().forEach(lang.hitch(this, function (cat) {
        domConstruct.create('div', { 'class': 'mpCat', innerHTML: esc(cat.replace(/_/g, ' ')) }, n);
        var cards = domConstruct.create('div', { 'class': 'mpCards' }, n);
        byCat[cat].sort(function (a, b) { return a.label < b.label ? -1 : 1; }).forEach(lang.hitch(this, function (t) {
          var c = domConstruct.create('div', { 'class': 'mpCard', 'data-template': t.template, innerHTML:
            '<div class="mpCardTitle">' + esc(t.label) + '</div>' +
            '<div class="mpCardDesc">' + esc(t.description || '') + '</div>' +
            '<div class="mpCardChain">' + esc(array.map(t.steps || [], function (s) { return s.module; }).join(' → ')) + '</div>' }, cards);
          on(c, 'click', lang.hitch(this, 'openTemplate', t.template));
        }));
      }));
    },

    renderMine: function () {
      var node = this.mineNode;
      this.ensureGraph().then(lang.hitch(this, function (g) {
        return g.listMyPipelines().then(lang.hitch(this, function (mine) {
          domConstruct.empty(node);
          if (!mine.length) {
            domConstruct.create('div', { 'class': 'mpRowItem mpMuted', innerHTML: 'None yet. In Build, "Save" puts pipelines here.' }, node);
            return;
          }
          mine.slice(0, 12).forEach(lang.hitch(this, function (o) {
            var it = domConstruct.create('div', { 'class': 'mpRowItem', title: o.path, innerHTML:
              '<b>' + esc(o.name.replace(/\.json$/i, '')) + '</b><span class="mpMuted">' +
              esc(String(o.creation_time || '').replace('T', ' ').replace(/\..*$/, '').replace(/Z$/, '')) + '</span>' }, node);
            on(it, 'click', lang.hitch(this, 'openSaved', o.path));
          }));
        }));
      })).then(null, function (err) {
        node.innerHTML = '<div class="mpRowItem mpMuted">' + esc((err && (err.error || err.message)) || 'could not list your pipelines') + '</div>';
      });
    },

    renderRecent: function () {
      var node = this.recentNode;
      if (!node || !this.signedIn()) { return; }
      this.api('GET', '/api/jobs').then(lang.hitch(this, function (jobs) {
        domConstruct.empty(node);
        jobs = array.filter(jobs, function (j) { return j.backend === 'gowe'; }).slice(0, 5);
        if (!jobs.length) {
          domConstruct.create('div', { 'class': 'mpRowItem mpMuted', innerHTML: 'No runs yet.' }, node);
          return;
        }
        jobs.forEach(lang.hitch(this, function (j) {
          var it = domConstruct.create('div', { 'class': 'mpRowItem', innerHTML: RunsView.chip(j.state) +
            ' <b>' + esc(j.run_name || j.output_file) + '</b> <span class="mpMuted">' + esc(j.name || '') + ' &middot; ' +
            esc((j.submitted || '').replace('T', ' ')) + '</span>' }, node);
          on(it, 'click', lang.hitch(this, function () { this.show('runs'); this.runs.select(j.id); }));
        }));
      }), function (err) { node.innerHTML = '<div class="mpRowItem mpMuted">' + esc(err.error || err) + '</div>'; });
    },

    // ------------------------------------------------------------------ Build view

    ensureGraph: function () {
      if (this._graphReady) { return this._graphReady; }
      var self = this;
      var n = this.viewNodes.build;
      this._graphReady = this.api('GET', '/api/catalog').then(function (cat) {
        self.catalog = cat;
        domConstruct.empty(n);
        var head = domConstruct.create('div', { 'class': 'mpBuildHead' }, n);
        self.nameNode = domConstruct.create('span', { 'class': 'mpBuildName' }, head);
        self.originNode = domConstruct.create('span', { 'class': 'mpBuildOrigin' }, head);
        domConstruct.create('span', { 'class': 'mpGrow' }, head);
        self.runStateNode = domConstruct.create('span', { 'class': 'mpRunState' }, head);
        self.headRunBtn = new Button({ label: 'Run', 'class': 'mpHeadRun', title: 'Run this pipeline (opens the run setup if something is missing)',
          onClick: lang.hitch(self, 'onHeadRun') });
        self.headRunBtn.placeAt(head);
        domConstruct.create('span', { 'class': 'mpSep' }, head);
        self.editBtn = new Button({ label: 'Edit steps', title: 'Show the tool palette to add, remove and rewire steps',
          onClick: function () { self.setEditing(!self.editing); } });
        self.editBtn.placeAt(head);
        new Button({ label: 'Save', title: 'Save to your workspace (home/pipeline by default)', onClick: function () {
          if (self.graph.savedPath()) { self.graph.saveInPlace(); } else { self.graph.saveToWorkspace(); }
        } }).placeAt(head);
        new Button({ label: 'Save as...', onClick: function () { self.graph.saveToWorkspace(); } }).placeAt(head);
        new Button({ label: 'JSON...', title: 'View or edit the pipeline as JSON', onClick: lang.hitch(self, 'jsonDialog') }).placeAt(head);
        new Button({ label: 'Download', onClick: function () { self.graph.download(); } }).placeAt(head);
        var host = domConstruct.create('div', {}, n);
        self.graph = new GraphEditor({ owner: self, catalog: cat, embedded: true });
        self.graph.onPipelineChange = lang.hitch(self, '_renderBuildHead');
        self.graph.onSaved = function (path) {
          self.origin = { kind: 'saved', label: path };
          self._renderBuildHead();
          if (self.mineNode) { self.renderMine(); }
        };
        self.graph.placeAt(host);
        self.graph.startup();
        self.setEditing(false);
        self._sizeGraph();
        return self.graph;
      });
      this._graphReady.then(null, function (err) {
        self._graphReady = null;
        n.innerHTML = '<div class="mpBanner mpBannerErr">' + esc(err.error || err) + '</div>';
      });
      return this._graphReady;
    },

    renderBuildEmpty: function () {
      if (this.graph) { return; }
      this.viewNodes.build.innerHTML = '<div class="mpMuted">Choose a pipeline in <b>Pipelines</b> first.</div>';
    },

    setEditing: function (v) {
      this.editing = !!v;
      this.graph.setPaletteVisible(this.editing);
      this.editBtn.set('label', this.editing ? 'Done editing' : 'Edit steps');
      this._fitSoon();
    },

    _renderBuildHead: function () {
      if (!this.graph) { return; }
      var p = this.graph.model.p;
      this.nameNode.innerHTML = esc(p.name || 'Untitled pipeline');
      var o = this.origin || {};
      this.originNode.innerHTML = o.kind === 'template' ? 'from curated pipeline &ldquo;' + esc(o.label) + '&rdquo;'
        : o.kind === 'saved' ? esc(o.label)
          : o.kind === 'run' ? 'from run ' + esc(o.label) : o.kind === 'blank' ? 'new pipeline' : '';
    },

    /* Open a pipeline in Build: load(graph) returns a promise; the run name is reset for the new pipeline. */
    _openIn: function (origin, load, editing) {
      var self = this;
      return this.ensureGraph().then(function (g) {
        self.show('build');
        self.origin = origin;
        self.check = null;
        self._setupState = null;
        return load(g).then(function (x) {
          self.setup.runName = RunSetup.defaultRunName(g.model.p.name);
          self.setEditing(!!editing);
          self._renderBuildHead();
          g.select(null);
          return x;
        });
      });
    },

    openTemplate: function (name) {
      var t = array.filter(this.templates || [], function (x) { return x.template === name; })[0];
      return this._openIn({ kind: 'template', label: t ? t.label : name }, function (g) {
        var d = new Deferred();
        g.loadTemplate(name, function (res) { d.resolve(res); });
        return d.promise;
      });
    },

    openSaved: function (path) {
      return this._openIn({ kind: 'saved', label: path }, function (g) { return g.openWorkspacePipeline(path); });
    },

    openBlank: function () {
      return this._openIn({ kind: 'blank' }, function (g) {
        g.model.reset();
        g._savedPath = null;
        return resolved();
      }, true);
    },

    /* "Open in Build" from a run: its submitted pipeline. */
    openPipeline: function (pipeline, origin) {
      return this._openIn(origin || { kind: 'run' }, function (g) {
        g.model.load(JSON.parse(JSON.stringify(pipeline)));
        g._savedPath = null;
        g.autoLayout(true);
        return resolved();
      });
    },

    jsonDialog: function () {
      var self = this;
      var d = new Dialog({ title: 'Pipeline JSON (modpipe/pipeline/v1)', style: 'width:760px' });
      var box = domConstruct.create('div', {});
      var ta = new SimpleTextarea({ value: JSON.stringify(this.graph.model.toJSON(), null, 2), rows: 28,
        style: 'width:100%;font-family:monospace;font-size:12px;' });
      ta.placeAt(box);
      var msg = domConstruct.create('div', { style: 'color:#c00;margin-top:6px;' }, box);
      var row = domConstruct.create('div', { style: 'margin-top:8px;text-align:right;' }, box);
      new Button({ label: 'Close', onClick: function () { d.hide(); } }).placeAt(row);
      new Button({ label: 'Apply', onClick: function () {
        try {
          var p = JSON.parse(ta.get('value'));
          if (!p || p.schema !== 'modpipe/pipeline/v1') { throw new Error('schema must be modpipe/pipeline/v1'); }
          self.graph.model.load(p);
          self.graph.select(null);
          d.hide();
        } catch (e) { msg.innerHTML = esc(e.message); }
      } }).placeAt(row);
      d.set('content', box);
      on(d, 'hide', function () { setTimeout(function () { d.destroyRecursive(); }, 0); });
      d.show();
    },

    // ------------------------------------------------------------------ run setup (in the inspector)

    renderRunSetup: function (node, graph) {
      this._setupPanel = RunSetup.render(this, graph, node);
    },

    onCheck: function (res) {
      this.check = res;
      if (this._setupPanel && this._setupPanel.alive()) { this._setupPanel.updateCheck(res); }
      this.updateRunBar();
    },

    /* The run-setup panel reports what only it knows (run name valid, data editor problems). */
    setupState: function (st) {
      this._setupState = st;
      this.updateRunBar();
    },

    /* {ready, reason}: the one rule for both Run buttons (header and run-setup panel). */
    readiness: function () {
      var c = this.check;
      var st = this._setupState || {};
      if (!c || c.pending) { return { ready: false, reason: 'checking...' }; }
      if (c.empty) { return { ready: false, reason: 'add steps first' }; }
      if (c.error) { return { ready: false, reason: 'check failed: ' + c.error }; }
      if (!c.ok) {
        var n = array.filter(c.issues || [], function (i) { return i.severity === 'error'; }).length;
        return { ready: false, reason: n + ' problem' + (n === 1 ? '' : 's') + ' to fix', problems: true };
      }
      var probs = [];
      // the data editors' own problems are only current while the run setup is shown (else the server check decides)
      if (this._setupPanel && this._setupPanel.alive()) {
        Object.keys(st.editorProblems || {}).forEach(function (k) { probs = probs.concat(st.editorProblems[k] || []); });
      }
      if (probs.length) { return { ready: false, reason: probs[0] }; }
      if (!this.setup.folder) { return { ready: false, reason: 'choose a results folder' }; }
      var runName = this.setup.runName || '';
      if (st.runValid === false || !new RegExp('^' + RunSetup.RUN_NAME_RE + '$').test(runName)) {
        return { ready: false, reason: 'choose a valid run name' };
      }
      return { ready: true, reason: 'ready' };
    },

    updateRunBar: function () {
      if (!this.runStateNode) { return; }
      var r = this.readiness();
      this.runStateNode.innerHTML = r.ready ? '<span class="mpOk">&#10004; Ready to run</span>'
        : '<span class="' + (r.problems ? 'mpErr' : 'mpMuted') + '">' + esc(r.reason) + '</span>';
      this.headRunBtn.set('disabled', !!this._submitting);
    },

    /* Header Run: submit when everything is set; otherwise open the run setup and say what is missing. */
    onHeadRun: function () {
      var self = this;
      // show the run setup first: it re-reads the data editors, so the decision below is current
      if (!(this._setupPanel && this._setupPanel.alive())) { this.graph.select(null); }
      var r = this.readiness();
      if (!r.ready) {
        this.graph.flash('Before running: ' + r.reason);
        return;
      }
      this.submitRun().then(null, function (err) {
        self.lastSubmitError = err;
        self.graph.select(null);
        self.graph.flash((err && err.error) || 'submission failed');
      });
    },

    submitRun: function () {
      var self = this;
      var folder = this.setup.folder;
      var runName = this.setup.runName;
      this._submitting = true;
      this.updateRunBar();
      try { window.localStorage.setItem('modpipe.resultsFolder', folder); } catch (e) { /* storage blocked */ }
      return this.api('POST', '/api/submit', { pipeline: this.graph.model.toJSON(), output_path: folder,
        output_file: runName }).then(function (res) {
        self._submitting = false;
        self.updateRunBar();
        self.show('runs');
        self.runs.refresh(res.job.id);
        if (self.recentNode) { self.renderRecent(); }
        return res.job;
      }, function (err) {
        self._submitting = false;
        self.updateRunBar();
        throw err;
      });
    }
  });
});
