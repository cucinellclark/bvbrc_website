/*
 * Typed editor for one module parameter (int/float/bool/string/enum/database), shared by the template form and
 * the graph editor's inspector. String parameters enforce the module's allowed `pattern`.
 *
 *   ParamEditor.create(spec, value, node, onChange) -> {widget, getValue(), isValid(), problem()}
 * `value` undefined shows the module default.
 */
define([
  'dojo/_base/array', 'dojo/on',
  'dijit/form/Select', 'dijit/form/ValidationTextBox', 'dijit/form/NumberTextBox', 'dijit/form/CheckBox'
], function (array, on, Select, ValidationTextBox, NumberTextBox, CheckBox) {

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function create(p, value, node, onChange) {
    var v = value !== undefined ? value : p['default'];
    var w;
    if (p.type === 'enum' || p.type === 'database') {
      var opts = p.type === 'enum'
        ? array.map(p['enum'] || [], function (x) { return { value: String(x), label: esc(x) }; })
        : array.map(p.choices || [], function (c) {
          return { value: c.value, label: esc(c.value + (c.status === 'unverified' ? ' (unverified)' : '')) };
        });
      w = new Select({ options: opts, style: 'width:95%', maxHeight: 300 });
      if (v !== undefined && v !== null) { w.set('value', String(v), false); }
    } else if (p.type === 'bool') {
      w = new CheckBox({ checked: !!v });
    } else if (p.type === 'int' || p.type === 'float') {
      var c = { places: p.type === 'int' ? 0 : '0,6' };
      if (p.min !== undefined && p.min !== null) { c.min = p.min; }
      if (p.max !== undefined && p.max !== null) { c.max = p.max; }
      w = new NumberTextBox({ value: v, constraints: c, required: p.required !== false && v !== null,
        style: 'width:50%', intermediateChanges: true });
    } else {
      w = new ValidationTextBox({ value: v || '', regExp: p.pattern || '.*', style: 'width:95%',
        invalidMessage: 'Allowed: ' + (p.pattern || 'any'), trim: true, intermediateChanges: true });
    }
    w.placeAt(node);
    w.startup();
    if (onChange) { on(w, 'change', function () { onChange(); }); }

    var api = {
      widget: w,
      isValid: function () {
        if (p.type === 'int' || p.type === 'float') {
          var n = w.get('value');
          return !(n === undefined || n === null || isNaN(n)) && (!w.isValid || w.isValid());
        }
        if (p.type === 'string') { return !w.isValid || w.isValid(); }
        return true;
      },
      problem: function () {
        if (api.isValid()) { return null; }
        return (p.type === 'string' ? 'value not allowed (' + (p.pattern || '') + ')' : 'enter a number' +
          (p.min !== undefined ? ' >= ' + p.min : '') + (p.max !== undefined ? ' <= ' + p.max : ''));
      },
      getValue: function () {
        if (p.type === 'bool') { return !!w.get('checked'); }
        if (p.type === 'enum' && p['enum'] && typeof p['enum'][0] === 'number') { return Number(w.get('value')); }
        return w.get('value');
      }
    };
    return api;
  }

  return { create: create, esc: esc };
});
