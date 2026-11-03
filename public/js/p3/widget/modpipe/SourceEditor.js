/*
 * Editors for a pipeline input's data source (one per source kind offered by the modpipe API:
 * paired/single-end reads from the workspace, SRA runs, genome/feature IDs, workspace files or groups,
 * pasted FASTA, bundled references). Shared by the template form and the graph editor's inspector.
 *
 *   SourceEditor.create({inp: {name, collection}, opt: {kind, label, wstypes, choices}, node, init, onChange})
 *     -> {getSource(), problems(), destroy()}
 * `init` (optional) is an existing source object to show; `onChange` fires on every edit.
 */
define([
  'dojo/_base/array', 'dojo/on', 'dojo/dom-construct',
  'dijit/form/Select', 'dijit/form/TextBox', 'dijit/form/ValidationTextBox', 'dijit/form/SimpleTextarea',
  'dijit/form/Button', 'dijit/registry', '../WorkspaceObjectSelector'
], function (
  array, on, domConstruct,
  Select, TextBox, ValidationTextBox, SimpleTextarea,
  Button, registry, WorkspaceObjectSelector
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

  /* Which offered kind an existing source object uses (first known key), or null. */
  function kindOf(source, options) {
    if (!source) { return null; }
    var kinds = array.map(options, function (o) { return o.kind; });
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) {
      if (kinds.indexOf(keys[i]) >= 0) { return keys[i]; }
      if (keys[i] === 'wsid' && kinds.indexOf('wsids') >= 0) { return 'wsids'; }
      if (keys[i] === 'wsids' && kinds.indexOf('wsid') >= 0) { return 'wsid'; }
    }
    return null;
  }

  function create(args) {
    var inp = args.inp;
    var opt = args.opt;
    var node = args.node;
    var init = args.init || {};
    var changed = args.onChange || function () {};
    var coll = inp.collection;
    var kind = opt.kind;
    var widgets = [];

    var track = function (w) {
      widgets.push(w);
      on(w, 'change', function () { changed(); });
      return w;
    };
    var wsSelector = function (parent, wstypes, placeholder, value) {
      var w = new WorkspaceObjectSelector({
        type: wstypes, multi: false, required: true, allowUpload: true,
        placeHolder: placeholder, promptMessage: placeholder, style: 'width:95%'
      });
      w.placeAt(parent);
      w.startup();
      if (value) { w.set('value', value); }
      return track(w);
    };
    var text = function (parent, placeholder, regExp, width, value) {
      var w = new ValidationTextBox({ placeHolder: placeholder, required: true, style: 'width:' + (width || '95%'),
        regExp: regExp || '.*', trim: true, intermediateChanges: true, value: value || '' });
      w.placeAt(parent);
      w.startup();
      return track(w);
    };
    var destroy = function () {
      array.forEach(registry.findWidgets(node), function (w) { w.destroyRecursive(); });
      domConstruct.empty(node);
    };

    if (kind === 'paired_end_libs' || kind === 'single_end_libs') {
      var paired = kind === 'paired_end_libs';
      var rows = [];
      var list = domConstruct.create('div', {}, node);
      var addRow = function (lib) {
        lib = lib || {};
        var r = domConstruct.create('div', { 'class': 'mpSourceRow' }, list);
        var rec = { node: r };
        if (coll) {
          rec.sample = text(r, 'Sample ID (letters, digits, . _ -)', '[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', '60%', lib.sample_id);
          domConstruct.create('br', {}, r);
        }
        rec.r1 = wsSelector(r, ['reads'], paired ? 'Read file 1' : 'Read file', paired ? lib.read1 : lib.read);
        if (paired) { rec.r2 = wsSelector(r, ['reads'], 'Read file 2', lib.read2); }
        if (coll && rows.length > 0) {
          var rm = new Button({ label: 'Remove', onClick: function () {
            rows.splice(rows.indexOf(rec), 1);
            array.forEach(registry.findWidgets(r), function (w) { w.destroyRecursive(); });
            domConstruct.destroy(r);
            changed();
          } });
          rm.placeAt(r);
        }
        rows.push(rec);
      };
      var initLibs = init[kind] || [];
      if (initLibs.length) { array.forEach(initLibs, addRow); } else { addRow(); }
      if (coll) {
        new Button({ label: '+ Add sample', onClick: function () { addRow(); changed(); } }).placeAt(node);
      }
      return {
        destroy: destroy,
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
      var tb = new TextBox({ placeHolder: ph + (coll || kind === 'feature_ids' ? ' (space or comma separated)' : ''),
        style: 'width:95%', intermediateChanges: true, value: (init[kind] || []).join(' ') });
      tb.placeAt(node);
      tb.startup();
      track(tb);
      return {
        destroy: destroy,
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
      var first = init[kind] || (kind === 'wsid' && init.wsids && init.wsids[0]) || '';
      var sel = wsSelector(node, opt.wstypes || ['unspecified'], opt.label, first);
      return {
        destroy: destroy,
        getSource: function () { var s = {}; s[kind] = sel.get('value'); return s; },
        problems: function () { return sel.get('value') ? [] : [inp.name + ': choose a workspace item']; }
      };
    }
    if (kind === 'wsids') {
      var sels = [];
      var box = domConstruct.create('div', {}, node);
      var add = function (v) { sels.push(wsSelector(box, opt.wstypes || ['unspecified'], opt.label, v)); };
      var initIds = init.wsids || (init.wsid ? [init.wsid] : []);
      if (initIds.length) { array.forEach(initIds, add); } else { add(); }
      new Button({ label: '+ Add file', onClick: function () { add(); changed(); } }).placeAt(node);
      return {
        destroy: destroy,
        getSource: function () { return { wsids: array.filter(array.map(sels, function (s) { return s.get('value'); }), function (v) { return !!v; }) }; },
        problems: function () { return this.getSource().wsids.length ? [] : [inp.name + ': choose at least one file']; }
      };
    }
    if (kind === 'fasta_data') {
      var ta = new SimpleTextarea({ rows: 6, style: 'width:95%;font-family:monospace;', placeHolder: '>seq1\nACGT...',
        intermediateChanges: true, value: init.fasta_data || '' });
      ta.placeAt(node);
      ta.startup();
      track(ta);
      return {
        destroy: destroy,
        getSource: function () { return { fasta_data: ta.get('value') }; },
        problems: function () { return /^\s*>/.test(ta.get('value') || '') ? [] : [inp.name + ': paste FASTA starting with >']; }
      };
    }
    if (kind === 'database_file') {
      var choices = opt.choices || [];
      var ds = new Select({ options: array.map(choices, function (c) { return { value: c.value, label: esc(c.label) }; }), style: 'width:95%' });
      ds.placeAt(node);
      ds.startup();
      var dv = init.database_file || (inp.default_source && inp.default_source.database_file);
      if (dv) { ds.set('value', dv, false); }
      track(ds);
      return {
        destroy: destroy,
        getSource: function () { return { database_file: ds.get('value') }; },
        problems: function () { return ds.get('value') ? [] : [inp.name + ': choose a reference']; }
      };
    }
    domConstruct.create('div', { innerHTML: 'Unsupported source ' + esc(kind) }, node);
    return { destroy: destroy, getSource: function () { return {}; }, problems: function () { return [inp.name + ': unsupported source']; } };
  }

  return { create: create, kindOf: kindOf, esc: esc };
});
