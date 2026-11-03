/*
 * Graph-editor model for a modpipe/pipeline/v1 document.
 *
 * The pipeline JSON is the single source of truth (Form/Graph/JSON views all read it). Editor-only state lives in
 * pipeline.ui: positions {"in:<name>"|"step:<id>": {x, y}}, disabled [optional steps switched off], optional
 * {<step>: {label, default, bypass}}, links {"<step>.params.<id>": "<step>.params.<id>"}. The engine accepts and
 * applies `ui` (ModularService pipeline.apply_ui), so saved pipelines keep their layout.
 *
 * Every edit goes through a method here: it is checked, applied, recorded for undo, and listeners are notified.
 * No DOM or Dojo dependencies (UMD), so it is unit-tested in Node (tests/modpipe/model_test.js).
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['./TypeLogic'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./TypeLogic'));
  } else {
    root.ModpipePipelineModel = factory(root.ModpipeTypeLogic);
  }
}(this, function (T) {

  var NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
  var SCHEMA = 'modpipe/pipeline/v1';

  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function refList(v) { return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]); }
  function refStep(ref) { return ref.indexOf('$inputs.') === 0 ? null : ref.split('.')[0]; }

  function emptyPipeline() {
    return { schema: SCHEMA, name: 'My pipeline', description: '', inputs: {}, steps: {}, outputs: {}, ui: { positions: {} } };
  }

  function PipelineModel(catalog) {
    this.cat = catalog;
    this.p = emptyPipeline();
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = [];
    this.server = null;        // last /api/validate result for the current revision (resolved types, issues)
    this.revision = 0;
    this._coalesce = null;
  }

  PipelineModel.NAME_RE = NAME_RE;
  PipelineModel.emptyPipeline = emptyPipeline;

  PipelineModel.prototype = {

    // ---------------------------------------------------------------- state, undo, events

    onChange: function (fn) { this.listeners.push(fn); },

    _emit: function (what) {
      this.revision++;
      this.server = null;
      for (var i = 0; i < this.listeners.length; i++) { this.listeners[i](what); }
    },

    /* Apply `fn` as one undoable edit. Consecutive edits with the same coalesce key (typing in a field, dragging)
       collapse into one undo step. `fn` may throw an Error to refuse the edit (nothing changes). */
    _edit: function (label, fn, coalesceKey) {
      var before = JSON.stringify(this.p);
      try {
        fn.call(this);
      } catch (e) {
        this.p = JSON.parse(before);
        throw e;
      }
      if (JSON.stringify(this.p) === before) { return; }
      if (!(coalesceKey && this._coalesce === coalesceKey)) {
        this.undoStack.push(before);
        if (this.undoStack.length > 200) { this.undoStack.shift(); }
      }
      this._coalesce = coalesceKey || null;
      this.redoStack = [];
      this._emit(label);
    },

    endCoalesce: function () { this._coalesce = null; },
    canUndo: function () { return this.undoStack.length > 0; },
    canRedo: function () { return this.redoStack.length > 0; },

    undo: function () {
      if (!this.undoStack.length) { return; }
      this.redoStack.push(JSON.stringify(this.p));
      this.p = JSON.parse(this.undoStack.pop());
      this._coalesce = null;
      this._emit('undo');
    },

    redo: function () {
      if (!this.redoStack.length) { return; }
      this.undoStack.push(JSON.stringify(this.p));
      this.p = JSON.parse(this.redoStack.pop());
      this._coalesce = null;
      this._emit('redo');
    },

    /* Replace the whole document (template load, JSON tab, open from workspace). Undoable. */
    load: function (pipeline) {
      if (!pipeline || typeof pipeline !== 'object') { throw new Error('pipeline must be a JSON object'); }
      var p = clone(pipeline);
      p.schema = p.schema || SCHEMA;
      p.inputs = p.inputs || {};
      p.steps = p.steps || {};
      p.outputs = p.outputs || {};
      p.ui = p.ui || {};
      p.ui.positions = p.ui.positions || {};
      this._edit('load', function () { this.p = p; });
    },

    reset: function () { this.load(emptyPipeline()); },

    toJSON: function () {
      var p = clone(this.p);
      if (p.ui) {
        if (p.ui.disabled && !p.ui.disabled.length) { delete p.ui.disabled; }
        if (!Object.keys(p.ui).length) { delete p.ui; }
      }
      return p;
    },

    // ---------------------------------------------------------------- lookups

    module: function (sid) {
      var s = this.p.steps[sid];
      return s ? this.cat.modules[s.module] : null;
    },

    port: function (mod, dir, pid) {
      var list = dir === 'in' ? mod.inputs : mod.outputs;
      for (var i = 0; i < list.length; i++) { if (list[i].id === pid) { return list[i]; } }
      return null;
    },

    isDisabled: function (sid) { return (this.p.ui.disabled || []).indexOf(sid) >= 0; },

    uniqueStepId: function (base) {
      base = String(base || 'step').replace(/[^A-Za-z0-9_-]/g, '_');
      if (!/^[A-Za-z]/.test(base)) { base = 's_' + base; }
      base = base.slice(0, 56);
      var id = base;
      var n = 2;
      while (this.p.steps[id] || this.p.inputs[id]) { id = base + '_' + (n++); }
      return id;
    },

    uniqueName: function (obj, base) {
      base = String(base || 'x').replace(/[^A-Za-z0-9_-]/g, '_');
      if (!/^[A-Za-z]/.test(base)) { base = 'x_' + base; }
      base = base.slice(0, 56);
      var id = base;
      var n = 2;
      while (obj[id]) { id = base + '_' + (n++); }
      return id;
    },

    /* Edges: [{from: ref, toStep, toPort, index}] (index within a list port). */
    edges: function () {
      var out = [];
      var steps = this.p.steps;
      Object.keys(steps).forEach(function (sid) {
        var ins = steps[sid].in || {};
        Object.keys(ins).forEach(function (port) {
          refList(ins[port]).forEach(function (ref, i) {
            out.push({ from: ref, toStep: sid, toPort: port, index: i });
          });
        });
      });
      return out;
    },

    /* Steps that `sid` depends on, transitively. */
    upstream: function (sid) {
      var seen = {};
      var stack = [sid];
      var steps = this.p.steps;
      while (stack.length) {
        var s = stack.pop();
        var ins = (steps[s] && steps[s].in) || {};
        Object.keys(ins).forEach(function (port) {
          refList(ins[port]).forEach(function (ref) {
            var u = refStep(ref);
            if (u && !seen[u] && steps[u]) { seen[u] = true; stack.push(u); }
          });
        });
      }
      return seen;
    },

    /* Topological order (cycles, which the editor refuses to create, are appended at the end). */
    order: function () {
      var steps = this.p.steps;
      var deps = {};
      Object.keys(steps).forEach(function (sid) {
        deps[sid] = {};
        var ins = steps[sid].in || {};
        Object.keys(ins).forEach(function (port) {
          refList(ins[port]).forEach(function (ref) {
            var u = refStep(ref);
            if (u && steps[u] && u !== sid) { deps[sid][u] = true; }
          });
        });
      });
      var order = [];
      var done = {};
      var progress = true;
      while (progress) {
        progress = false;
        Object.keys(steps).sort().forEach(function (sid) {
          if (done[sid]) { return; }
          if (Object.keys(deps[sid]).every(function (u) { return done[u]; })) {
            order.push(sid); done[sid] = true; progress = true;
          }
        });
      }
      Object.keys(steps).forEach(function (sid) { if (!done[sid]) { order.push(sid); } });
      return order;
    },

    /* Best-known type of every reference: server-resolved when the last validation matches this revision,
       else computed here with type_from from the upstream types. {ref: {type, derived, collection}} */
    types: function () {
      var out = {};
      var self = this;
      var cat = this.cat;
      Object.keys(this.p.inputs).forEach(function (name) {
        var d = self.p.inputs[name];
        out['$inputs.' + name] = { type: d.type, derived: false, collection: d.collection ? name : null };
      });
      var srv = this.server && this.server.steps;
      this.order().forEach(function (sid) {
        var st = self.p.steps[sid];
        var mod = cat.modules[st.module];
        if (!mod) { return; }
        var inTypes = {};
        var scatter = null;
        mod.inputs.forEach(function (port) {
          var refs = refList((st.in || {})[port.id]);
          if (refs.length && out[refs[0]]) { inTypes[port.id] = out[refs[0]].type; }
          refs.forEach(function (r) {
            if (out[r] && out[r].collection && port.cardinality !== 'many') { scatter = scatter || out[r].collection; }
          });
        });
        mod.outputs.forEach(function (port) {
          var known = srv && srv[sid] && srv[sid].output_types && srv[sid].output_types[port.id];
          if (known) {
            out[sid + '.' + port.id] = { type: known.type, derived: false, collection: known.collection };
            return;
          }
          var hasType = port.type_from !== undefined && port.type_from !== null;
          var rt = T.resolveOutputType(port, inTypes);
          var srcPort = hasType ? (typeof port.type_from === 'string' ? port.type_from : port.type_from.port) : null;
          out[sid + '.' + port.id] = {
            type: rt || port.type,
            derived: hasType && !inTypes[srcPort],      // still depends on what gets connected upstream
            collection: scatter
          };
        });
      });
      return out;
    },

    /* Can `fromRef` (an output) feed step `toStep` input `toPort`?
       {status: yes|maybe|convert|no, reason, replaces: ref|null} */
    canConnect: function (fromRef, toStep, toPort) {
      var st = this.p.steps[toStep];
      var mod = st && this.cat.modules[st.module];
      if (!mod) { return { status: 'no', reason: 'unknown step' }; }
      var port = this.port(mod, 'in', toPort);
      if (!port) { return { status: 'no', reason: 'unknown input port' }; }
      var from = refStep(fromRef);
      if (from === toStep) { return { status: 'no', reason: 'a step cannot consume its own output' }; }
      if (from && this.upstream(from)[toStep]) {
        return { status: 'no', reason: 'would create a cycle (' + toStep + ' runs before ' + from + ')' };
      }
      var existing = refList((st.in || {})[toPort]);
      if (existing.indexOf(fromRef) >= 0) { return { status: 'no', reason: 'already connected' }; }
      var t = this.types()[fromRef];
      if (!t) { return { status: 'no', reason: 'unknown source ' + fromRef }; }
      var c = T.connection(this.cat, t.type, port.type, t.derived);
      var reason;
      if (c === 'yes') {
        reason = t.type + ' fits ' + port.type;
      } else if (c === 'maybe') {
        reason = t.type + ' may fit ' + port.type + ' depending on the actual input; the check below decides';
      } else if (c === 'convert') {
        var conv = T.convertersBetween(this.cat, t.type, port.type).filter(function (x) { return x.status === 'available'; });
        reason = t.type + ' -> ' + port.type + ' via ' + conv.map(function (x) { return x.module; }).join(', ') + ' (inserted automatically)';
      } else {
        reason = t.type + ' cannot feed ' + port.type;
      }
      var many = port.cardinality === 'many';
      return { status: c, reason: reason, replaces: (!many && existing.length) ? existing[0] : null };
    },

    // ---------------------------------------------------------------- edits

    setMeta: function (key, value) {
      if (key !== 'name' && key !== 'description') { throw new Error('bad key'); }
      this._edit('meta', function () { this.p[key] = value; }, 'meta.' + key);
    },

    addStep: function (moduleId, pos, id) {
      var mod = this.cat.modules[moduleId];
      if (!mod) { throw new Error('unknown module ' + moduleId); }
      var sid = id || this.uniqueStepId(moduleId);
      this._edit('addStep', function () {
        this.p.steps[sid] = { module: moduleId, in: {} };
        if (pos) { this.p.ui.positions['step:' + sid] = { x: Math.round(pos.x), y: Math.round(pos.y) }; }
      });
      return sid;
    },

    /* Add a step and wire `fromRef` into its first input that accepts it. Returns the step id. */
    addStepAfter: function (moduleId, fromRef, pos) {
      var mod = this.cat.modules[moduleId];
      var self = this;
      var sid = this.uniqueStepId(moduleId);
      this._edit('addStepAfter', function () {
        this.p.steps[sid] = { module: moduleId, in: {} };
        if (pos) { this.p.ui.positions['step:' + sid] = { x: Math.round(pos.x), y: Math.round(pos.y) }; }
        var rank = { yes: 0, convert: 1, maybe: 2 };
        var best = null;
        mod.inputs.forEach(function (port) {
          var c = self.canConnect(fromRef, sid, port.id);
          if (c.status in rank && (!best || rank[c.status] < rank[best.c.status])) { best = { port: port, c: c }; }
        });
        if (!best) { throw new Error(moduleId + ' has no input that accepts ' + fromRef); }
        this._connect(fromRef, sid, best.port.id);
      });
      return sid;
    },

    removeStep: function (sid) {
      if (!this.p.steps[sid]) { return; }
      this._edit('removeStep', function () {
        delete this.p.steps[sid];
        this._dropRefs(function (ref) { return refStep(ref) === sid; });
        delete this.p.ui.positions['step:' + sid];
        if (this.p.ui.disabled) { this.p.ui.disabled = this.p.ui.disabled.filter(function (s) { return s !== sid; }); }
        if (this.p.ui.optional) { delete this.p.ui.optional[sid]; }
        this._dropLinks(sid);
      });
    },

    renameStep: function (oldId, newId) {
      if (oldId === newId) { return; }
      if (!NAME_RE.test(newId)) { throw new Error('step ids: a letter, then letters, digits, _ or - (max 64)'); }
      if (this.p.steps[newId]) { throw new Error('a step named ' + newId + ' already exists'); }
      this._edit('renameStep', function () {
        var steps = {};
        var self = this;
        Object.keys(this.p.steps).forEach(function (k) { steps[k === oldId ? newId : k] = self.p.steps[k]; });
        this.p.steps = steps;
        this._mapRefs(function (ref) { return refStep(ref) === oldId ? newId + ref.slice(oldId.length) : ref; });
        var pos = this.p.ui.positions;
        if (pos['step:' + oldId]) { pos['step:' + newId] = pos['step:' + oldId]; delete pos['step:' + oldId]; }
        if (this.p.ui.disabled) { this.p.ui.disabled = this.p.ui.disabled.map(function (s) { return s === oldId ? newId : s; }); }
        if (this.p.ui.optional && this.p.ui.optional[oldId]) {
          this.p.ui.optional[newId] = this.p.ui.optional[oldId];
          delete this.p.ui.optional[oldId];
        }
        var opt = this.p.ui.optional || {};
        Object.keys(opt).forEach(function (s) {
          var b = opt[s].bypass || {};
          Object.keys(b).forEach(function (k) { if (refStep(b[k]) === oldId) { b[k] = newId + b[k].slice(oldId.length); } });
        });
        if (this.p.ui.links) {
          var links = {};
          var ren = function (k) { return k.split('.')[0] === oldId ? newId + k.slice(oldId.length) : k; };
          Object.keys(this.p.ui.links).forEach(function (t) { links[ren(t)] = ren(self.p.ui.links[t]); });
          this.p.ui.links = links;
        }
      });
    },

    addInput: function (name, type, collection, pos) {
      if (!NAME_RE.test(name)) { throw new Error('input names: a letter, then letters, digits, _ or - (max 64)'); }
      if (this.p.inputs[name]) { throw new Error('an input named ' + name + ' already exists'); }
      var td = this.cat.types[type];
      if (!td) { throw new Error('unknown type ' + type); }
      if (td.abstract) { throw new Error(type + ' is abstract; choose a concrete type'); }
      this._edit('addInput', function () { this._addInput(name, type, collection, pos); });
      return name;
    },

    _addInput: function (name, type, collection, pos) {
      this.p.inputs[name] = { type: type, source: {} };
      if (collection) { this.p.inputs[name].collection = true; }
      if (pos) { this.p.ui.positions['in:' + name] = { x: Math.round(pos.x), y: Math.round(pos.y) }; }
    },

    /* Create a pipeline input for an unconnected step input and connect it. */
    addInputFor: function (sid, portId, type, collection) {
      var name = this.uniqueName(this.p.inputs, portId);
      var pos = this.p.ui.positions['step:' + sid];
      var td = this.cat.types[type];
      if (!td || td.abstract) { throw new Error('choose a concrete type for the new input'); }
      this._edit('addInputFor', function () {
        this._addInput(name, type, collection, pos ? { x: pos.x - 300, y: pos.y } : null);
        this._connect('$inputs.' + name, sid, portId);
      });
      return name;
    },

    updateInput: function (name, changes) {
      var d = this.p.inputs[name];
      if (!d) { return; }
      if (changes.type !== undefined) {
        var td = this.cat.types[changes.type];
        if (!td || td.abstract) { throw new Error('choose a concrete type'); }
      }
      this._edit('updateInput', function () {
        if (changes.type !== undefined) { d.type = changes.type; }
        if (changes.collection !== undefined) {
          if (changes.collection) { d.collection = true; } else { delete d.collection; }
        }
        if (changes.source !== undefined) { d.source = changes.source; }
        if (changes.description !== undefined) { d.description = changes.description; }
      }, changes.source !== undefined ? 'source.' + name : null);
    },

    renameInput: function (oldName, newName) {
      if (oldName === newName) { return; }
      if (!NAME_RE.test(newName)) { throw new Error('input names: a letter, then letters, digits, _ or - (max 64)'); }
      if (this.p.inputs[newName]) { throw new Error('an input named ' + newName + ' already exists'); }
      this._edit('renameInput', function () {
        var inputs = {};
        var self = this;
        Object.keys(this.p.inputs).forEach(function (k) { inputs[k === oldName ? newName : k] = self.p.inputs[k]; });
        this.p.inputs = inputs;
        this._mapRefs(function (ref) { return ref === '$inputs.' + oldName ? '$inputs.' + newName : ref; });
        var pos = this.p.ui.positions;
        if (pos['in:' + oldName]) { pos['in:' + newName] = pos['in:' + oldName]; delete pos['in:' + oldName]; }
      });
    },

    removeInput: function (name) {
      if (!this.p.inputs[name]) { return; }
      this._edit('removeInput', function () {
        delete this.p.inputs[name];
        this._dropRefs(function (ref) { return ref === '$inputs.' + name; });
        delete this.p.ui.positions['in:' + name];
      });
    },

    connect: function (fromRef, toStep, toPort) {
      var c = this.canConnect(fromRef, toStep, toPort);
      if (c.status === 'no') { throw new Error(c.reason); }
      this._edit('connect', function () { this._connect(fromRef, toStep, toPort); });
      return c;
    },

    _connect: function (fromRef, toStep, toPort) {
      var st = this.p.steps[toStep];
      var port = this.port(this.cat.modules[st.module], 'in', toPort);
      st.in = st.in || {};
      if (port.cardinality === 'many') {
        var cur = refList(st.in[toPort]);
        if (cur.indexOf(fromRef) < 0) { cur.push(fromRef); }
        st.in[toPort] = cur;
      } else {
        st.in[toPort] = fromRef;
      }
    },

    disconnect: function (toStep, toPort, fromRef) {
      var st = this.p.steps[toStep];
      if (!st || !st.in || st.in[toPort] === undefined) { return; }
      this._edit('disconnect', function () {
        var v = st.in[toPort];
        if (Array.isArray(v)) {
          var kept = v.filter(function (r) { return r !== fromRef; });
          if (kept.length) { st.in[toPort] = kept; } else { delete st.in[toPort]; }
        } else if (fromRef === undefined || v === fromRef) {
          delete st.in[toPort];
        }
      });
    },

    /* value === undefined clears the parameter (module default applies). Template links copy the value on. */
    setParam: function (sid, pid, value) {
      var st = this.p.steps[sid];
      if (!st) { return; }
      var links = this.p.ui.links || {};
      var self = this;
      this._edit('setParam', function () {
        var apply = function (s, k) {
          if (!self.p.steps[s]) { return; }
          var ps = self.p.steps[s].params || {};
          if (value === undefined) { delete ps[k]; } else { ps[k] = value; }
          if (Object.keys(ps).length) { self.p.steps[s].params = ps; } else { delete self.p.steps[s].params; }
        };
        apply(sid, pid);
        Object.keys(links).forEach(function (target) {
          if (links[target] === sid + '.params.' + pid) {
            var t = target.split('.');
            apply(t[0], t[2]);
          }
        });
      }, 'param.' + sid + '.' + pid);
    },

    setDisabled: function (sid, disabled) {
      this._edit('setDisabled', function () {
        var d = (this.p.ui.disabled || []).filter(function (s) { return s !== sid; });
        if (disabled) { d.push(sid); }
        this.p.ui.disabled = d;
      });
    },

    /* Mark an output port as a pipeline output (saved to the workspace) under `name`; name null = unmark. */
    setOutput: function (ref, name) {
      var outs = this.p.outputs;
      var self = this;
      if (name !== null && name !== undefined && !NAME_RE.test(name)) {
        throw new Error('output names: a letter, then letters, digits, _ or - (max 64)');
      }
      this._edit('setOutput', function () {
        Object.keys(outs).forEach(function (k) { if (outs[k] === ref) { delete outs[k]; } });
        if (name) {
          if (outs[name] && outs[name] !== ref) { throw new Error('another output is already named ' + name); }
          outs[name] = ref;
        }
        self.p.outputs = outs;
      }, null);
    },

    outputNameFor: function (ref) {
      var outs = this.p.outputs;
      var names = Object.keys(outs).filter(function (k) { return outs[k] === ref; });
      return names.length ? names[0] : null;
    },

    setPosition: function (key, x, y, coalesceKey) {
      this._edit('move', function () {
        this.p.ui.positions[key] = { x: Math.round(x), y: Math.round(y) };
      }, coalesceKey || ('move.' + key));
    },

    setPositions: function (positions) {
      this._edit('layout', function () {
        var self = this;
        Object.keys(positions).forEach(function (k) {
          self.p.ui.positions[k] = { x: Math.round(positions[k].x), y: Math.round(positions[k].y) };
        });
      });
    },

    /* Make an automatically inserted converter (from the server's validated pipeline) a normal step. */
    makeExplicit: function (autoStep, serverPipeline) {
      var st = serverPipeline.steps[autoStep];
      if (!st) { throw new Error('unknown converter step'); }
      var origRef = refList(st.in[Object.keys(st.in)[0]])[0];
      var self = this;
      var sid = this.uniqueStepId(autoStep);
      this._edit('makeExplicit', function () {
        self.p.steps[sid] = { module: st.module, in: clone(st.in) };
        Object.keys(serverPipeline.steps).forEach(function (cs) {
          if (!self.p.steps[cs] || cs === sid) { return; }
          var ins = serverPipeline.steps[cs].in || {};
          Object.keys(ins).forEach(function (port) {
            refList(ins[port]).forEach(function (r) {
              if (refStep(r) !== autoStep) { return; }
              var newRef = sid + r.slice(autoStep.length);
              var cur = self.p.steps[cs].in[port];
              if (Array.isArray(cur)) {
                self.p.steps[cs].in[port] = cur.map(function (x) { return x === origRef ? newRef : x; });
              } else if (cur === origRef) {
                self.p.steps[cs].in[port] = newRef;
              }
            });
          });
        });
      });
      return sid;
    },

    // ---------------------------------------------------------------- helpers

    _mapRefs: function (fn) {
      var steps = this.p.steps;
      Object.keys(steps).forEach(function (sid) {
        var ins = steps[sid].in || {};
        Object.keys(ins).forEach(function (port) {
          ins[port] = Array.isArray(ins[port]) ? ins[port].map(fn) : fn(ins[port]);
        });
      });
      var outs = this.p.outputs;
      Object.keys(outs).forEach(function (k) { outs[k] = fn(outs[k]); });
    },

    _dropRefs: function (gone) {
      var steps = this.p.steps;
      Object.keys(steps).forEach(function (sid) {
        var ins = steps[sid].in || {};
        Object.keys(ins).forEach(function (port) {
          if (Array.isArray(ins[port])) {
            var kept = ins[port].filter(function (r) { return !gone(r); });
            if (kept.length) { ins[port] = kept; } else { delete ins[port]; }
          } else if (gone(ins[port])) {
            delete ins[port];
          }
        });
      });
      var outs = this.p.outputs;
      Object.keys(outs).forEach(function (k) { if (gone(outs[k])) { delete outs[k]; } });
      var opt = this.p.ui.optional || {};
      Object.keys(opt).forEach(function (s) {
        var b = opt[s].bypass || {};
        Object.keys(b).forEach(function (k) { if (gone(b[k])) { delete b[k]; } });
      });
    },

    _dropLinks: function (sid) {
      var links = this.p.ui.links;
      if (!links) { return; }
      Object.keys(links).forEach(function (t) {
        if (t.split('.')[0] === sid || links[t].split('.')[0] === sid) { delete links[t]; }
      });
    }
  };

  /* Left-to-right layered layout (longest-path layering + barycenter ordering). Returns {key: {x, y}}.
     `size(key)` -> {w, h}. Small graphs only (pipelines have tens of nodes). */
  PipelineModel.layout = function (model, size, opts) {
    opts = opts || {};
    var colGap = opts.colGap || 90;
    var rowGap = opts.rowGap || 30;
    var p = model.p;
    var nodes = Object.keys(p.inputs).map(function (n) { return 'in:' + n; })
      .concat(Object.keys(p.steps).map(function (s) { return 'step:' + s; }));
    var preds = {};
    nodes.forEach(function (k) { preds[k] = []; });
    model.edges().forEach(function (e) {
      var from = e.from.indexOf('$inputs.') === 0 ? 'in:' + e.from.slice(8) : 'step:' + refStep(e.from);
      var to = 'step:' + e.toStep;
      if (preds[to] && preds[from] && preds[to].indexOf(from) < 0) { preds[to].push(from); }
    });
    var layer = {};
    var visiting = {};
    var depth = function (k) {
      if (layer[k] !== undefined) { return layer[k]; }
      if (visiting[k]) { return 0; }
      visiting[k] = true;
      var d = 0;
      preds[k].forEach(function (u) { d = Math.max(d, depth(u) + 1); });
      layer[k] = d;
      return d;
    };
    nodes.forEach(depth);
    // pull inputs right next to their first consumer
    nodes.forEach(function (k) {
      if (k.indexOf('in:') !== 0) { return; }
      var cons = nodes.filter(function (s) { return preds[s].indexOf(k) >= 0; });
      if (cons.length) { layer[k] = Math.max(0, Math.min.apply(null, cons.map(function (s) { return layer[s]; })) - 1); }
    });
    var cols = [];
    nodes.forEach(function (k) { (cols[layer[k]] = cols[layer[k]] || []).push(k); });
    for (var c = 0; c < cols.length; c++) { cols[c] = cols[c] || []; }
    var idx = {};
    var setIdx = function () { cols.forEach(function (col) { col.forEach(function (k, i) { idx[k] = i; }); }); };
    setIdx();
    for (var sweep = 0; sweep < 4; sweep++) {
      for (c = 1; c < cols.length; c++) {
        cols[c].sort(function (a, b) {
          var bc = function (k) {
            var ps = preds[k].filter(function (u) { return layer[u] < layer[k]; });
            if (!ps.length) { return idx[k]; }
            return ps.reduce(function (s, u) { return s + idx[u]; }, 0) / ps.length;
          };
          return bc(a) - bc(b);
        });
        setIdx();
      }
    }
    var out = {};
    var x = 20;
    cols.forEach(function (col) {
      var w = 0;
      var y = 20;
      col.forEach(function (k) {
        var s = size(k);
        out[k] = { x: x, y: y };
        y += s.h + rowGap;
        w = Math.max(w, s.w);
      });
      x += w + colGap;
    });
    // vertically center each column against the tallest
    var heights = cols.map(function (col) {
      return col.reduce(function (h, k) { return h + size(k).h + rowGap; }, 0);
    });
    var maxH = Math.max.apply(null, heights.concat([0]));
    cols.forEach(function (col, i) {
      var off = (maxH - heights[i]) / 2;
      col.forEach(function (k) { out[k].y += off; });
    });
    return out;
  };

  return PipelineModel;
}));
