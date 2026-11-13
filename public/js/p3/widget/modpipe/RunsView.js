/*
 * Runs view of the Modular Pipeline workbench: the user's runs (GET /api/jobs) and, for the selected run,
 * GET /api/jobs/<id>: the steps in order with their state, time, output folders and log
 * (GET /api/jobs/<id>/log?step=<id>), the pipeline outputs, Cancel (POST /api/jobs/<id>/cancel) and
 * "Open in Build" (the submitted pipeline). Polls every 10 s while the view is shown.
 *
 *   var rv = new RunsView({page, node}); rv.setActive(bool); rv.refresh(selectId); rv.select(id); rv.destroy()
 *   RunsView.chip(state) -> HTML of a colored state chip
 */
define([
  'dojo/_base/declare', 'dojo/_base/lang', 'dojo/_base/array', 'dojo/on', 'dojo/dom-construct', 'dojo/dom-class',
  'dijit/form/Button', 'dijit/registry', './SourceEditor'
], function (declare, lang, array, on, domConstruct, domClass, Button, registry, SourceEditor) {
  var esc = SourceEditor.esc;
  var ACTIVE = { PENDING: 1, RUNNING: 1, QUEUED: 1, SCHEDULED: 1, DISPATCHED: 1, STAGING: 1 };
  var POLL_MS = 10000;

  function chip(state, extra) {
    var s = String(state || 'UNKNOWN').toUpperCase();
    return '<span class="mpChip mpSt-' + esc(s) + '">' + esc(s.toLowerCase()) + (extra ? ' ' + esc(extra) : '') + '</span>';
  }

  function wsLink(path, label) {
    return '<a href="/workspace' + esc(path) + '" target="_blank" title="' + esc(path) + '">' + esc(label || path) + '</a>';
  }

  function when(s) { return String(s || '').replace('T', ' ').replace(/\..*$/, '').replace(/Z$/, ''); }

  var RunsView = declare(null, {
    page: null,
    node: null,
    selected: null,
    jobs: null,
    openLogs: null,

    constructor: function (args) {
      lang.mixin(this, args);
      this.openLogs = {};
      this.jobs = [];
      var wrap = domConstruct.create('div', { 'class': 'mpRunsWrap' }, this.node);
      var left = domConstruct.create('div', { 'class': 'mpRunList' }, wrap);
      var bar = domConstruct.create('div', { style: 'margin-bottom:6px;display:flex;align-items:center;gap:8px' }, left);
      domConstruct.create('span', { 'class': 'mpH2', style: 'margin:0', innerHTML: 'Your runs' }, bar);
      var rb = new Button({ label: 'Refresh', onClick: lang.hitch(this, function () { this.refresh(); }) });
      rb.placeAt(bar);
      this._widgets = [rb];
      this.listNode = domConstruct.create('div', { 'class': 'mpRows', innerHTML: '<div class="mpRowItem mpMuted">loading...</div>' }, left);
      this.detailNode = domConstruct.create('div', { 'class': 'mpRunDetail', innerHTML: '<span class="mpMuted">Select a run.</span>' }, wrap);
    },

    destroy: function () {
      this.setActive(false);
      array.forEach(this._widgets, function (w) { w.destroyRecursive(); });
      this._clearDetailWidgets();
    },

    setActive: function (v) {
      if (v && !this._timer) {
        this.refresh();
        this._timer = setInterval(lang.hitch(this, '_poll'), POLL_MS);
      } else if (!v && this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    },

    _poll: function () {
      var anyActive = array.some(this.jobs, function (j) { return ACTIVE[j.state]; });
      if (anyActive) { this.refresh(null, true); }
    },

    refresh: function (selectId, quiet) {
      var self = this;
      if (selectId) { this.selected = selectId; }
      return this.page.api('GET', '/api/jobs').then(function (jobs) {
        self.jobs = jobs;
        self.renderList();
        if (self.selected) { self.select(self.selected, quiet); }
      }, function (err) {
        self.listNode.innerHTML = '<div class="mpRowItem mpErr">' + esc(err.error || err) + '</div>';
      });
    },

    renderList: function () {
      var self = this;
      domConstruct.empty(this.listNode);
      if (!this.jobs.length) {
        this.listNode.innerHTML = '<div class="mpRowItem mpMuted">No runs yet. Build a pipeline and press Run.</div>';
        return;
      }
      array.forEach(this.jobs, function (j) {
        var prog = j.steps_total && j.state !== 'COMPLETED' ? (j.steps_done || 0) + '/' + j.steps_total : '';
        var it = domConstruct.create('div', { 'class': 'mpRowItem mpRunListItem' + (j.id === self.selected ? ' mpSel' : ''),
          innerHTML: '<div style="flex:1;min-width:0"><div class="mpRunName">' + esc(j.run_name || j.output_file) + '</div>' +
            '<div class="mpRunSub">' + esc(j.name || '') + (j.backend === 'gowe' ? '' : ' (Slurm)') + '<br>' + esc(when(j.submitted)) + '</div></div>' +
            chip(j.state, prog) }, self.listNode);
        on(it, 'click', function () { self.select(j.id); });
      });
    },

    _clearDetailWidgets: function () {
      array.forEach(registry.findWidgets(this.detailNode), function (w) { w.destroyRecursive(); });
    },

    select: function (id, quiet) {
      var self = this;
      this.selected = id;
      array.forEach(this.listNode.querySelectorAll('.mpRunListItem'), function (n, i) {
        domClass.toggle(n, 'mpSel', self.jobs[i] && self.jobs[i].id === id);
      });
      var j = array.filter(this.jobs, function (x) { return x.id === id; })[0];
      if (j && j.backend !== 'gowe') { return this.renderSlurm(j); }
      if (!quiet) { this.detailNode.innerHTML = '<span class="mpMuted">loading...</span>'; }
      return this.page.api('GET', '/api/jobs/' + encodeURIComponent(id)).then(function (d) {
        if (self.selected === id) { self.renderDetail(d); }
      }, function (err) {
        if (self.selected === id) { self.detailNode.innerHTML = '<span class="mpErr">' + esc(err.error || err) + '</span>'; }
      });
    },

    renderSlurm: function (j) {
      this._clearDetailWidgets();
      this.detailNode.innerHTML = '<div class="mpDetailHead"><span class="mpBuildName">' + esc(j.output_file) + '</span>' + chip(j.state) + '</div>' +
        '<div class="mpKV">A Slurm run from the earlier form (one job for the whole pipeline). Submitted <b>' + esc(when(j.submitted)) +
        '</b>; results ' + wsLink(j.result_folder) + '.</div>';
    },

    renderDetail: function (d) {
      var self = this;
      this._clearDetailWidgets();
      var n = this.detailNode;
      domConstruct.empty(n);
      var steps = d.step_detail || [];
      var active = !!ACTIVE[d.state];

      var head = domConstruct.create('div', { 'class': 'mpDetailHead' }, n);
      domConstruct.create('span', { 'class': 'mpBuildName', innerHTML: esc(d.run_name || d.output_file) }, head);
      domConstruct.create('span', { innerHTML: chip(d.state, d.steps_total && d.state !== 'COMPLETED' ? (d.steps_done || 0) + '/' + d.steps_total + ' steps' : '') }, head);
      domConstruct.create('span', { 'class': 'mpGrow' }, head);
      var bRefresh = new Button({ label: 'Refresh', onClick: function () { self.refresh(d.id); } });
      bRefresh.placeAt(head);
      if (active) {
        var bCancel = new Button({ label: 'Cancel run', onClick: function () {
          if (!window.confirm('Cancel run ' + (d.run_name || d.id) + '? Steps that already finished keep their results.')) { return; }
          bCancel.set('disabled', true);
          self.page.api('POST', '/api/jobs/' + encodeURIComponent(d.id) + '/cancel').then(function () { self.refresh(d.id); },
            function (err) { bCancel.set('disabled', false); window.alert(err.error || err); });
        } });
        bCancel.placeAt(head);
      }
      if (d.pipeline) {
        new Button({ label: 'Open in Build', title: 'Open the pipeline of this run to change it and run again', onClick: function () {
          self.page.openPipeline(d.pipeline, { kind: 'run', label: d.run_name || d.id });
        } }).placeAt(head);
      }

      domConstruct.create('div', { 'class': 'mpKV', innerHTML:
        '<b>' + esc(d.name || '') + '</b> &middot; submitted ' + esc(when(d.submitted)) +
        (d.elapsed ? ' &middot; ' + (active ? 'running for ' : 'took ') + esc(d.elapsed) : '') +
        ' &middot; results ' + wsLink(d.result_folder) +
        (d.status_error ? '<br><span class="mpErr">' + esc(d.status_error) + '</span>' : '') }, n);

      var chain = domConstruct.create('div', { 'class': 'mpChain' }, n);
      array.forEach(steps, function (s, i) {
        if (i) { domConstruct.create('span', { 'class': 'mpChainArrow', innerHTML: '&rarr;' }, chain); }
        domConstruct.create('span', { innerHTML: '<span class="mpChip mpSt-' + esc(s.state) + '" title="' + esc(s.module + ': ' + s.state.toLowerCase()) + '">' +
          esc(s.id) + '</span>' }, chain);
      });

      var outs = Object.keys(d.outputs || {});
      if (outs.length) {
        domConstruct.create('div', { 'class': 'mpKV', innerHTML: '<b>Pipeline outputs:</b> ' +
          array.map(outs, function (k) { return wsLink(d.outputs[k], k); }).join(' &middot; ') }, n);
      }

      var tbl = domConstruct.create('table', { 'class': 'mpStepTable' }, n);
      tbl.innerHTML = '<tr><th>Step</th><th>Tool</th><th>State</th><th>Time</th><th>Outputs</th><th></th></tr>';
      array.forEach(steps, function (s) {
        var tr = domConstruct.create('tr', {}, tbl);
        var ports = Object.keys(s.outputs || {});
        tr.innerHTML = '<td><b>' + esc(s.id) + '</b></td><td>' + esc(s.module || '') + '</td><td>' + chip(s.state) + '</td>' +
          '<td>' + esc(s.elapsed || '') + '</td><td>' + (ports.length ? array.map(ports, function (k) { return wsLink(s.outputs[k], k); }).join(' ')
          : (s.state === 'SUCCESS' ? wsLink(s.folder, 'folder') : '<span class="mpMuted">-</span>')) + '</td>' +
          '<td><a href="#" class="mpLogToggle">' + (self.openLogs[d.id + '|' + s.id] ? 'hide log' : 'log') + '</a></td>';
        var logTr = domConstruct.create('tr', { style: self.openLogs[d.id + '|' + s.id] ? '' : 'display:none' }, tbl);
        var td = domConstruct.create('td', { colspan: 6 }, logTr);
        var pre = domConstruct.create('pre', { 'class': 'mpStepLog', innerHTML: 'loading...' }, td);
        var load = function () {
          self.page.api('GET', '/api/jobs/' + encodeURIComponent(d.id) + '/log?step=' + encodeURIComponent(s.id)).then(function (r) {
            pre.textContent = r.log || '(empty)';
            pre.scrollTop = pre.scrollHeight;
          }, function (err) { pre.textContent = err.error || String(err); });
        };
        if (self.openLogs[d.id + '|' + s.id]) { load(); }
        on(tr.querySelector('a.mpLogToggle'), 'click', function (evt) {
          evt.preventDefault();
          var k = d.id + '|' + s.id;
          self.openLogs[k] = !self.openLogs[k];
          logTr.style.display = self.openLogs[k] ? '' : 'none';
          evt.target.innerHTML = self.openLogs[k] ? 'hide log' : 'log';
          if (self.openLogs[k]) { load(); }
        });
      });
      if (!steps.length) { domConstruct.create('div', { 'class': 'mpMuted', innerHTML: 'No steps reported yet.' }, n); }
    }
  });

  RunsView.chip = chip;
  return RunsView;
});
