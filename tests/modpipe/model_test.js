/*
 * Node tests for the graph editor's model and type rules (no browser, no deps).
 *   node tests/modpipe/model_test.js <fixture.json>
 * fixture = {catalog, templates: {name: pipeline}, pairs: [{src, dst, derived, expect}]}, written by
 * ModularService tests/unit/test_compat_parity.py (which runs this file).
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var base = path.join(__dirname, '..', '..', 'public', 'js', 'p3', 'widget', 'modpipe');
var T = require(path.join(base, 'TypeLogic.js'));
var PipelineModel = require(path.join(base, 'PipelineModel.js'));

var fx = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
var cat = fx.catalog;
var failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e.stack || e)); }
}

test('type rule parity with Python (' + fx.pairs.length + ' pairs)', function () {
  var bad = fx.pairs.filter(function (q) { return T.connection(cat, q.src, q.dst, q.derived) !== q.expect; });
  assert.deepStrictEqual(bad.slice(0, 5), [], bad.length + ' mismatches');
});

Object.keys(fx.templates).forEach(function (name) {
  var tp = fx.templates[name];
  test('template ' + name + ': load/toJSON round-trips', function () {
    var m = new PipelineModel(cat);
    m.load(tp);
    var want = JSON.parse(JSON.stringify(tp));
    if (!want.ui) { want.ui = undefined; }
    var got = m.toJSON();
    delete want.ui; var gotUi = got.ui; delete got.ui;
    assert.deepStrictEqual(got, want);
    if (tp.ui) { assert.deepStrictEqual(Object.keys(gotUi).sort(), Object.keys(tp.ui).concat(['positions']).filter(function (k, i, a) { return a.indexOf(k) === i; }).sort()); }
  });
  test('template ' + name + ': the editor accepts every existing edge', function () {
    var m = new PipelineModel(cat);
    m.load(tp);
    m.edges().forEach(function (e) {
      m.disconnect(e.toStep, e.toPort, e.from);
      var c = m.canConnect(e.from, e.toStep, e.toPort);
      assert.notStrictEqual(c.status, 'no', e.from + ' -> ' + e.toStep + '.' + e.toPort + ': ' + c.reason);
      m.connect(e.from, e.toStep, e.toPort);
    });
  });
  test('template ' + name + ': layout places every node', function () {
    var m = new PipelineModel(cat);
    m.load(tp);
    var pos = PipelineModel.layout(m, function () { return { w: 200, h: 80 }; });
    assert.strictEqual(Object.keys(pos).length, Object.keys(tp.inputs || {}).length + Object.keys(tp.steps).length);
  });
});

test('build fastp -> spades -> quast from scratch, with checks', function () {
  var m = new PipelineModel(cat);
  m.addInput('reads', 'reads.short.paired', true);
  var trim = m.addStep('fastp');
  assert.strictEqual(m.connect('$inputs.reads', trim, 'reads').status, 'yes');
  var asm = m.addStepAfter('spades', trim + '.trimmed_reads');
  assert.strictEqual(m.p.steps[asm].in.reads, 'fastp.trimmed_reads');
  // the derived type resolves through type_from: paired in -> paired out
  assert.strictEqual(m.types()['fastp.trimmed_reads'].type, 'reads.short.paired');
  assert.strictEqual(m.types()['fastp.trimmed_reads'].collection, 'reads');
  var qc = m.addStepAfter('quast', asm + '.contigs');
  assert.strictEqual(m.canConnect('fastp.report_html', qc, 'contigs').status, 'no');           // html is not contigs
  assert.strictEqual(m.canConnect(qc + '.report', trim, 'reads').status, 'no');                // cycle / type
  assert.ok(/cycle/.test(m.canConnect(asm + '.contigs', trim, 'reads').reason) || m.canConnect(asm + '.contigs', trim, 'reads').status === 'no');
  assert.throws(function () { m.connect(trim + '.report_html', asm, 'reads'); });
  m.setOutput(asm + '.contigs', 'contigs');
  m.renameStep(asm, 'assemble');
  assert.deepStrictEqual(m.p.steps[qc].in.contigs, ['assemble.contigs']);     // quast gathers (cardinality many)
  assert.strictEqual(m.p.outputs.contigs, 'assemble.contigs');
  m.removeStep('assemble');
  assert.strictEqual(m.p.steps[qc].in.contigs, undefined);
  assert.deepStrictEqual(m.p.outputs, {});
  m.undo();
  assert.deepStrictEqual(m.p.steps[qc].in.contigs, ['assemble.contigs']);
  m.redo();
  assert.ok(!m.p.steps.assemble);
});

test('converter suggestion: reads into a FASTA port', function () {
  var m = new PipelineModel(cat);
  m.addInput('reads', 'reads.short.paired', false);
  var s = m.addStep('mafft');
  var c = m.canConnect('$inputs.reads', s, 'sequences');
  assert.strictEqual(c.status, 'convert', c.reason);
});

test('many-port fan-in and single-port replacement', function () {
  var m = new PipelineModel(cat);
  m.addInput('a', 'reads.short.paired', false);
  m.addInput('b', 'reads.short.paired', false);
  var f1 = m.addStep('fastp'); var f2 = m.addStep('fastp');
  m.connect('$inputs.a', f1, 'reads');
  assert.strictEqual(m.canConnect('$inputs.b', f1, 'reads').replaces, '$inputs.a');
  m.connect('$inputs.b', f2, 'reads');
  var mq = m.addStep('multiqc');
  m.connect(f1 + '.report_json', mq, 'reports');
  m.connect(f2 + '.report_json', mq, 'reports');
  assert.deepStrictEqual(m.p.steps[mq].in.reports, [f1 + '.report_json', f2 + '.report_json']);
  m.disconnect(mq, 'reports', f1 + '.report_json');
  assert.deepStrictEqual(m.p.steps[mq].in.reports, [f2 + '.report_json']);
});

test('param edits coalesce into one undo step; links copy values', function () {
  var m = new PipelineModel(cat);
  var k = m.addStep('kraken2'); var b = m.addStep('bracken');
  m.p.ui.links = {}; m.p.ui.links[b + '.params.db'] = k + '.params.db';
  var n = m.undoStack.length;
  m.setParam(k, 'db', 'x1'); m.setParam(k, 'db', 'x2');
  assert.strictEqual(m.undoStack.length, n + 1);
  assert.strictEqual(m.p.steps[b].params.db, 'x2');
});

test('refused edits change nothing', function () {
  var m = new PipelineModel(cat);
  var s = m.addStep('fastp');
  var before = JSON.stringify(m.p);
  assert.throws(function () { m.renameStep(s, '1bad'); });
  assert.throws(function () { m.addInput('x', 'reads', false); });     // abstract
  assert.strictEqual(JSON.stringify(m.p), before);
});

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
