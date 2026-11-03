/*
 * Modular Pipeline (prototype) service form.
 *
 * Builds and submits modpipe pipelines (connected tool modules) through the prototype modpipe API
 * (ModularService repo, `bin/modpipe serve`), because the ModularPipeline app is not registered with the
 * production app service yet. The API URL comes from p3-web.conf `modularPipelineServiceURL`
 * (default http://localhost:8765). Jobs run with the signed-in user's token and write to their workspace.
 *
 * Templates, their inputs (with allowed source kinds), optional steps and exposed parameters all come from
 * GET /api/templates, so new templates/modules appear here without changes to this file.
 */
define([
  'dojo/_base/declare', 'dojo/_base/lang', 'dojo/_base/array', 'dojo/on', 'dojo/dom-class', 'dojo/dom-construct',
  'dojo/request', 'dojo/when', 'dojo/Deferred',
  'dijit/form/Select', 'dijit/form/TextBox', 'dijit/form/ValidationTextBox', 'dijit/form/NumberTextBox',
  'dijit/form/CheckBox', 'dijit/form/SimpleTextarea', 'dijit/form/Button', 'dijit/Dialog', 'dijit/registry',
  'dojo/text!./templates/ModularPipeline.html', './AppBase', '../WorkspaceObjectSelector'
], function (
  declare, lang, array, on, domClass, domConstruct,
  xhr, when, Deferred,
  Select, TextBox, ValidationTextBox, NumberTextBox,
  CheckBox, SimpleTextarea, Button, Dialog, registry,
  Template, AppBase, WorkspaceObjectSelector
) {

  var SRR_RE = /^[SED]RR\d+$/;
  var GENOME_RE = /^\d+\.\d+$/;
  var FEATURE_RE = /^fig\|\d+\.\d+\.[a-z_]+\.\d+$/;

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function splitList(v) {
    return array.filter(String(v || '').split(/[\s,;]+/), function (x) { return x.length > 0; });
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
          this.connectChildren && this.connectChildren();
          this.validate();
        });
        on(kindSel, 'change', rebuild);
        var initial = opts[0] && opts[0].value;
        if (inp.default_source && inp.default_source.database_file) { initial = 'database_file'; }
        if (initial) { kindSel.set('value', initial, false); rebuild(initial); }
        this.inputRows[inp.name] = state;
      }));
    },

    _wsSelector: function (node, wstypes, placeholder, required) {
      var w = new WorkspaceObjectSelector({
        type: wstypes, multi: false, required: required !== false, allowUpload: true,
        placeHolder: placeholder, promptMessage: placeholder, style: 'width:85%'
      });
      w.placeAt(node);
      w.startup();
      return w;
    },

    _text: function (node, placeholder, regExp, width) {
      var w = new ValidationTextBox({ placeHolder: placeholder, required: true, style: 'width:' + (width || '85%'),
        regExp: regExp || '.*', trim: true });
      w.placeAt(node);
      w.startup();
      return w;
    },

    /* Returns {getSource: fn -> source object, problems: fn -> [messages]} for one input + source kind. */
    sourceWidget: function (inp, opt, node) {
      var self = this;
      var coll = inp.collection;
      var kind = opt.kind;
      if (kind === 'paired_end_libs' || kind === 'single_end_libs') {
        var paired = kind === 'paired_end_libs';
        var rows = [];
        var list = domConstruct.create('div', {}, node);
        var addRow = function () {
          var r = domConstruct.create('div', { style: 'border-left:3px solid #ddd;padding-left:6px;margin-bottom:6px;' }, list);
          var rec = { node: r };
          if (coll) {
            rec.sample = self._text(r, 'Sample ID (letters, digits, . _ -)', '[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', '40%');
            domConstruct.create('br', {}, r);
          }
          rec.r1 = self._wsSelector(r, ['reads'], paired ? 'Read file 1' : 'Read file');
          if (paired) { rec.r2 = self._wsSelector(r, ['reads'], 'Read file 2'); }
          if (coll && rows.length > 0) {
            var rm = new Button({ label: 'Remove', onClick: function () {
              rows.splice(rows.indexOf(rec), 1);
              array.forEach(registry.findWidgets(r), function (w) { w.destroyRecursive(); });
              domConstruct.destroy(r);
              self.validate();
            } });
            rm.placeAt(r);
          }
          rows.push(rec);
          self.connectChildren && self.connectChildren();
        };
        addRow();
        if (coll) {
          new Button({ label: '+ Add sample', onClick: function () { addRow(); self.validate(); } }).placeAt(node);
        }
        return {
          getSource: function () {
            var libs = array.map(rows, function (r) {
              var lib = paired ? { read1: r.r1.get('value'), read2: r.r2.get('value') } : { read: r.r1.get('value') };
              if (r.sample) { lib.sample_id = r.sample.get('value'); }
              return lib;
            });
            var src = {};
            src[kind] = libs;
            return src;
          },
          problems: function () {
            var p = [];
            array.forEach(rows, function (r, i) {
              if (!r.r1.get('value') || (paired && !r.r2.get('value'))) { p.push(inp.name + ': choose the read file(s) for row ' + (i + 1)); }
              if (r.sample && !r.sample.get('value')) { p.push(inp.name + ': sample ID missing in row ' + (i + 1)); }
            });
            return p;
          }
        };
      }
      if (kind === 'srr_ids' || kind === 'genome_ids' || kind === 'feature_ids') {
        var re = { srr_ids: SRR_RE, genome_ids: GENOME_RE, feature_ids: FEATURE_RE }[kind];
        var ph = { srr_ids: 'e.g. SRR2838702 SRR2838703', genome_ids: 'e.g. 1206109.14', feature_ids: 'e.g. fig|1206109.14.peg.1' }[kind];
        var tb = new TextBox({ placeHolder: ph + (coll || kind === 'feature_ids' ? ' (space or comma separated)' : ''), style: 'width:85%' });
        tb.placeAt(node);
        tb.startup();
        return {
          getSource: function () { var s = {}; s[kind] = splitList(tb.get('value')); return s; },
          problems: function () {
            var ids = splitList(tb.get('value'));
            var bad = array.filter(ids, function (x) { return !re.test(x); });
            var p = [];
            if (!ids.length) { p.push(inp.name + ': enter at least one ID'); }
            if (bad.length) { p.push(inp.name + ': invalid ID(s) ' + bad.join(', ')); }
            if (!coll && kind !== 'feature_ids' && ids.length > 1) { p.push(inp.name + ': only one ID allowed (this input is not a collection)'); }
            return p;
          }
        };
      }
      if (kind === 'wsid' || kind === 'genome_group' || kind === 'feature_group') {
        var sel = this._wsSelector(node, opt.wstypes || ['unspecified'], opt.label);
        return {
          getSource: function () { var s = {}; s[kind] = sel.get('value'); return s; },
          problems: function () { return sel.get('value') ? [] : [inp.name + ': choose a workspace item']; }
        };
      }
      if (kind === 'wsids') {
        var sels = [];
        var box = domConstruct.create('div', {}, node);
        var add = function () { sels.push(self._wsSelector(box, opt.wstypes || ['unspecified'], opt.label)); self.connectChildren && self.connectChildren(); };
        add();
        new Button({ label: '+ Add file', onClick: function () { add(); self.validate(); } }).placeAt(node);
        return {
          getSource: function () { return { wsids: array.filter(array.map(sels, function (s) { return s.get('value'); }), function (v) { return !!v; }) }; },
          problems: function () { return this.getSource().wsids.length ? [] : [inp.name + ': choose at least one file']; }
        };
      }
      if (kind === 'fasta_data') {
        var ta = new SimpleTextarea({ rows: 6, style: 'width:85%;font-family:monospace;', placeHolder: '>seq1\nACGT...' });
        ta.placeAt(node);
        ta.startup();
        return {
          getSource: function () { return { fasta_data: ta.get('value') }; },
          problems: function () { return /^\s*>/.test(ta.get('value') || '') ? [] : [inp.name + ': paste FASTA starting with >']; }
        };
      }
      if (kind === 'database_file') {
        var choices = opt.choices || [];
        var ds = new Select({ options: array.map(choices, function (c) { return { value: c.value, label: esc(c.label) }; }), style: 'width:85%' });
        ds.placeAt(node);
        ds.startup();
        if (inp.default_source && inp.default_source.database_file) { ds.set('value', inp.default_source.database_file); }
        return {
          getSource: function () { return { database_file: ds.get('value') }; },
          problems: function () { return ds.get('value') ? [] : [inp.name + ': choose a reference']; }
        };
      }
      domConstruct.create('div', { innerHTML: 'Unsupported source ' + esc(kind) }, node);
      return { getSource: function () { return {}; }, problems: function () { return [inp.name + ': unsupported source']; } };
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
        var w;
        if (p.type === 'enum' || p.type === 'database') {
          var opts = p.type === 'enum'
            ? array.map(p['enum'], function (v) { return { value: String(v), label: esc(v) }; })
            : array.map(p.choices || [], function (c) { return { value: c.value, label: esc(c.value + (c.status === 'unverified' ? ' (unverified)' : '')) }; });
          w = new Select({ options: opts, style: 'width:60%' });
          if (p['default'] !== undefined && p['default'] !== null) { w.set('value', String(p['default'])); }
        } else if (p.type === 'bool') {
          w = new CheckBox({ checked: !!p['default'] });
        } else if (p.type === 'int' || p.type === 'float') {
          var c = { places: p.type === 'int' ? 0 : '0,6' };
          if (p.min !== undefined) { c.min = p.min; }
          if (p.max !== undefined) { c.max = p.max; }
          w = new NumberTextBox({ value: p['default'], constraints: c, required: true, style: 'width:30%' });
        } else {
          w = new ValidationTextBox({ value: p['default'] || '', regExp: p.pattern || '.*', style: 'width:60%',
            invalidMessage: 'Allowed: ' + (p.pattern || 'any'), trim: true });
        }
        w.placeAt(row);
        w.startup();
        if (p.description) { domConstruct.create('div', { innerHTML: esc(p.description), style: 'color:#999;font-size:0.85em;' }, row); }
        w._mpType = p.type;
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
        var w = this.paramWidgets[k];
        var v = w._mpType === 'bool' ? !!w.get('checked') : w.get('value');
        if (w._mpType === 'int' || w._mpType === 'float') {
          if (isNaN(v)) { problems.push(k + ': enter a number'); return; }
        }
        if (w._mpType === 'string' && w.isValid && !w.isValid()) { problems.push(k + ': value not allowed'); return; }
        tp[k] = v;
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
      return this.jsonModeBox.get('checked') ? this.pipelineRequest() : this.templateRequest();
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
      var req = this.currentRequest();
      if (!req.body) { return this.showCheck(null, req.problems); }
      var path = this.jsonModeBox.get('checked') ? '/api/validate' : '/api/instantiate';
      this.checkNode.innerHTML = 'Checking...';
      domClass.remove(this.checkBox, 'dijitHidden');
      this.api('POST', path, req.body).then(lang.hitch(this, function (res) {
        this.showCheck(res, req.problems);
      }), lang.hitch(this, function (err) { this.showCheck(err, req.problems); }));
    },

    onJsonModeChange: function (on_) {
      domClass.toggle(this.jsonBox, 'dijitHidden', !on_);
      domClass.toggle(this.inputsBox, 'dijitHidden', !!on_);
      domClass.toggle(this.optionsBox, 'dijitHidden', !!on_);
      if (on_ && !this.jsonText.get('value')) { this.onLoadTemplateJson(); }
    },

    onLoadTemplateJson: function () {
      var req = this.templateRequest();
      this.api('POST', '/api/instantiate', req.body).then(lang.hitch(this, function (res) {
        if (res.pipeline) {
          this.jsonText.set('value', JSON.stringify(res.pipeline, null, 2));
        } else {
          this.showCheck(res, req.problems);
        }
      }), lang.hitch(this, function (err) { this.showCheck(err, []); }));
    },

    // AppBase.onSubmit -> validate() -> getValues() -> doSubmit(values)
    getValues: function () {
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
