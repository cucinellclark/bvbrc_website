/*
 * Run setup panel of the Modular Pipeline workbench: what the graph editor's inspector shows when nothing is
 * selected. Everything needed to run the pipeline in one place:
 *   Inputs   one data editor per pipeline input (same choices as the inspector's input panel)
 *   Options  the pipeline's optional steps (ui.optional) and exposed parameters (ui.expose)
 *   Results  results folder + run name -> <folder>/<run name>/, one result folder per step (.<step>/)
 *   Check    the live server check (errors, notes, jobs, estimated resources) and Run
 * Edits go through the graph editor's model (graph._inspEdit), so undo, the graph and the check stay in sync.
 *
 *   RunSetup.render(page, graph, node) -> {alive(), updateCheck(res)}
 *   RunSetup.defaultRunName(pipelineName) -> "<slug>_<yyyymmdd>_<hhmm>"
 */
define([
  'dojo/_base/array', 'dojo/on', 'dojo/dom-construct', 'dojo/dom-class',
  'dijit/form/Select', 'dijit/form/ValidationTextBox', 'dijit/form/CheckBox', 'dijit/form/Button',
  './SourceEditor', './ParamEditor', '../WorkspaceObjectSelector'
], function (
  array, on, domConstruct, domClass,
  Select, ValidationTextBox, CheckBox, Button,
  SourceEditor, ParamEditor, WorkspaceObjectSelector
) {
  var esc = SourceEditor.esc;
  var RUN_NAME_RE = '[A-Za-z0-9][A-Za-z0-9_.-]{0,55}';

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function defaultRunName(name) {
    var s = String(name || 'run').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 30) || 'run';
    var d = new Date();
    return s + '_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function block(parent, title) {
    var b = domConstruct.create('div', { 'class': 'mpSetupBlock' }, parent);
    if (title) { domConstruct.create('div', { 'class': 'mpSetupTitle', innerHTML: title }, b); }
    return b;
  }

  function render(page, graph, node) {
    var model = graph.model;
    var p = model.p;
    var cat = graph.catalog;
    var root = domConstruct.create('div', { 'class': 'mpSetup' }, node);
    var inputProblems = {};          // input name -> node for its check errors
    var editorProblems = {};         // input name -> [problem] from the data editor itself
    var runBtn, runMsg, checkNode, previewNode, folderSel, runBox;
    var submitting = false;

    // ---------------------------------------------------------------- header
    var hb = block(root);
    domConstruct.create('div', { 'class': 'mpSetupTitle', style: 'font-size:14px', innerHTML: 'Run this pipeline' }, hb);
    domConstruct.create('div', { 'class': 'mpMuted', innerHTML: 'Choose the data and options, then Run. ' +
      'Click a step or input on the graph to see all its settings; click the background to come back here.' }, hb);

    // ---------------------------------------------------------------- inputs
    var names = Object.keys(p.inputs);
    var ib = block(root, 'Inputs');
    if (!names.length) {
      domConstruct.create('div', { 'class': 'mpMuted', innerHTML: 'This pipeline has no inputs yet' +
        (page.editing ? ': use "+ Pipeline input" in the palette.' : ': "Edit steps" to add one.') }, ib);
    }
    array.forEach(names, function (name) {
      var d = p.inputs[name];
      var item = domConstruct.create('div', { 'class': 'mpSetupItem' }, ib);
      var td = (cat.types[d.type] || {});
      var lab = domConstruct.create('div', { 'class': 'mpSetupLabel', innerHTML: esc(name) +
        ' <span class="mpMuted">' + esc(d.type) + (d.collection ? ', one or more samples' : '') + '</span> ' }, item);
      var showLink = domConstruct.create('a', { href: '#', innerHTML: 'show', 'class': 'mpMuted', style: 'font-weight:normal;font-size:11px' }, lab);
      on(showLink, 'click', function (evt) { evt.preventDefault(); graph.select({ kind: 'node', key: 'in:' + name }); });
      if (td.description) { domConstruct.create('div', { 'class': 'mpMuted', style: 'font-size:11px', innerHTML: esc(td.description) }, item); }
      var body = domConstruct.create('div', { innerHTML: '<span class="mpMuted">loading choices...</span>' }, item);
      var probs = domConstruct.create('div', { 'class': 'mpSetupProb' }, item);
      inputProblems[name] = domConstruct.create('div', { 'class': 'mpSetupProb' }, item);
      graph.sourceOptions(d.type, !!d.collection).then(function (opts) {
        if (!document.body.contains(body)) { return; }
        domConstruct.empty(body);
        if (!opts.length) { body.innerHTML = '<span class="mpErr">No data sources available for this type yet.</span>'; return; }
        var kindSel = new Select({ options: array.map(opts, function (o) { return { value: o.kind, label: esc(o.label) }; }), style: 'width:95%' });
        kindSel.placeAt(body);
        kindSel.startup();
        var edBody = domConstruct.create('div', { style: 'margin-top:5px;' }, body);
        var editor = null;
        var push = function () {
          if (!editor) { return; }
          var pr = editor.problems();
          editorProblems[name] = pr;
          probs.innerHTML = pr.length ? esc(pr.join('; ')) : '';
          graph._inspEdit(function () { model.updateInput(name, { source: editor.getSource() }); });
          refreshRun();
        };
        var build = function (kind, init) {
          if (editor) { editor.destroy(); }
          var opt = array.filter(opts, function (o) { return o.kind === kind; })[0];
          editor = SourceEditor.create({ inp: { name: name, collection: d.collection }, opt: opt, node: edBody, init: init, onChange: push });
        };
        var cur = SourceEditor.kindOf(d.source, opts);
        kindSel.set('value', cur || opts[0].kind, false);
        build(cur || opts[0].kind, cur ? d.source : null);
        editorProblems[name] = editor.problems();
        probs.innerHTML = editorProblems[name].length && cur ? esc(editorProblems[name].join('; ')) : '';
        on(kindSel, 'change', function (k) { build(k, null); push(); });
        refreshRun();
      }, function (err) { body.innerHTML = '<span class="mpErr">' + esc(err.error || 'could not load data sources') + '</span>'; });
    });

    // ---------------------------------------------------------------- options
    var ui = p.ui || {};
    var optSteps = Object.keys(ui.optional || {}).filter(function (s) { return p.steps[s]; });
    var expose = array.filter(ui.expose || [], function (k) { return p.steps[k.split('.')[0]]; });
    var ob = block(root, 'Options');
    array.forEach(optSteps, function (sid) {
      var o = ui.optional[sid] || {};
      var row = domConstruct.create('div', { 'class': 'mpSetupItem' }, ob);
      var cb = new CheckBox({ checked: !model.isDisabled(sid) });
      cb.placeAt(row);
      domConstruct.create('label', { innerHTML: ' ' + esc(o.label || sid) + ' <span class="mpMuted">(' + esc(p.steps[sid].module) + ')</span>' }, row);
      on(cb, 'change', function (v) {
        graph._inspEdit(function () { model.setDisabled(sid, !v); });
        graph.render();
      });
    });
    array.forEach(expose, function (key) {
      var parts = key.split('.');
      var sid = parts[0];
      var pid = parts[2];
      var st = p.steps[sid];
      var mod = cat.modules[st.module] || {};
      var spec = array.filter(mod.params || [], function (x) { return x.id === pid; })[0];
      if (!spec) { return; }
      var item = domConstruct.create('div', { 'class': 'mpSetupItem' }, ob);
      domConstruct.create('div', { 'class': 'mpSetupLabel', innerHTML: esc(spec.label || pid) +
        ' <span class="mpMuted">' + esc(sid) + (model.isDisabled(sid) ? ', step switched off' : '') + '</span>' }, item);
      if (spec.description) { domConstruct.create('div', { 'class': 'mpMuted', style: 'font-size:11px', innerHTML: esc(spec.description) }, item); }
      var prob = domConstruct.create('div', { 'class': 'mpSetupProb' }, item);
      var ed = null;
      ed = ParamEditor.create(spec, (st.params || {})[pid], item, function () {
        prob.innerHTML = ed.problem() ? esc(ed.problem()) : '';
        if (ed.isValid()) { graph._inspEdit(function () { model.setParam(sid, pid, ed.getValue()); }); }
      });
      domConstruct.place(prob, item);
    });
    if (!optSteps.length && !expose.length) {
      domConstruct.create('div', { 'class': 'mpMuted', innerHTML: 'No options to choose here.' }, ob);
    }
    domConstruct.create('div', { 'class': 'mpMuted', style: 'font-size:11px', innerHTML:
      'Every other parameter: select its step on the graph.' }, ob);

    // ---------------------------------------------------------------- results
    var rb = block(root, 'Results');
    var fItem = domConstruct.create('div', { 'class': 'mpSetupItem' }, rb);
    domConstruct.create('div', { 'class': 'mpSetupLabel', innerHTML: 'Results folder' }, fItem);
    folderSel = new WorkspaceObjectSelector({ type: ['folder'], multi: false, required: true, allowUpload: false,
      title: 'Select a results folder', selectionText: 'Destination', autoSelectCurrent: false, style: 'width:95%' });
    folderSel.placeAt(fItem);
    folderSel.startup();
    if (page.setup.folder) { folderSel.set('value', page.setup.folder); }
    on(folderSel, 'change', function (v) { if (v) { page.setup.folder = v; } refreshRun(); });
    var nItem = domConstruct.create('div', { 'class': 'mpSetupItem' }, rb);
    domConstruct.create('div', { 'class': 'mpSetupLabel', innerHTML: 'Run name' }, nItem);
    runBox = new ValidationTextBox({ value: page.setup.runName || defaultRunName(p.name), regExp: RUN_NAME_RE, required: true,
      trim: true, intermediateChanges: true, style: 'width:95%',
      invalidMessage: 'letters, digits, _ . - (start with a letter or digit, max 56)' });
    runBox.placeAt(nItem);
    runBox.startup();
    page.setup.runName = runBox.get('value');
    on(runBox, 'change', function (v) { page.setup.runName = v; refreshRun(); });
    previewNode = domConstruct.create('div', { 'class': 'mpPathPreview' }, rb);

    // ---------------------------------------------------------------- check + run
    var cb_ = block(root, 'Check');
    domClass.add(cb_, 'mpSetupRunBlock');
    checkNode = domConstruct.create('div', {}, cb_);
    var rr = domConstruct.create('div', { 'class': 'mpRunRow' }, cb_);
    runBtn = new Button({ label: 'Run', disabled: true, onClick: function () {
      if (runBtn.get('disabled')) { return; }
      submitting = true;
      refreshRun();
      runMsg.innerHTML = '<span class="mpMuted">submitting...</span>';
      page.submitRun(page.setup.folder, page.setup.runName).then(function () {
        submitting = false;
      }, function (err) {
        submitting = false;
        if (!document.body.contains(root)) { return; }
        var list = (err && err.errors) || [];
        runMsg.innerHTML = '<span class="mpErr">' + esc((err && err.error) || 'submission failed') + '</span>' +
          (list.length ? '<ul class="mpIssueList">' + array.map(list, function (e) { return '<li class="mpSev-error">' + esc(e) + '</li>'; }).join('') + '</ul>' : '');
        refreshRun();
      });
    } });
    runBtn.placeAt(rr);
    runBtn.startup();
    runMsg = domConstruct.create('div', { 'class': 'mpRunMsg' }, cb_);

    function stepIds() {
      return array.filter(model.order(), function (s) { return !model.isDisabled(s); });
    }

    function refreshRun() {
      // data choices may arrive synchronously (cached), before the results and run widgets exist
      if (!runBox || !runBtn || !document.body.contains(root)) { return; }
      var folder = (page.setup.folder || '').replace(/\/+$/, '');
      var run = runBox.isValid() ? page.setup.runName : '';
      var ids = stepIds();
      previewNode.innerHTML = folder && run ? esc(folder + '/' + run + '/') + '<br><span class="mpMuted">one folder per step: ' +
        esc(array.map(ids.slice(0, 6), function (s) { return '.' + s + '/'; }).join(' ') + (ids.length > 6 ? ' ...' : '')) + '</span>'
        : '<span class="mpMuted">choose a folder and a run name</span>';
      var res = page.check;
      var editorBad = Object.keys(editorProblems).some(function (k) { return (editorProblems[k] || []).length; });
      var ok = !!(res && res.ok) && !!folder && !!run && !editorBad && !submitting;
      runBtn.set('disabled', !ok);
    }

    function updateCheck(res) {
      if (!document.body.contains(root)) { return; }
      Object.keys(inputProblems).forEach(function (k) { inputProblems[k].innerHTML = ''; });
      var h;
      if (!res || res.pending) {
        h = '<span class="mpMuted">checking...</span>';
      } else if (res.empty) {
        h = '<span class="mpMuted">Add steps to the pipeline first.</span>';
      } else if (res.error) {
        h = '<span class="mpErr">Check failed: ' + esc(res.error) + '</span>';
      } else {
        var errs = array.filter(res.issues || [], function (i) { return i.severity === 'error'; });
        var notes = array.filter(res.issues || [], function (i) { return i.severity !== 'error'; });
        array.forEach(errs, function (it) {
          var m = /^inputs\.([^.]+)/.exec(it.where || '');
          if (m && inputProblems[m[1]]) { inputProblems[m[1]].innerHTML += esc(it.msg) + '<br>'; }
        });
        var n = stepIds().length;
        if (res.ok) {
          var r = res.resources || {};
          h = '<div class="mpCheckLine"><span class="mpOk">&#10004; Ready to run</span></div>' +
            '<div class="mpCheckLine mpMuted">' + n + ' job' + (n === 1 ? '' : 's') + ' (one per step)' +
            (r.cpu ? ' &middot; largest step ~' + esc(r.cpu) + ' CPUs, ' + esc(Math.round(r.memory_gb)) + ' GB' : '') +
            (r.runtime ? ' &middot; ~' + esc(r.runtime) : '') + '</div>';
        } else {
          h = '<div class="mpCheckLine"><span class="mpErr">' + errs.length + ' problem' + (errs.length === 1 ? '' : 's') + '</span></div>' +
            '<ul class="mpIssueList">' + array.map(errs.slice(0, 8), function (it, i) {
              return '<li class="mpSev-error" data-w="' + esc(it.where) + '"><b>' + esc(it.where) + '</b>: ' + esc(it.msg) + '</li>';
            }).join('') + (errs.length > 8 ? '<li>... ' + (errs.length - 8) + ' more</li>' : '') + '</ul>';
        }
        if (notes.length) {
          h += '<details><summary class="mpWarn">' + notes.length + ' note' + (notes.length === 1 ? '' : 's') + '</summary><ul class="mpIssueList">' +
            array.map(notes, function (it) { return '<li class="mpSev-warning"><b>' + esc(it.where) + '</b>: ' + esc(it.msg) + '</li>'; }).join('') + '</ul></details>';
        }
      }
      checkNode.innerHTML = h;
      array.forEach(checkNode.querySelectorAll('li[data-w]'), function (li) {
        on(li, 'click', function () {
          var w = li.getAttribute('data-w');
          var ms = /^steps\.([^.]+)/.exec(w);
          if (ms && model.p.steps[ms[1]]) { graph.select({ kind: 'node', key: 'step:' + ms[1] }); }
        });
      });
      refreshRun();
    }

    updateCheck(page.check);
    return {
      alive: function () { return document.body.contains(root); },
      updateCheck: updateCheck
    };
  }

  return { render: render, defaultRunName: defaultRunName, RUN_NAME_RE: RUN_NAME_RE };
});
