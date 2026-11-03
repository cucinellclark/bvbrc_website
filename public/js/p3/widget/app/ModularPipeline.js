/*
 * Modular Pipeline (prototype) service form.
 *
 * Builds and submits modpipe pipelines (connected tool modules) through the prototype modpipe API
 * (ModularService repo, `bin/modpipe serve`), because the ModularPipeline app is not registered with the
 * production app service yet. The API URL comes from p3-web.conf `modularPipelineServiceURL`
 * (default http://localhost:8765). Jobs run with the signed-in user's token and write to their workspace.
 *
 * Three views of the work:
 *  - Template form: pick a curated template, fill its inputs/options (GET /api/templates).
 *  - Graph editor (../modpipe/GraphEditor): wire tools into a custom pipeline with instant type checks.
 *  - JSON: the graph editor's pipeline as text.
 * Templates, modules and types all come from the API, so new ones appear here without changes to this file.
 */
define([
  'dojo/_base/declare', 'dojo/_base/lang', 'dojo/_base/array', 'dojo/on', 'dojo/dom-class', 'dojo/dom-construct',
  'dojo/request', 'dojo/when', 'dojo/Deferred',
  'dijit/form/Select', 'dijit/form/TextBox', 'dijit/form/ValidationTextBox', 'dijit/form/NumberTextBox',
  'dijit/form/CheckBox', 'dijit/form/SimpleTextarea', 'dijit/form/Button', 'dijit/Dialog', 'dijit/registry',
  'dojo/text!./templates/ModularPipeline.html', './AppBase', '../WorkspaceObjectSelector',
  '../modpipe/SourceEditor', '../modpipe/ParamEditor', '../modpipe/GraphEditor', 'dijit/form/RadioButton',
  '../WorkspaceFilenameValidationTextBox'
], function (
  declare, lang, array, on, domClass, domConstruct,
  xhr, when, Deferred,
  Select, TextBox, ValidationTextBox, NumberTextBox,
  CheckBox, SimpleTextarea, Button, Dialog, registry,
  Template, AppBase, WorkspaceObjectSelector,
  SourceEditor, ParamEditor, GraphEditor
) {

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  return declare([AppBase], {
    baseClass: 'App ModularPipeline',
    templateString: Template,
    applicationName: 'ModularPipeline',
    applicationLabel: 'Modular Pipeline',
    applicationDescription: 'Build and run pipelines of connected tool modules.',
    requireAuth: true,
    applicationHelp: '',   // no docs yet: AppBase.gethelp() skips; the login template needs these defined
    tutorialLink: '',
    videoLink: '',
    pageTitle: 'Modular Pipeline (prototype) | BV-BRC',
    templates: null,
    current: null,       // selected template record from the API
    inputRows: null,     // name -> {getSource(), problems()}
    paramWidgets: null,  // key -> widget
    stepBoxes: null,     // step -> CheckBox
    jobsTimer: null,
    mode: 'form',        // form | graph | json
    graph: null,         // GraphEditor (created on first use)
    catalog: null,

    apiURL: function (path) {
      var base = (window.App && window.App.modularPipelineServiceURL) || 'http://localhost:8765';
      return base.replace(/\/+$/, '') + path;
    },

    api: function (method, path, body) {
      var headers = { 'Content-Type': 'application/json', 'X-Requested-With': null };
      if (window.App && window.App.authorizationToken) {
        headers.Authorization = window.App.authorizationToken;
      }
      var opts = { method: method, headers: headers, handleAs: 'json' };
      if (body !== undefined) { opts.data = JSON.stringify(body); }
      return xhr(this.apiURL(path), opts).then(null, function (err) {
        var r = err && err.response && err.response.data;
        throw (r && (r.errors || r.error)) ? r : { error: 'Cannot reach the modpipe API at ' + (window.App.modularPipelineServiceURL || 'http://localhost:8765') + ' (is `modpipe serve` running / SSH tunnel open?)' };
      });
    },

    startup: function () {
      if (this._started) { return; }
      this.inherited(arguments);
      if (!this.templateSelect) { return; }   // signed out: AppBase shows its login template instead
      this.inputRows = {};
      this.paramWidgets = {};
      this.stepBoxes = {};
      this.loadTemplates();
      this.refreshJobs();
      this.jobsTimer = setInterval(lang.hitch(this, 'refreshJobs'), 20000);
    },

    destroy: function () {
      if (this.jobsTimer) { clearInterval(this.jobsTimer); }
      this.inherited(arguments);
    },

    // ------------------------------------------------------------------ templates

    loadTemplates: function () {
      this.apiStatusNode.innerHTML = 'Loading templates...';
      this.api('GET', '/api/templates').then(lang.hitch(this, function (rows) {
        this.templates = rows;
        var byCat = {};
        array.forEach(rows, function (t) { (byCat[t.category || 'other'] = byCat[t.category || 'other'] || []).push(t); });
        var opts = [];
        Object.keys(byCat).sort().forEach(function (cat) {
          byCat[cat].sort(function (a, b) { return a.label < b.label ? -1 : 1; }).forEach(function (t) {
            opts.push({ value: t.template, label: '[' + esc(cat) + '] ' + esc(t.label) });
          });
        });
        this.templateSelect.set('options', opts);
        this.apiStatusNode.innerHTML = '(' + rows.length + ' templates)';
        if (opts.length) {
          this.templateSelect.set('value', opts[0].value, false);   // no onChange; build once below
          this.onTemplateChange(opts[0].value);
        }
      }), lang.hitch(this, function (err) {
        this.apiStatusNode.innerHTML = '<span style="color:#c00;">' + esc(err.error || err) + '</span>';
      }));
    },

    onTemplateChange: function (name) {
      if (!this.templates) { return; }
      var t = array.filter(this.templates, function (x) { return x.template === name; })[0];
      if (!t) { return; }
      this.current = t;
      this.templateDescriptionNode.innerHTML = esc(t.description);
      this.stepsNode.innerHTML = 'Steps: ' + array.map(t.steps, function (s) {
        return esc(s.id) + ' <span style="color:#999">(' + esc(s.module) + ')</span>';
      }).join(' &rarr; ');
      this.buildInputs(t);
      this.buildOptions(t);
      domClass.add(this.checkBox, 'dijitHidden');
      this.connectChildren && this.connectChildren();
      this.validate();
    },

    _clear: function (node) {
      array.forEach(registry.findWidgets(node), function (w) { w.destroyRecursive(); });
      domConstruct.empty(node);
    },

    // ------------------------------------------------------------------ inputs

    buildInputs: function (t) {
      this._clear(this.inputsNode);
      this.inputRows = {};
      array.forEach(t.inputs, lang.hitch(this, function (inp) {
        var row = domConstruct.create('div', { 'class': 'appRow', style: 'margin-bottom:12px;' }, this.inputsNode);
        domConstruct.create('label', {
          'class': 'paramlabel',
          innerHTML: esc(inp.name) + (inp.collection ? ' (one or more samples)' : '') +
            ' <span style="color:#888;font-weight:normal;">' + esc(inp.type_description || inp.type) + '</span>'
        }, row);
        domConstruct.create('br', {}, row);
        var kinds = inp.source_options.slice();
        var opts = array.map(kinds, function (o) { return { value: o.kind, label: esc(o.label) }; });
        var kindSel = new Select({ options: opts, style: 'width:60%;margin-bottom:4px;' });
        kindSel.placeAt(row);
        kindSel.startup();
        var body = domConstruct.create('div', { style: 'margin-left:10px;margin-top:4px;' }, row);
        var state = { inp: inp, body: body, kind: null, impl: null };
        var rebuild = lang.hitch(this, function (kind) {
          this._clear(body);
          state.kind = kind;
          var opt = array.filter(kinds, function (o) { return o.kind === kind; })[0];
          state.impl = this.sourceWidget(inp, opt, body);
          this.validate();
        });
        on(kindSel, 'change', rebuild);
        var initial = opts[0] && opts[0].value;
        if (inp.default_source && inp.default_source.database_file) { initial = 'database_file'; }
        if (initial) { kindSel.set('value', initial, false); rebuild(initial); }
        this.inputRows[inp.name] = state;
      }));
    },

    /* Returns {getSource: fn -> source object, problems: fn -> [messages]} for one input + source kind. */
    sourceWidget: function (inp, opt, node) {
      var self = this;
      return SourceEditor.create({ inp: inp, opt: opt, node: node, onChange: function () { self.validate(); } });
    },

    // ------------------------------------------------------------------ options & params

    buildOptions: function (t) {
      this._clear(this.optionalStepsNode);
      this._clear(this.paramsNode);
      this.stepBoxes = {};
      this.paramWidgets = {};
      var self = this;
      array.forEach(t.optional_steps || [], function (o) {
        var row = domConstruct.create('div', { 'class': 'appRow' }, self.optionalStepsNode);
        var cb = new CheckBox({ checked: o.default !== false });
        cb.placeAt(row);
        domConstruct.create('label', { innerHTML: ' ' + esc(o.label) + ' <span style="color:#999">(' + esc(o.module) + ')</span>' }, row);
        self.stepBoxes[o.step] = cb;
      });
      array.forEach(t.params || [], function (p) {
        var row = domConstruct.create('div', { 'class': 'appRow' }, self.paramsNode);
        domConstruct.create('label', {
          'class': 'paramlabel',
          innerHTML: esc(p.label || p.id) + ' <span style="color:#999;font-weight:normal;">(' + esc(p.step) + ')</span>',
          title: p.description || ''
        }, row);
        domConstruct.create('br', {}, row);
        var w = ParamEditor.create(p, undefined, row, null);
        if (p.description) { domConstruct.create('div', { innerHTML: esc(p.description), style: 'color:#999;font-size:0.85em;' }, row); }
        self.paramWidgets[p.key] = w;
      });
      if (!(t.optional_steps || []).length && !(t.params || []).length) {
        domConstruct.create('div', { innerHTML: 'No options for this template.', style: 'color:#999' }, this.paramsNode);
      }
    },

    // ------------------------------------------------------------------ request building

    templateRequest: function () {
      var inputs = {};
      var problems = [];
      Object.keys(this.inputRows).forEach(lang.hitch(this, function (name) {
        var st = this.inputRows[name];
        if (!st.impl) { problems.push(name + ': choose a source'); return; }
        problems = problems.concat(st.impl.problems());
        var src = st.impl.getSource();
        inputs[name] = st.inp.collection ? { source: src, collection: true } : src;
      }));
      var tp = {};
      Object.keys(this.stepBoxes).forEach(lang.hitch(this, function (s) { tp[s + '.enabled'] = !!this.stepBoxes[s].get('checked'); }));
      Object.keys(this.paramWidgets).forEach(lang.hitch(this, function (k) {
        var ed = this.paramWidgets[k];
        var pr = ed.problem();
        if (pr) { problems.push(k + ': ' + pr); return; }
        tp[k] = ed.getValue();
      }));
      return { body: { template: this.current && this.current.template, inputs: inputs, template_params: tp }, problems: problems };
    },

    pipelineRequest: function () {
      try {
        return { body: { pipeline: JSON.parse(this.jsonText.get('value') || '{}') }, problems: [] };
      } catch (e) {
        return { body: null, problems: ['Pipeline JSON does not parse: ' + e.message] };
      }
    },

    currentRequest: function () {
      if (this.mode === 'json') { return this.pipelineRequest(); }
      if (this.mode === 'graph') {
        if (!this.graph) { return { body: null, problems: ['The graph editor is still loading'] }; }
        return { body: { pipeline: this.graph.model.toJSON() }, problems: [] };
      }
      return this.templateRequest();
    },

    // ------------------------------------------------------------------ actions

    showCheck: function (res, problems) {
      domClass.remove(this.checkBox, 'dijitHidden');
      var h = '';
      var errs = (problems || []).concat((res && res.errors) || []);
      if (res && res.error) { errs.push(res.error); }
      if (errs.length) {
        h += '<div style="color:#c00;"><b>Errors</b><ul>' + array.map(errs, function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>';
      } else if (res) {
        h += '<div style="color:#080;"><b>Pipeline is valid.</b></div>';
      }
      if (res && res.warnings && res.warnings.length) {
        h += '<div style="color:#a60;"><b>Notes</b><ul>' + array.map(res.warnings, function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>';
      }
      if (res && res.resources && !errs.length) {
        var r = res.resources;
        h += '<div>Estimated job request: ' + esc(r.cpu) + ' CPUs, ' + esc(r.memory_gb) + ' GB memory, ~' + esc(r.runtime) +
          (r.partition ? ', partition ' + esc(r.partition) : '') + '</div>';
      }
      this.checkNode.innerHTML = h;
      return !errs.length;
    },

    onValidateClick: function () {
      if (this.mode === 'json' && !this._applyJson()) { return null; }
      var req = this.currentRequest();
      if (!req.body) { return this.showCheck(null, req.problems); }
      var path = this.mode === 'form' ? '/api/instantiate' : '/api/validate';
      this.checkNode.innerHTML = 'Checking...';
      domClass.remove(this.checkBox, 'dijitHidden');
      this.api('POST', path, req.body).then(lang.hitch(this, function (res) {
        this.showCheck(res, req.problems);
      }), lang.hitch(this, function (err) { this.showCheck(err, req.problems); }));
    },

    // ------------------------------------------------------------------ modes: form | graph | json

    onModeLabel: function (evt) {
      var m = evt.currentTarget.getAttribute('data-mode');
      ({ form: this.modeForm, graph: this.modeGraph, json: this.modeJson })[m].set('checked', true);
    },

    onModeRadio: function () {
      var m = this.modeGraph.get('checked') ? 'graph' : (this.modeJson.get('checked') ? 'json' : 'form');
      if (m !== this.mode) { this.setMode(m); }
    },

    setMode: function (m) {
      var prev = this.mode;
      if (prev === 'json' && m !== 'json' && !this._applyJson()) {
        this.modeJson.set('checked', true, false);       // keep the user in the JSON view until it parses
        return;
      }
      this.mode = m;
      domClass.toggle(this.templateRow, 'dijitHidden', m !== 'form');
      domClass.toggle(this.inputsBox, 'dijitHidden', m !== 'form');
      domClass.toggle(this.optionsBox, 'dijitHidden', m !== 'form');
      domClass.toggle(this.graphBox, 'dijitHidden', m !== 'graph');
      domClass.toggle(this.jsonBox, 'dijitHidden', m !== 'json');
      domClass.toggle(this.domNode, 'mpWide', m === 'graph');
      domClass.add(this.checkBox, 'dijitHidden');
      this.modeNote.innerHTML = '';
      if (m === 'graph' || m === 'json') {
        this.ensureGraph().then(lang.hitch(this, function () {
          if (m === 'graph') {
            this.graph.render();
            this.graph.fit();
          }
          if (m === 'json') { this.jsonText.set('value', JSON.stringify(this.graph.model.toJSON(), null, 2)); }
        }), lang.hitch(this, function (err) {
          this.modeNote.innerHTML = '<span style="color:#c00">' + esc(err.error || err.message || err) + '</span>';
        }));
      }
    },

    /* Create the graph editor once (needs the catalog); seeded from the template form's current choices. */
    ensureGraph: function () {
      if (this._graphReady) { return this._graphReady; }
      var self = this;
      this.modeNote.innerHTML = 'loading the tool catalog...';
      this._graphReady = this.api('GET', '/api/catalog').then(function (cat) {
        self.catalog = cat;
        self.graph = new GraphEditor({ owner: self, catalog: cat });
        self.graph.placeAt(self.graphNode);
        self.graph.startup();
        self.own(on(self.graph.domNode, 'keydown', function (evt) {
          // Enter in an inspector field must not submit the job form
          if (evt.keyCode === 13 && (evt.target.tagName || '').toLowerCase() === 'input') { evt.preventDefault(); evt.target.blur(); }
        }));
        self.modeNote.innerHTML = '';
        return self.formToGraph();
      });
      this._graphReady.then(null, function () { self._graphReady = null; });
      return this._graphReady;
    },

    /* Open the form's template in the graph editor, carrying over the inputs, options and parameters chosen so far. */
    formToGraph: function () {
      if (!this.current) { return null; }
      var self = this;
      var req = this.templateRequest().body;
      return this.api('GET', '/api/templates/' + encodeURIComponent(this.current.template)).then(function (res) {
        var p = res.pipeline;
        Object.keys(req.inputs || {}).forEach(function (name) {
          var v = req.inputs[name];
          if (p.inputs[name]) { p.inputs[name].source = v.source || v; }
        });
        var disabled = [];
        Object.keys(req.template_params || {}).forEach(function (k) {
          var v = req.template_params[k];
          if (/\.enabled$/.test(k)) {
            if (!v) { disabled.push(k.replace(/\.enabled$/, '')); }
            return;
          }
          var parts = k.split('.');
          var st = p.steps[parts[0]];
          if (st) { st.params = st.params || {}; st.params[parts[2]] = v; }
        });
        if (Object.keys(self.stepBoxes).length) {
          p.ui = p.ui || {};
          p.ui.disabled = disabled;
        }
        self.graph._rememberSourceOptions(res);
        self.graph.templateSel.set('value', self.current.template, false);
        self.graph.model.load(p);
        self.graph.select(null);
        self.graph.autoLayout(true);
        self.graph.fit();
        self.modeNote.innerHTML = 'opened "' + esc(res.label) + '" from the template form';
      });
    },

    _applyJson: function () {
      if (!this.graph) { return true; }
      var txt = this.jsonText.get('value') || '';
      var cur = JSON.stringify(this.graph.model.toJSON(), null, 2);
      if (txt === cur) { return true; }
      try {
        this.graph.model.load(JSON.parse(txt));
        return true;
      } catch (e) {
        this.showCheck(null, ['Pipeline JSON does not parse: ' + e.message + ' (fix it, or "Discard JSON edits")']);
        return false;
      }
    },

    onRevertJson: function () {
      if (this.graph) { this.jsonText.set('value', JSON.stringify(this.graph.model.toJSON(), null, 2)); }
    },

    /* The template form's fields only count in form mode (they stay in the DOM, hidden, in the other modes). */
    validate: function () {
      if (this.mode === 'form' || !this.output_file) { return this.inherited(arguments); }
      var ok = !!(this.output_path.get('value') && this.output_file.get('value') && this.output_file.isValid());
      if (this.submitButton) { this.submitButton.set('disabled', !ok); }
      return ok;
    },

    // AppBase.onSubmit -> validate() -> getValues() -> doSubmit(values)
    getValues: function () {
      if (this.mode === 'json') { this._applyJson(); }
      var req = this.currentRequest();
      var v = lang.mixin({}, req.body || {});
      v.output_path = this.output_path.get('value');
      v.output_file = this.output_file.get('value');
      v._problems = req.problems;
      return v;
    },

    doSubmit: function (values) {
      var d = new Deferred();
      var problems = values._problems || [];
      delete values._problems;
      if (problems.length) {
        this.showCheck(null, problems);
        d.reject(problems.join('; '));
        return d.promise;
      }
      this.api('POST', '/api/submit', values).then(lang.hitch(this, function (res) {
        var j = res.job;
        this.submittedMessage.innerHTML = 'Modular Pipeline job ' + esc(j.id) + ' has been queued (Slurm ' + esc(j.slurm_id) +
          '). Results: <a href="/workspace' + esc(j.result_folder) + '" target="_blank">' + esc(j.result_folder) + '</a>';
        this.refreshJobs();
        d.resolve([j]);
      }), lang.hitch(this, function (err) {
        this.showCheck(err, []);
        d.reject((err && (err.error || (err.errors || []).join('; '))) || 'submission failed');
      }));
      return d.promise;
    },

    // ------------------------------------------------------------------ jobs panel

    refreshJobs: function () {
      if (!window.App || !window.App.authorizationToken) {
        this.jobsNode.innerHTML = '<span style="color:#999">Sign in to see your jobs.</span>';
        return;
      }
      this.api('GET', '/api/jobs').then(lang.hitch(this, function (jobs) {
        if (!jobs.length) { this.jobsNode.innerHTML = '<span style="color:#999">No jobs yet.</span>'; return; }
        var color = { COMPLETED: '#080', FAILED: '#c00', RUNNING: '#06c', PENDING: '#a60', CANCELLED: '#999', TIMEOUT: '#c00' };
        var h = '<table style="width:100%;border-collapse:collapse;"><tr style="text-align:left;border-bottom:1px solid #ccc;">' +
          '<th>Job</th><th>Pipeline</th><th>Submitted</th><th>State</th><th>Elapsed</th><th>Results</th><th></th></tr>';
        array.forEach(jobs, function (j) {
          var state = j.state || 'UNKNOWN';
          if (state === 'COMPLETED' && j.pipeline_status === 'failed') { state = 'FAILED (pipeline)'; }
          h += '<tr style="border-bottom:1px solid #eee;"><td>' + esc(j.id) + '</td><td>' + esc(j.output_file) +
            ' <span style="color:#999">' + esc(j.template || j.name || '') + '</span></td><td>' + esc((j.submitted || '').replace('T', ' ')) +
            '</td><td style="color:' + (color[(j.state || '')] || '#333') + ';">' + esc(state) + '</td><td>' + esc(j.elapsed || '') +
            '</td><td><a href="/workspace' + esc(j.result_folder) + '" target="_blank">folder</a></td>' +
            '<td><a href="#" class="mpLog" data-job="' + esc(j.id) + '">log</a></td></tr>';
        });
        this.jobsNode.innerHTML = h + '</table>';
        array.forEach(this.jobsNode.querySelectorAll('a.mpLog'), lang.hitch(this, function (a) {
          on(a, 'click', lang.hitch(this, function (evt) { evt.preventDefault(); this.showLog(a.getAttribute('data-job')); }));
        }));
      }), lang.hitch(this, function (err) {
        this.jobsNode.innerHTML = '<span style="color:#c00">' + esc(err.error || err) + '</span>';
      }));
    },

    showLog: function (id) {
      this.api('GET', '/api/jobs/' + encodeURIComponent(id) + '/log').then(function (res) {
        new Dialog({ title: 'Job ' + esc(id) + ' log', style: 'width:80%',
          content: '<pre style="max-height:600px;overflow:auto;font-size:11px;">' + esc(res.log) + '</pre>' }).show();
      });
    },

    _onReset: function () {
      this.inherited(arguments);
      if (this.current) { this.onTemplateChange(this.current.template); }
    }
  });
});
