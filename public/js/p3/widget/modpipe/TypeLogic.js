/*
 * modpipe type rules used by the graph editor for instant connection checks.
 *
 * Mirrors ModularService lib/modpipe/types.py (TypeSystem.is_a / connection) and template.resolve_output_type.
 * The server stays authoritative (POST /api/validate); ModularService tests/unit/test_compat_parity.py checks
 * that this file gives the same answer as Python for every module output/input pair.
 *
 * Written as UMD so it loads as a Dojo AMD module in the browser and with require() in Node (tests).
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ModpipeTypeLogic = factory();
  }
}(this, function () {

  function isA(sub, sup) {
    return sub === sup || (typeof sub === 'string' && sub.indexOf(sup + '.') === 0);
  }

  function ancestors(t) {
    var parts = String(t).split('.');
    var out = [];
    for (var i = parts.length; i > 0; i--) { out.push(parts.slice(0, i).join('.')); }
    return out;
  }

  function isAbstract(cat, t) {
    return !!(cat.types[t] && cat.types[t].abstract);
  }

  function convertersBetween(cat, src, dst) {
    return (cat.converters || []).filter(function (c) { return isA(src, c.from) && isA(c.to, dst); });
  }

  /* "yes" | "maybe" | "convert" | "no"  (see types.py TypeSystem.connection) */
  function connection(cat, src, dst, derived) {
    if (isA(src, dst)) { return 'yes'; }
    if (isA(dst, src) && (derived || isAbstract(cat, src))) { return 'maybe'; }
    if (convertersBetween(cat, src, dst).some(function (c) { return c.status === 'available'; })) { return 'convert'; }
    return 'no';
  }

  /* Concrete output type given the types bound to the module's inputs (template.resolve_output_type).
     Returns null when type_from cannot map the input type. */
  function resolveOutputType(port, inputTypes) {
    var tf = port.type_from;
    if (tf === undefined || tf === null) { return port.type; }
    var srcPort = typeof tf === 'string' ? tf : tf.port;
    var src = inputTypes[srcPort];
    if (!src) { return port.type; }
    if (typeof tf === 'object' && tf.map) {
      var anc = ancestors(src);
      for (var i = 0; i < anc.length; i++) {
        if (Object.prototype.hasOwnProperty.call(tf.map, anc[i])) { return tf.map[anc[i]]; }
      }
      return null;
    }
    return isA(src, port.type) ? src : null;
  }

  /* Concrete (usable as a pipeline input) types that are `t` or below it. */
  function concreteSubtypes(cat, t) {
    return Object.keys(cat.types).filter(function (x) {
      var d = cat.types[x];
      return isA(x, t) && !d.abstract && !d.registry_only;
    }).sort();
  }

  return {
    isA: isA,
    ancestors: ancestors,
    isAbstract: isAbstract,
    convertersBetween: convertersBetween,
    connection: connection,
    resolveOutputType: resolveOutputType,
    concreteSubtypes: concreteSubtypes
  };
}));
