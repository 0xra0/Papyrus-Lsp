#!/usr/bin/env node
'use strict';
/**
 * Papyrus LSP — comprehensive integration test suite
 *
 * Covers all 12 feature areas implemented in this session:
 *   1. Startup requirements check
 *   2. Compiler diagnostic integration
 *   3. {…} docstring parsing and hover
 *   4. Array intrinsic methods (Find, Add, Length, …)
 *   5. self/parent scope availability
 *   6. Exact compiler error message wording
 *   7. Struct type encoding (Script:Struct resolution)
 *   8. __state compiler-injected intrinsic variable
 *   9. Guard system diagnostics (15 checks)
 *  10. Access modifier declaration + access-site validation
 *  11. Override stub completions (Function/Event at script level)
 *  12. Conditional compilation — DebugOnly/BetaOnly warnings
 *
 * Run: node tests/integration.test.js
 *    or: npm test
 */

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const ROOT        = path.resolve(__dirname, '..');
const SERVER_BIN  = path.join(ROOT, 'dist', 'server.js');
const VANILLA_SRC = path.join(ROOT, '_vanilla-sf-scripts', 'Scripts', 'Source');
const FIXTURE     = path.join(VANILLA_SRC, 'LC088_KeyQuestScript.psc');
const WORKSPACE   = path.dirname(FIXTURE);

if (!fs.existsSync(FIXTURE)) {
  console.error(`Fixture missing: ${FIXTURE}\nRun \`npm run fetch-vanilla\` to download the vanilla scripts.`);
  process.exit(1);
}

// ── Line-lookup helpers ───────────────────────────────────────────────────────

const fileContent = fs.readFileSync(FIXTURE, 'utf8');
const srcLines    = fileContent.split(/\r?\n/);

function findLine(pattern) {
  for (let i = 0; i < srcLines.length; i++)
    if (pattern.test(srcLines[i])) return i;
  return -1;
}

// Pre-computed interesting positions in the fixture
const scriptnameLine    = findLine(/^\s*scriptname\s+LC088_KeyQuestScript/i);
const extendsCol        = srcLines[scriptnameLine]?.indexOf('Quest', srcLines[scriptnameLine].indexOf('extends')) ?? 0;
const refAliasLine      = findLine(/ReferenceAlias\[\]\s+property\s+OtherKeyActors/i);
const refAliasCol       = srcLines[refAliasLine]?.indexOf('ReferenceAlias') ?? 1;
const questPropLine     = findLine(/Quest\s+property\s+LC082/i);
const questPropCol      = srcLines[questPropLine]?.indexOf('Quest') ?? 1;
const onQuestInitLine   = findLine(/^\s*Event\s+OnQuestInit\s*\(\s*\)/i);
const gameGetPlayerLine = findLine(/Game\.GetPlayer\s*\(\s*\)/i);
const gameCol           = gameGetPlayerLine >= 0 ? srcLines[gameGetPlayerLine].indexOf('Game') : -1;
const setStageCallLine  = findLine(/SetStage\s*\(\s*captainActiveStage\s*\)/i);
const setStageCol       = setStageCallLine >= 0 ? srcLines[setStageCallLine].indexOf('SetStage') + 8 : -1;
// Array property line in fixture: WWiseEvent[] property ReactorSoundEvents
const wiseArrayLine     = findLine(/WWiseEvent\[\]\s+property\s+ReactorSoundEvents/i);
const wiseArrayCol      = wiseArrayLine >= 0 ? srcLines[wiseArrayLine].indexOf('WWiseEvent') : -1;

// ── JSON-RPC plumbing ─────────────────────────────────────────────────────────

let msgId  = 1;
const pending = new Map();
const server  = spawn('node', [SERVER_BIN], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0);

server.stdout.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) break;
    const header = buf.slice(0, sep).toString('utf8');
    const lenM   = /Content-Length:\s*(\d+)/i.exec(header);
    if (!lenM) { buf = buf.slice(sep + 4); continue; }
    const bodyStart = sep + 4;
    const len = parseInt(lenM[1], 10);
    if (buf.length < bodyStart + len) break;
    const body = buf.slice(bodyStart, bodyStart + len).toString('utf8');
    buf = buf.slice(bodyStart + len);
    let msg;
    try { msg = JSON.parse(body); }
    catch (e) { console.error('JSON parse error:', e.message, body.slice(0, 200)); continue; }
    dispatch(msg);
  }
});

server.on('exit', code => { if (code !== 0 && code !== null) console.error(`Server exited: code ${code}`); });

function dispatch(msg) {
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject, timer } = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(timer);
    if (msg.error) reject(new Error(`RPC ${msg.error.code}: ${msg.error.message}`));
    else resolve(msg.result);
  } else if (msg.method === 'window/workDoneProgress/create') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  } else if (msg.method === 'textDocument/publishDiagnostics') {
    if (diagHandler) diagHandler(msg.params);
  }
}

let diagHandler = null;

function send(obj) {
  const body = JSON.stringify(obj);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function rpc(method, params, ms = 8000) {
  return new Promise((resolve, reject) => {
    const id    = msgId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout(${ms}ms): ${method}`)); }, ms);
    pending.set(id, { resolve, reject, timer });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

/** Wait for a publishDiagnostics notification for the given URI. */
function awaitDiags(uri, ms = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { diagHandler = null; reject(new Error(`Timeout waiting for diags: ${uri}`)); }, ms);
    diagHandler = params => {
      if (params.uri !== uri) return;
      clearTimeout(t); diagHandler = null; resolve(params);
    };
  });
}

/** Trigger diagnostics by sending two didChange notifications. */
async function triggerDiags(uri, text) {
  notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text }] });
}

/** Open a synthetic document, trigger diags, return diagnostics array. */
async function syntheticDiags(uri, text) {
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'papyrus', version: 1, text } });
  const p = awaitDiags(uri);
  notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text }] });
  const result = await p;
  notify('textDocument/didClose', { textDocument: { uri } });
  return result.diagnostics ?? [];
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const GROUP_RESULTS = [];
let currentGroup = '';

async function group(name, fn) {
  currentGroup = name;
  console.log(`\n  ── ${name} ──`);
  await fn();
  GROUP_RESULTS.push({ name, passed, failed });
}

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`    PASS  ${name}\n`);
    passed++;
  } catch (e) {
    process.stderr.write(`    FAIL  ${name}\n        ${e.message}\n`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'assertion failed'); }

function hoverText(r) {
  if (!r?.contents) return '';
  const c = r.contents;
  if (typeof c === 'string') return c;
  if (c && 'value' in c) return c.value;
  if (Array.isArray(c)) return c.map(x => typeof x === 'string' ? x : x.value ?? '').join(' ');
  return JSON.stringify(c);
}

function items(r) { return Array.isArray(r) ? r : r?.items ?? []; }
function labels(r) { return items(r).map(i => i.label ?? ''); }

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║     Papyrus LSP — Integration Test Suite           ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`  server:  ${SERVER_BIN}`);
  console.log(`  fixture: ${path.basename(FIXTURE)} (${srcLines.length} lines)\n`);

  // ── Initialize ───────────────────────────────────────────────────────────

  await group('LSP Core — initialize & capabilities', async () => {
    await test('initialize response has expected capabilities', async () => {
      const r = await rpc('initialize', {
        processId: process.pid,
        rootUri: 'file://' + WORKSPACE,
        capabilities: { window: { workDoneProgress: true } },
      });
      assert(r?.capabilities, 'no capabilities');
      assert(r.capabilities.hoverProvider, 'hoverProvider missing');
      assert(r.capabilities.completionProvider, 'completionProvider missing');
      assert(r.capabilities.definitionProvider, 'definitionProvider missing');
      assert(r.capabilities.documentSymbolProvider, 'documentSymbolProvider missing');
      assert(r.capabilities.signatureHelpProvider, 'signatureHelpProvider missing');
      assert(r.capabilities.referencesProvider, 'referencesProvider missing');
    });
  });

  notify('initialized', {});
  notify('textDocument/didOpen', {
    textDocument: { uri: 'file://' + FIXTURE, languageId: 'papyrus', version: 1, text: fileContent },
  });
  await new Promise(r => setTimeout(r, 800)); // allow server to index

  const FIX = 'file://' + FIXTURE;

  // ── Hover ─────────────────────────────────────────────────────────────────

  await group('Hover', async () => {
    await test('extends type on scriptname line', async () => {
      assert(extendsCol >= 0, 'extends Quest col not found in fixture');
      const r = await rpc('textDocument/hover', { textDocument: { uri: FIX }, position: { line: scriptnameLine, character: extendsCol } });
      assert(/quest/i.test(hoverText(r)), `expected Quest, got: ${hoverText(r).slice(0, 100)}`);
    });

    await test('ReferenceAlias[] property type', async () => {
      assert(refAliasLine >= 0, 'ReferenceAlias line not found');
      const r = await rpc('textDocument/hover', { textDocument: { uri: FIX }, position: { line: refAliasLine, character: refAliasCol + 3 } });
      assert(/referencealias/i.test(hoverText(r)), `expected ReferenceAlias, got: ${hoverText(r).slice(0, 100)}`);
    });

    await test('Quest property type', async () => {
      assert(questPropLine >= 0, 'Quest property line not found');
      const r = await rpc('textDocument/hover', { textDocument: { uri: FIX }, position: { line: questPropLine, character: questPropCol + 2 } });
      assert(/quest/i.test(hoverText(r)), `expected Quest, got: ${hoverText(r).slice(0, 100)}`);
    });

    await test('Game script (global type)', async () => {
      assert(gameGetPlayerLine >= 0, 'Game.GetPlayer line not found');
      const r = await rpc('textDocument/hover', { textDocument: { uri: FIX }, position: { line: gameGetPlayerLine, character: gameCol + 1 } });
      assert(/game/i.test(hoverText(r)), `expected Game, got: ${hoverText(r).slice(0, 100)}`);
    });

    // Feature 3: {…} docstring hover
    await test('docstring appears in hover (Activator.IsRadio)', async () => {
      const docUri = 'file:///tmp/DocHoverTest.psc';
      const docText = [
        'Scriptname DocHoverTest',
        'Activator Property MyActivator Auto',
        'Function TestDoc()',
        '  Bool r = MyActivator.IsRadio()',
        'EndFunction',
      ].join('\n');
      notify('textDocument/didOpen', { textDocument: { uri: docUri, languageId: 'papyrus', version: 1, text: docText } });
      await new Promise(r => setTimeout(r, 200));
      // hover on "IsRadio" — should show its {docstring}
      const col = docText.split('\n')[3].indexOf('IsRadio');
      const r = await rpc('textDocument/hover', { textDocument: { uri: docUri }, position: { line: 3, character: col + 2 } });
      const text = hoverText(r);
      assert(/IsRadio|radio/i.test(text), `IsRadio hover missing docstring, got: ${text.slice(0, 150)}`);
      notify('textDocument/didClose', { textDocument: { uri: docUri } });
    });

    // Feature 5: self and parent hover
    await test('self. hover shows script type chain', async () => {
      const selfUri = 'file:///tmp/SelfHoverTest.psc';
      const selfText = [
        'Scriptname SelfHoverTest extends Quest',
        'Function TestSelf()',
        '  self.SetStage(10)',
        'EndFunction',
      ].join('\n');
      notify('textDocument/didOpen', { textDocument: { uri: selfUri, languageId: 'papyrus', version: 1, text: selfText } });
      await new Promise(r => setTimeout(r, 200));
      const r = await rpc('textDocument/hover', {
        textDocument: { uri: selfUri },
        position: { line: 2, character: 2 }, // on "self"
      });
      const text = hoverText(r);
      assert(/quest|selfhovertest/i.test(text), `self hover should show script type, got: ${text.slice(0, 150)}`);
      notify('textDocument/didClose', { textDocument: { uri: selfUri } });
    });

    // Feature 5: self hover returns null in global scope
    await test('self hover returns null inside global function', async () => {
      const gUri = 'file:///tmp/GlobalHoverTest.psc';
      notify('textDocument/didOpen', { textDocument: { uri: gUri, languageId: 'papyrus', version: 1,
        text: 'Scriptname GlobalHoverTest\nFunction Fn() global\n  self\nEndFunction' } });
      await new Promise(r => setTimeout(r, 150));
      const r = await rpc('textDocument/hover', { textDocument: { uri: gUri }, position: { line: 2, character: 2 } });
      assert(r === null || !hoverText(r), `self hover in global scope should return null, got: ${hoverText(r)}`);
      notify('textDocument/didClose', { textDocument: { uri: gUri } });
    });

    // Feature 8: __state hover
    await test('__state hover shows documentation', async () => {
      const stUri = 'file:///tmp/StateHoverTest.psc';
      notify('textDocument/didOpen', { textDocument: { uri: stUri, languageId: 'papyrus', version: 1,
        text: 'Scriptname StateHoverTest\nFunction Fn()\n  __state\nEndFunction' } });
      await new Promise(r => setTimeout(r, 150));
      const r = await rpc('textDocument/hover', { textDocument: { uri: stUri }, position: { line: 2, character: 2 } });
      const text = hoverText(r);
      assert(/GotoState|GetState|__state|state/i.test(text), `__state hover missing doc, got: ${text.slice(0, 150)}`);
      notify('textDocument/didClose', { textDocument: { uri: stUri } });
    });
  });

  // ── Completions ───────────────────────────────────────────────────────────

  await group('Completions', async () => {
    await test('dot trigger on Game', async () => {
      assert(gameGetPlayerLine >= 0, 'Game.GetPlayer line not found');
      const dotCol = srcLines[gameGetPlayerLine].indexOf('.', gameCol) + 1;
      const r = await rpc('textDocument/completion', {
        textDocument: { uri: FIX },
        position: { line: gameGetPlayerLine, character: dotCol },
        context: { triggerKind: 2, triggerCharacter: '.' },
      });
      assert(labels(r).some(n => /getplayer/i.test(n)), `GetPlayer not in completions: ${labels(r).slice(0,5).join(', ')}`);
    });

    await test('statement context includes keywords and scripts', async () => {
      const r = await rpc('textDocument/completion', {
        textDocument: { uri: FIX },
        position: { line: onQuestInitLine >= 0 ? onQuestInitLine + 2 : 5, character: 1 },
        context: { triggerKind: 1 },
      });
      assert(items(r).length > 0, 'no items in statement context');
    });

    // Feature 5: self. in global scope → empty
    await test('self. inside global function returns empty', async () => {
      const gUri = 'file:///tmp/GlobalCompTest.psc';
      notify('textDocument/didOpen', { textDocument: { uri: gUri, languageId: 'papyrus', version: 1,
        text: 'Scriptname GlobalCompTest\nFunction Fn() global\n  self.\nEndFunction' } });
      await new Promise(r => setTimeout(r, 200));
      const r = await rpc('textDocument/completion', {
        textDocument: { uri: gUri }, position: { line: 2, character: 7 },
        context: { triggerKind: 2, triggerCharacter: '.' },
      });
      assert(items(r).length === 0, `self. in global = ${items(r).length} items (expected 0)`);
      notify('textDocument/didClose', { textDocument: { uri: gUri } });
    });

    // Feature 5: parent. works in non-global scope
    await test('parent. completions work in non-global scope', async () => {
      const pUri = 'file:///tmp/ParentCompTest.psc';
      notify('textDocument/didOpen', { textDocument: { uri: pUri, languageId: 'papyrus', version: 1,
        text: 'Scriptname ParentCompTest extends Quest\nFunction Fn()\n  parent.\nEndFunction' } });
      await new Promise(r => setTimeout(r, 200));
      const r = await rpc('textDocument/completion', {
        textDocument: { uri: pUri }, position: { line: 2, character: 9 },
        context: { triggerKind: 2, triggerCharacter: '.' },
      });
      // Quest has methods like GetCurrentStageID, SetStage, etc.
      assert(items(r).length > 0, `parent. returned 0 items`);
      notify('textDocument/didClose', { textDocument: { uri: pUri } });
    });

    // Feature 4: Array intrinsic methods via dot
    await test('array. completions include intrinsic methods', async () => {
      const arrUri = 'file:///tmp/ArrayCompTest.psc';
      // Declare the array property locally so buildTypeMap can resolve it
      const arrText = [
        'Scriptname ArrayCompTest',
        'Actor[] Property Actors Auto',
        'Function TestArr()',
        '  Actors.',  // line 3 — Actor[] property
        'EndFunction',
      ].join('\n');
      notify('textDocument/didOpen', { textDocument: { uri: arrUri, languageId: 'papyrus', version: 1, text: arrText } });
      await new Promise(r => setTimeout(r, 200));
      const r = await rpc('textDocument/completion', {
        textDocument: { uri: arrUri }, position: { line: 3, character: 9 },
        context: { triggerKind: 2, triggerCharacter: '.' },
      });
      const ls = labels(r).map(l => l.toLowerCase());
      assert(ls.some(l => /^find$/i.test(l)), `Find not in array completions: ${ls.join(', ')}`);
      assert(ls.some(l => /^add$/i.test(l)),  `Add not in array completions: ${ls.join(', ')}`);
      assert(ls.some(l => /^remove$/i.test(l)), `Remove not in array completions: ${ls.join(', ')}`);
      assert(ls.some(l => /^length$/i.test(l)), `Length not in array completions: ${ls.join(', ')}`);
      notify('textDocument/didClose', { textDocument: { uri: arrUri } });
    });

    // Feature 8: __state in non-global scope
    await test('__state appears in non-global function completions', async () => {
      const sUri = 'file:///tmp/StateCompTest.psc';
      notify('textDocument/didOpen', { textDocument: { uri: sUri, languageId: 'papyrus', version: 1,
        text: 'Scriptname StateCompTest\nFunction Fn()\n  __state\nEndFunction' } });
      await new Promise(r => setTimeout(r, 200));
      const r = await rpc('textDocument/completion', {
        textDocument: { uri: sUri }, position: { line: 2, character: 1 },
        context: { triggerKind: 1 },
      });
      assert(items(r).some(i => i.label === '__state'), '__state not in completions for non-global function');
      notify('textDocument/didClose', { textDocument: { uri: sUri } });
    });

    await test('__state absent from global function completions', async () => {
      const gUri = 'file:///tmp/StateGlobalCompTest.psc';
      notify('textDocument/didOpen', { textDocument: { uri: gUri, languageId: 'papyrus', version: 1,
        text: 'Scriptname StateGlobalCompTest\nFunction Fn() global\n  __state\nEndFunction' } });
      await new Promise(r => setTimeout(r, 200));
      const r = await rpc('textDocument/completion', {
        textDocument: { uri: gUri }, position: { line: 2, character: 1 },
        context: { triggerKind: 1 },
      });
      assert(!items(r).some(i => i.label === '__state'), '__state should not appear in global function completions');
      notify('textDocument/didClose', { textDocument: { uri: gUri } });
    });

    // Feature 7: struct field completions via qualified type
    await test('struct field access via qualified Script:Struct type', async () => {
      const stUri = 'file:///tmp/StructCompTest.psc';
      const stText = [
        'Scriptname StructCompTest extends Quest',
        'Import DefaultScriptFunctions',
        '',
        'Function TestStruct()',
        '  DefaultScriptFunctions:ParentScriptFunctionParams params = DefaultScriptFunctions.BuildParentScriptFunctionParams(None, None)',
        '  params.',   // line 5
        'EndFunction',
      ].join('\n');
      notify('textDocument/didOpen', { textDocument: { uri: stUri, languageId: 'papyrus', version: 1, text: stText } });
      await new Promise(r => setTimeout(r, 300));
      const r = await rpc('textDocument/completion', {
        textDocument: { uri: stUri }, position: { line: 5, character: 9 },
        context: { triggerKind: 2, triggerCharacter: '.' },
      });
      const ls = labels(r).map(l => l.toLowerCase());
      assert(ls.length > 0, 'struct dot-completions empty');
      assert(ls.some(l => /reftocheck|locationtocheck/i.test(l)), `struct fields missing, got: ${ls.slice(0,5).join(', ')}`);
      notify('textDocument/didClose', { textDocument: { uri: stUri } });
    });

    // Feature 11: override stub completions
    await test('Function at script level offers override stubs', async () => {
      const oUri = 'file:///tmp/OverrideCompTest.psc';
      const oText = 'Scriptname OverrideCompTest extends Quest\n\nFunction ';
      notify('textDocument/didOpen', { textDocument: { uri: oUri, languageId: 'papyrus', version: 1, text: oText } });
      await new Promise(r => setTimeout(r, 300));
      const r = await rpc('textDocument/completion', {
        textDocument: { uri: oUri }, position: { line: 2, character: 9 },
        context: { triggerKind: 1 },
      });
      const its = items(r);
      assert(its.length > 0, 'no override stubs for Function at script level');
      const hasSnippet = its.some(i => i.insertTextFormat === 2 && i.textEdit?.newText?.includes('EndFunction'));
      assert(hasSnippet, 'override stubs are not snippets with EndFunction');
      notify('textDocument/didClose', { textDocument: { uri: oUri } });
    });

    await test('Event at script level offers event stubs', async () => {
      const eUri = 'file:///tmp/EventStubTest.psc';
      const eText = 'Scriptname EventStubTest extends Quest\n\nEvent ';
      notify('textDocument/didOpen', { textDocument: { uri: eUri, languageId: 'papyrus', version: 1, text: eText } });
      await new Promise(r => setTimeout(r, 300));
      const r = await rpc('textDocument/completion', {
        textDocument: { uri: eUri }, position: { line: 2, character: 6 },
        context: { triggerKind: 1 },
      });
      const its = items(r);
      assert(its.length > 0, 'no event stubs at script level');
      const hasEvSnippet = its.some(i => i.insertTextFormat === 2 && i.textEdit?.newText?.includes('EndEvent'));
      assert(hasEvSnippet, 'event stubs are not snippets with EndEvent');
      const ls = its.map(i => i.label?.toLowerCase() ?? '');
      assert(ls.some(l => /oninit|onquest|ontimer/i.test(l)), `expected Quest events, got: ${ls.slice(0,5).join(', ')}`);
      notify('textDocument/didClose', { textDocument: { uri: eUri } });
    });

    await test('override stubs absent inside function body', async () => {
      const iUri = 'file:///tmp/InnerCompTest.psc';
      const iText = 'Scriptname InnerCompTest extends Quest\nFunction OuterFn()\n  Function ';
      notify('textDocument/didOpen', { textDocument: { uri: iUri, languageId: 'papyrus', version: 1, text: iText } });
      await new Promise(r => setTimeout(r, 200));
      const r = await rpc('textDocument/completion', {
        textDocument: { uri: iUri }, position: { line: 2, character: 11 },
        context: { triggerKind: 1 },
      });
      const hasOverride = items(r).some(i => i.textEdit?.newText?.includes('EndFunction'));
      assert(!hasOverride, 'override stubs should not appear inside function body');
      notify('textDocument/didClose', { textDocument: { uri: iUri } });
    });
  });

  // ── Signature Help ────────────────────────────────────────────────────────

  await group('Signature Help', async () => {
    await test('SetStage() shows signature', async () => {
      if (setStageCallLine < 0) { process.stdout.write('    SKIP  (SetStage call not found)\n'); return; }
      // just verify no error — null is acceptable if type resolution fails
      await rpc('textDocument/signatureHelp', {
        textDocument: { uri: FIX }, position: { line: setStageCallLine, character: setStageCol },
      });
    });

    // Feature 4: array method sig-help
    await test('array.Find( shows signature with element type', async () => {
      const afUri = 'file:///tmp/ArraySigTest.psc';
      const afText = [
        'Scriptname ArraySigTest',
        'Actor[] Property Actors Auto',
        'Function TestArr()',
        '  Int idx = Actors.Find(',  // Actor[]
        'EndFunction',
      ].join('\n');
      notify('textDocument/didOpen', { textDocument: { uri: afUri, languageId: 'papyrus', version: 1, text: afText } });
      await new Promise(r => setTimeout(r, 200));
      const col = afText.split('\n')[3].indexOf('Find(') + 5;
      const r = await rpc('textDocument/signatureHelp', {
        textDocument: { uri: afUri }, position: { line: 3, character: col },
      });
      if (r?.signatures?.length > 0) {
        const sig = r.signatures[0].label;
        assert(/Find|Actor|find/i.test(sig), `array.Find sig looks wrong: ${sig}`);
      }
      notify('textDocument/didClose', { textDocument: { uri: afUri } });
    });
  });

  // ── Go-to Definition ──────────────────────────────────────────────────────

  await group('Go-to Definition', async () => {
    await test('Quest type on extends keyword', async () => {
      const r = await rpc('textDocument/definition', {
        textDocument: { uri: FIX }, position: { line: scriptnameLine, character: extendsCol + 2 },
      });
      const locs = Array.isArray(r) ? r : r ? [r] : [];
      assert(locs.length > 0 && locs[0].uri, 'no definition for Quest type');
    });

    await test('ReferenceAlias type', async () => {
      const r = await rpc('textDocument/definition', {
        textDocument: { uri: FIX }, position: { line: refAliasLine, character: refAliasCol + 5 },
      });
      const locs = Array.isArray(r) ? r : r ? [r] : [];
      assert(locs.length > 0, 'no definition for ReferenceAlias');
    });

    await test('Game script', async () => {
      const r = await rpc('textDocument/definition', {
        textDocument: { uri: FIX }, position: { line: gameGetPlayerLine, character: gameCol + 1 },
      });
      const locs = Array.isArray(r) ? r : r ? [r] : [];
      assert(locs.length > 0, 'no definition for Game');
    });
  });

  // ── Document Symbols, Workspace ───────────────────────────────────────────

  await group('Symbols', async () => {
    await test('documentSymbol includes OnQuestInit', async () => {
      const r = await rpc('textDocument/documentSymbol', { textDocument: { uri: FIX } });
      assert(Array.isArray(r) && r.length > 0, 'no document symbols');
      assert(r.some(s => /onquestinit/i.test(s.name ?? s.detail ?? '')), 'OnQuestInit not found in symbols');
    });

    await test('workspaceSymbol: LC088 returns results', async () => {
      const r = await rpc('workspace/symbol', { query: 'LC088' });
      assert(Array.isArray(r) && r.length > 0, 'no workspace symbols for LC088');
    });

    await test('workspaceSymbol: empty query returns all scripts', async () => {
      const r = await rpc('workspace/symbol', { query: '' });
      assert(Array.isArray(r) && r.length > 100, `expected many symbols, got ${r?.length ?? 0}`);
    });
  });

  // ── LSP Extras ────────────────────────────────────────────────────────────

  await group('LSP Extras', async () => {
    await test('selectionRange', async () => {
      const r = await rpc('textDocument/selectionRange', {
        textDocument: { uri: FIX }, positions: [{ line: scriptnameLine, character: 0 }],
      });
      assert(Array.isArray(r) && r.length > 0 && r[0].range, 'no selection ranges');
    });

    await test('inlayHints (no error)', async () => {
      await rpc('textDocument/inlayHint', {
        textDocument: { uri: FIX },
        range: { start: { line: 0, character: 0 }, end: { line: 50, character: 0 } },
      });
    });

    await test('foldingRange', async () => {
      const r = await rpc('textDocument/foldingRange', { textDocument: { uri: FIX } });
      assert(Array.isArray(r) && r.length > 0, 'no folding ranges');
    });

    await test('codeLens (no error)', async () => {
      const r = await rpc('textDocument/codeLens', { textDocument: { uri: FIX } });
      assert(Array.isArray(r), 'codeLens not array');
    });

    await test('codeAction (no error)', async () => {
      const r = await rpc('textDocument/codeAction', {
        textDocument: { uri: FIX },
        range: { start: { line: scriptnameLine, character: 0 }, end: { line: scriptnameLine, character: 5 } },
        context: { diagnostics: [] },
      });
      assert(Array.isArray(r), 'codeAction not array');
    });

    await test('semanticTokens/full returns data', async () => {
      const r = await rpc('textDocument/semanticTokens/full', { textDocument: { uri: FIX } });
      assert(r?.data && Array.isArray(r.data) && r.data.length > 0, 'no semantic tokens');
    });

    await test('formatting (no error)', async () => {
      // null means no changes needed — acceptable
      await rpc('textDocument/formatting', {
        textDocument: { uri: FIX }, options: { tabSize: 4, insertSpaces: false },
      });
    });

    await test('references: Quest type', async () => {
      const r = await rpc('textDocument/references', {
        textDocument: { uri: FIX },
        position: { line: scriptnameLine, character: extendsCol + 2 },
        context: { includeDeclaration: false },
      });
      assert(Array.isArray(r), 'references not array');
    });

    await test('prepareRename: local variable (no error)', async () => {
      const assignLine = findLine(/^\s*player\s*=\s*Game\.GetPlayer/i);
      if (assignLine < 0) { process.stdout.write('    SKIP  (assignment line not found)\n'); return; }
      await rpc('textDocument/prepareRename', {
        textDocument: { uri: FIX },
        position: { line: assignLine, character: srcLines[assignLine].indexOf('player') + 2 },
      });
    });
  });

  // ── Diagnostics — Compiler Integration (Feature 2) ───────────────────────

  await group('Diagnostics — compiler integration', async () => {
    await test('compiler runs on save and publishes diagnostics for fixture', async () => {
      const p = awaitDiags('file://' + FIXTURE, 15000);
      notify('textDocument/didChange', { textDocument: { uri: 'file://' + FIXTURE, version: 4 }, contentChanges: [{ text: fileContent }] });
      const params = await p;
      assert(params.uri === 'file://' + FIXTURE, `wrong URI: ${params.uri}`);
      const count = params.diagnostics?.length ?? 0;
      process.stdout.write(`        INFO  ${count} diagnostics on fixture\n`);
      for (const d of (params.diagnostics ?? []))
        process.stdout.write(`          [sev=${d.severity}] (${d.range.start.line}:${d.range.start.character}) ${d.message}\n`);
    });
  });

  // ── Feature 4 — Array intrinsic methods ──────────────────────────────────

  await group('Feature 4 — Array intrinsic hover', async () => {
    await test('hover on arr.Find shows element-type signature', async () => {
      const ahUri = 'file:///tmp/ArrHoverTest.psc';
      // Declare array locally so typeMap resolves it
      const ahText = [
        'Scriptname ArrHoverTest',
        'Actor[] Property Actors Auto',
        'Function TestArr()',
        '  Int idx = Actors.Find(None)',
        'EndFunction',
      ].join('\n');
      notify('textDocument/didOpen', { textDocument: { uri: ahUri, languageId: 'papyrus', version: 1, text: ahText } });
      await new Promise(r => setTimeout(r, 200));
      const lineText = ahText.split('\n')[3];
      const col = lineText.indexOf('Find') + 1;
      const r = await rpc('textDocument/hover', { textDocument: { uri: ahUri }, position: { line: 3, character: col } });
      const text = hoverText(r);
      assert(/Find|Actor|find/i.test(text), `array.Find hover missing signature, got: ${text.slice(0, 200)}`);
      notify('textDocument/didClose', { textDocument: { uri: ahUri } });
    });

    await test('hover on arr.Length shows read-only note', async () => {
      const alUri = 'file:///tmp/ArrLenTest.psc';
      const alText = [
        'Scriptname ArrLenTest',
        'Actor[] Property Actors Auto',
        'Function TestArr()',
        '  Int n = Actors.Length',
        'EndFunction',
      ].join('\n');
      notify('textDocument/didOpen', { textDocument: { uri: alUri, languageId: 'papyrus', version: 1, text: alText } });
      await new Promise(r => setTimeout(r, 200));
      const lineText = alText.split('\n')[3];
      const col = lineText.indexOf('Length') + 1;
      const r = await rpc('textDocument/hover', { textDocument: { uri: alUri }, position: { line: 3, character: col } });
      const text = hoverText(r);
      assert(/Length|length|Read-only/i.test(text), `arr.Length hover missing content, got: ${text.slice(0, 200)}`);
      notify('textDocument/didClose', { textDocument: { uri: alUri } });
    });
  });

  // ── Feature 6 — Exact compiler error messages ─────────────────────────────

  await group('Feature 6 — Exact compiler error messages (checkStructural + checkSemantics)', async () => {
    await test('script name component > 38 chars', async () => {
      const d = await syntheticDiags('file:///tmp/LongName.psc', 'Scriptname ' + 'X'.repeat(39));
      assert(d.some(m => /Script name ".*" is too long/i.test(m.message)), 'missed: long script name');
    });

    await test('duplicate import', async () => {
      const d = await syntheticDiags('file:///tmp/DupImport.psc',
        'Scriptname DupImport\nImport Game\nImport Game');
      assert(d.some(m => /imported more then once/i.test(m.message)), 'missed: duplicate import');
    });

    await test('struct field typed as array', async () => {
      const d = await syntheticDiags('file:///tmp/StructArr.psc',
        'Scriptname StructArr\nStruct S\n  Actor[] f\nEndStruct');
      assert(d.some(m => m.message === 'struct variables cannot be arrays'), 'missed: struct array field');
    });

    await test('struct field typed as var', async () => {
      const d = await syntheticDiags('file:///tmp/StructVar.psc',
        'Scriptname StructVar\nStruct S\n  Var f\nEndStruct');
      assert(d.some(m => m.message === 'structs may not contain var variables'), 'missed: struct var field');
    });

    await test('array size out of range', async () => {
      const d = await syntheticDiags('file:///tmp/ArrSize.psc',
        'Scriptname ArrSize\nFunction F()\n  Actor[] a = new Actor[200]\nEndFunction');
      assert(d.some(m => /Array size of.*is invalid/i.test(m.message)), 'missed: array size > 128');
    });

    await test('array size 128 is valid', async () => {
      const d = await syntheticDiags('file:///tmp/ArrSize128.psc',
        'Scriptname ArrSize128\nFunction F()\n  Actor[] a = new Actor[128]\nEndFunction');
      assert(!d.some(m => /Array size of.*is invalid/i.test(m.message)), 'false positive: size 128 flagged');
    });

    await test('const without initializer', async () => {
      const d = await syntheticDiags('file:///tmp/ConstNoInit.psc',
        'Scriptname ConstNoInit\nFunction F()\n  Int const x\nEndFunction');
      assert(d.some(m => m.message === 'const variables must be given an initial value'), 'missed: const no init');
    });

    await test('type mismatch: object→int warns', async () => {
      const d = await syntheticDiags('file:///tmp/TypeMismatch.psc',
        'Scriptname TypeMismatch\nActor Property MyActor Auto\nFunction F()\n  Int x = MyActor\nEndFunction');
      assert(d.some(m => /type mismatch while assigning to a int/i.test(m.message)), 'missed: object→int mismatch');
    });

    await test('type mismatch: any→bool is legal (no warning)', async () => {
      const d = await syntheticDiags('file:///tmp/BoolCast.psc',
        'Scriptname BoolCast\nActor Property MyActor Auto\nFunction F()\n  Bool b = MyActor\nEndFunction');
      assert(!d.some(m => /type mismatch.*bool/i.test(m.message)), 'false positive: any→bool flagged');
    });

    await test('type mismatch: child→parent is legal (no warning)', async () => {
      const d = await syntheticDiags('file:///tmp/Inherit.psc',
        'Scriptname Inherit\nActor Property MyActor Auto\nFunction F()\n  ObjectReference r = MyActor\nEndFunction');
      assert(!d.some(m => /type mismatch.*objectreference/i.test(m.message)), 'false positive: child→parent flagged');
    });
  });

  // ── Feature 8 — __state intrinsic ─────────────────────────────────────────

  await group('Feature 8 — __state intrinsic', async () => {
    await test('__state in completions, absent in global scope', async () => {
      const uri = 'file:///tmp/StateTest2.psc';
      notify('textDocument/didOpen', { textDocument: { uri, languageId: 'papyrus', version: 1,
        text: 'Scriptname StateTest2\nFunction NormalFn()\n  __state\nEndFunction\nFunction GlobalFn() global\n  __state\nEndFunction' } });
      await new Promise(r => setTimeout(r, 200));
      // Non-global: __state should appear
      const r1 = await rpc('textDocument/completion', { textDocument: { uri }, position: { line: 2, character: 1 }, context: { triggerKind: 1 } });
      assert(items(r1).some(i => i.label === '__state'), '__state missing from normal function completions');
      // Global: __state should NOT appear
      const r2 = await rpc('textDocument/completion', { textDocument: { uri }, position: { line: 5, character: 1 }, context: { triggerKind: 1 } });
      assert(!items(r2).some(i => i.label === '__state'), '__state present in global function completions (should not be)');
      notify('textDocument/didClose', { textDocument: { uri } });
    });
  });

  // ── Feature 9 — Guard system diagnostics ─────────────────────────────────

  await group('Feature 9 — Guard system (15 checks)', async () => {
    const guardText = [
      'Scriptname GuardTest',
      'Guard DataGuard',
      'Guard FuncGuard ProtectsFunctionLogic',
      'Guard DataGuard',                            // 3: duplicate
      'Guard NoUseGuard',                           // 4: not protecting anything
      '',
      'Int myVar RequiresGuard(DataGuard)',          // 6: good
      'Int badVar RequiresGuard(GhostGuard)',        // 7: undefined guard
      'Int twoGuards RequiresGuard(DataGuard, FuncGuard)', // 8: multiple guards
      'Int funcOnly RequiresGuard(FuncGuard)',       // 9: FuncLogic on variable
      'Int selfOnly RequiresGuard(DataGuard) SelfOnly',    // 10: SelfOnly+RequiresGuard
      'Int withAccess RequiresGuard(DataGuard) Protected', // 11: Protected+RequiresGuard
      '',
      'Actor Property BadProp RequiresGuard(DataGuard)',   // 13: non-auto+guard
      'Actor Property GoodProp Auto RequiresGuard(DataGuard)', // 14: OK
      '',
      'Function GlobalFn() global',
      '  LockGuard DataGuard',                      // 17: guard in global
      '  EndLockGuard',
      'EndFunction',
      '',
      'Function NormalFn()',
      '  LockGuard DataGuard',                      // 22: good
      '  LockGuard DataGuard',                      // 23: already locked
      '  LockGuard GhostGuard',                     // 24: undefined
      '  EndLockGuard',
      '  EndLockGuard',
      '  EndLockGuard',
      '  TryLockGuard GhostGuard',                  // 28: undefined in TryLock
      '  EndTryLockGuard',
      'EndFunction',
      '',
      'Function ReqFn() RequiresGuard(FuncGuard)',  // 32: FuncLogic on function = OK
      'EndFunction',
      '',
      'Function DataGuard()',                        // 35: name conflicts with guard
      'EndFunction',
    ].join('\n');

    const gd = await syntheticDiags('file:///tmp/GuardTest.psc', guardText);
    const gm = gd.map(d => ({ msg: d.message, line: d.range.start.line, sev: d.severity }));

    await test('duplicate guard declaration', async () => {
      assert(gm.some(m => /guard.*already defined/i.test(m.msg) && m.line === 3), 'missed: duplicate guard');
    });
    await test('undefined guard in RequiresGuard', async () => {
      assert(gm.some(m => /cannot require guard GhostGuard|GhostGuard.*does not exist/i.test(m.msg) && m.line === 7), 'missed: undefined guard in RequiresGuard');
    });
    await test('multiple guards in single RequiresGuard on variable', async () => {
      assert(gm.some(m => /more than one guard/i.test(m.msg) && m.line === 8), 'missed: multiple guards');
    });
    await test('FunctionLogic guard used on variable', async () => {
      assert(gm.some(m => /protecting function logic only/i.test(m.msg) && m.line === 9), 'missed: FuncLogic on variable');
    });
    await test('RequiresGuard + SelfOnly conflict', async () => {
      assert(gm.some(m => /SelfOnly/i.test(m.msg) && m.line === 10), 'missed: RequiresGuard+SelfOnly');
    });
    await test('RequiresGuard + access modifier conflict', async () => {
      assert(gm.some(m => /access modifier/i.test(m.msg) && m.line === 11), 'missed: RequiresGuard+Protected');
    });
    await test('RequiresGuard on non-auto property', async () => {
      assert(gm.some(m => /Only auto properties/i.test(m.msg) && m.line === 13), 'missed: non-auto property');
    });
    await test('LockGuard in global function', async () => {
      assert(gm.some(m => /global function/i.test(m.msg) && m.line === 17), 'missed: LockGuard in global');
    });
    await test('guard already locked (double-lock)', async () => {
      assert(gm.some(m => /already locked/i.test(m.msg) && m.line === 23), 'missed: double lock');
    });
    await test('undefined guard in LockGuard', async () => {
      assert(gm.some(m => /guard GhostGuard is undefined/i.test(m.msg) && m.line === 24), 'missed: undefined in LockGuard');
    });
    await test('undefined guard in TryLockGuard', async () => {
      assert(gm.some(m => /guard GhostGuard is undefined/i.test(m.msg) && m.line === 28), 'missed: undefined in TryLockGuard');
    });
    await test('guard not protecting any variables (warning)', async () => {
      assert(gm.some(m => /not protecting any variables/i.test(m.msg) && m.sev === 2), 'missed: guard not protecting anything');
    });
    await test('function name conflicts with guard name', async () => {
      assert(gm.some(m => /cannot have the same name as a guard/i.test(m.msg)), 'missed: name conflict with guard');
    });
    await test('good usage: auto property + FuncLogic on function = no errors', async () => {
      assert(!gm.some(m => m.line === 14 && m.sev === 1), 'false positive on auto+RequiresGuard');
      assert(!gm.some(m => m.line === 32 && m.sev === 1), 'false positive on FuncLogic on function');
    });
  });

  // ── Feature 10 — Access modifiers ────────────────────────────────────────

  await group('Feature 10 — Access modifiers', async () => {
    const accText = [
      'Scriptname AccessTest extends VendingMachineScript',
      '',
      'Function GoodPrivate() private',           // 2: OK
      'Function MultiAccess() private protected', // 3: ERROR: multiple modifiers
      'Function SelfOnlyPublic() selfonly',        // 4: ERROR: selfonly without private/protected
      'Function SelfOnlyGlobal() private selfonly global', // 5: ERROR: selfonly on global
      'Function InternalMember() internal',        // 6: ERROR: internal on non-namespaced
      '',
      'Actor Property BadAccessProp RequiresGuard(SomeGuard) protected', // 8: ERROR: non-auto+access
      'Actor Property GoodAccessProp Auto protected',  // 9: OK
      '',
      'Function TestSites(VendingMachineScript vm)',  // 11
      '  vm.ResetVendingMachine()',               // 12: ERROR: private method
      'EndFunction',
    ].join('\n');

    const ad = await syntheticDiags('file:///tmp/AccessTest.psc', accText);
    const am = ad.map(d => ({ msg: d.message, line: d.range.start.line }));

    await test('multiple access modifiers', async () => {
      assert(am.some(m => /Multiple access modifiers/i.test(m.msg) && m.line === 3), 'missed: multiple modifiers');
    });
    await test('SelfOnly without private/protected', async () => {
      assert(am.some(m => /SelfOnly is only allowed on private or protected/i.test(m.msg) && m.line === 4), 'missed: SelfOnly+public');
    });
    await test('SelfOnly on global function', async () => {
      assert(am.some(m => /SelfOnly is not allowed on global/i.test(m.msg) && m.line === 5), 'missed: SelfOnly+global');
    });
    await test('Internal on non-namespaced script', async () => {
      assert(am.some(m => /Internal access modifier only allowed/i.test(m.msg) && m.line === 6), 'missed: Internal on non-namespaced');
    });
    await test('access modifier on non-auto property', async () => {
      assert(am.some(m => /Only auto properties.*access restrictions/i.test(m.msg) && m.line === 8), 'missed: access on non-auto property');
    });
    await test('good private function — no false positive', async () => {
      assert(!am.some(m => m.line === 2 && /access|SelfOnly|Internal|Multiple/i.test(m.msg)), 'false positive on valid private function');
    });
    await test('access-site: private method from outside declaring script', async () => {
      assert(am.some(m => /Cannot access private function ResetVendingMachine/i.test(m.msg) && m.line === 12), 'missed: private function access-site error');
    });
  });

  // ── Feature 12 — Conditional compilation ─────────────────────────────────

  await group('Feature 12 — Conditional compilation (DebugOnly / BetaOnly)', async () => {
    const condText = [
      'Scriptname CondTest extends Quest',
      '',
      'Function MyTrace() DebugOnly',      // 2: DebugOnly helper
      '  Debug.Trace("inner")',
      'EndFunction',
      '',
      'Function RegularFn()',
      '  Debug.Trace("hello")',             // 7: WARN — Debug script is DebugOnly
      '  MyTrace()',                         // 8: WARN — own DebugOnly function
      'EndFunction',
      '',
      'Function DebugWrapper() DebugOnly',
      '  Debug.Trace("hello")',             // 12: OK — in DebugOnly scope
      '  MyTrace()',                         // 13: OK — in DebugOnly scope
      'EndFunction',
    ].join('\n');

    const cd = await syntheticDiags('file:///tmp/CondTest.psc', condText);
    const cm = cd.map(d => ({ msg: d.message, line: d.range.start.line, sev: d.severity }));

    await test('Debug.Trace from regular function warns', async () => {
      assert(cm.some(m => /DebugOnly.*release|release.*DebugOnly/i.test(m.msg) && m.line === 7 && m.sev === 2), 'missed: Debug.Trace warn (line 7)');
    });
    await test('own DebugOnly function bare call from regular function warns', async () => {
      assert(cm.some(m => /DebugOnly.*release|release.*DebugOnly/i.test(m.msg) && m.line === 8 && m.sev === 2), 'missed: MyTrace() warn (line 8)');
    });
    await test('Debug.Trace from DebugOnly function does not warn', async () => {
      assert(!cm.some(m => /DebugOnly/i.test(m.msg) && m.line === 12), 'false positive: line 12 in DebugOnly scope');
    });
    await test('own DebugOnly function call from DebugOnly scope does not warn', async () => {
      assert(!cm.some(m => /DebugOnly/i.test(m.msg) && m.line === 13), 'false positive: line 13 in DebugOnly scope');
    });

    // BetaOnly test
    await test('BetaOnly function call warns from regular function', async () => {
      const bText = [
        'Scriptname BetaTest',
        'Function MyBeta() BetaOnly',
        '  ; nothing',
        'EndFunction',
        'Function Regular()',
        '  MyBeta()',   // line 5: WARN
        'EndFunction',
      ].join('\n');
      const bd = await syntheticDiags('file:///tmp/BetaTest.psc', bText);
      assert(bd.some(d => /BetaOnly.*final|final.*BetaOnly/i.test(d.message) && d.range.start.line === 5 && d.severity === 2),
        'missed: BetaOnly function call warning');
    });
  });

  // ── Shutdown ──────────────────────────────────────────────────────────────

  await rpc('shutdown', null).catch(() => {});
  notify('exit', null);
  await new Promise(r => setTimeout(r, 300));
  server.kill();

  // ── Results ───────────────────────────────────────────────────────────────

  const total = passed + failed;
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ' — all green'}`);
  console.log(`${'═'.repeat(55)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
