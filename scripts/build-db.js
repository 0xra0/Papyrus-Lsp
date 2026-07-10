#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Which source trees to index, in precedence order — later dirs override earlier
// ones, so project scripts win over the vanilla copies they shadow.
//
//   node scripts/build-db.js [dir...]        explicit dirs
//   PAPYRUS_LSP_IMPORTS=a:b node …/build-db  same, via the env var the server reads
//   node scripts/build-db.js                 bundled vanilla + mod-extenders
//
// Defaults keep the build self-contained: nothing outside this repo is required.
const DEFAULT_DIRS = [
  path.join(ROOT, '_vanilla-sf-scripts', 'Scripts', 'Source'),
  path.join(ROOT, 'mod-extenders'),
];

const argDirs = process.argv.slice(2);
const envDirs = (process.env.PAPYRUS_LSP_IMPORTS || '').split(path.delimiter).filter(Boolean);
const DIRS = (argDirs.length ? argDirs : envDirs.length ? envDirs : DEFAULT_DIRS)
  .map(d => path.resolve(d));

const OUT = process.env.PAPYRUS_LSP_DB || path.join(ROOT, 'scripts-db.json');

const SCRIPTNAME_RE = /^\s*scriptname\s+(\S+)(?:\s+extends\s+(\S+))?/i;
const FUNC_RE       = /^\s*(?:([\w\[\]]+)\s+)?function\s+(\w+)\s*\(([^)]*)\)([^;]*)/i;
const EVENT_RE      = /^\s*event\s+([\w.]+)\s*\(([^)]*)\)/i;
const PROP_RE       = /^\s*([\w\[\]]+)\s+property\s+(\w+)(?:\s+=\s*[^;]+)?(\s+auto|\s+autoreadonly)?/i;
const STRUCT_RE     = /^\s*struct\s+(\w+)/i;
const ENDSTRUCT_RE  = /^\s*endstruct\b/i;
const CUSTOMEVENT_RE = /^\s*customevent\s+(\w+)/i;

/** Join lines ending with \ before parsing */
function joinContinuations(lines) {
  const out = []; let pending = '';
  for (const ln of lines) {
    if (ln.trimEnd().endsWith('\\')) { pending += ln.trimEnd().slice(0, -1) + ' '; }
    else { out.push(pending + ln); pending = ''; }
  }
  if (pending) out.push(pending);
  return out;
}

/**
 * Read the Papyrus `{...}` docstring on lines[startIdx].
 * Skips at most one blank line between the declaration and the `{`.
 * Handles multi-line blocks (content until the closing `}`).
 * Returns trimmed text or undefined.
 */
function readDocstring(lines, startIdx) {
  let i = startIdx;
  // Allow at most one blank line between the declaration and the docstring
  if (i < lines.length && lines[i].replace(/;.*$/, '').trim() === '') i++;
  if (i >= lines.length) return undefined;
  const first = lines[i].replace(/;.*$/, '').trim();
  if (!first.startsWith('{')) return undefined;
  const close = first.indexOf('}', 1);
  if (close !== -1) return first.slice(1, close).trim() || undefined;
  // Multi-line: collect until closing '}'
  const parts = [first.slice(1).trim()];
  for (let j = i + 1; j < lines.length; j++) {
    const ln = lines[j];
    const ci = ln.indexOf('}');
    if (ci !== -1) { parts.push(ln.slice(0, ci).trim()); break; }
    parts.push(ln.trim());
  }
  return parts.filter(Boolean).join('\n') || undefined;
}

function parsePsc(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const lines = joinContinuations(text.split(/\r?\n/));
  const len   = lines.length;
  let name = null, extendsType = null, scriptDoc = undefined;
  let scriptDebugOnly = false, scriptBetaOnly = false;
  const functions = [], events = [], properties = [], structs = [], globals = [], customEvents = [];
  let inStruct = null, structFields = [], lastComments = [];

  for (let i = 0; i < len; i++) {
    let raw = lines[i];

    // Capture line comments before stripping
    const commentMatch = /^\s*;(?!\/)(.*)/.exec(raw);
    raw = raw.replace(/;\/.*?\/;/g, '').replace(/;.*$/, '').trim();

    if (commentMatch && !raw) { lastComments.push(commentMatch[1].trim()); continue; }
    if (!raw) { lastComments = []; continue; }

    // {docstring} for the previous declaration — skip, handled below via readDocstring
    if (raw.startsWith('{')) { lastComments = []; continue; }

    // Prefer the {docstring} on the next line; fall back to preceding ; comments
    const commentDoc = lastComments.filter(c => c).join('\n') || undefined;
    lastComments = [];

    if (!name) {
      const m = SCRIPTNAME_RE.exec(raw);
      if (m) {
        name = m[1]; extendsType = m[2] ?? null;
        scriptDoc = readDocstring(lines, i + 1) ?? commentDoc;
        // Script-level conditional compilation flags
        scriptDebugOnly = /\bDebugOnly\b/i.test(raw);
        scriptBetaOnly  = /\bBetaOnly\b/i.test(raw);
        continue;
      }
    }


    // Inside a struct block — parse fields, skip everything else
    if (inStruct) {
      if (ENDSTRUCT_RE.test(raw)) {
        structs.push({ name: inStruct, fields: structFields });
        inStruct = null; structFields = [];
      } else {
        const tokens = raw.split(/\s+/);
        if (tokens.length >= 2 && /^[\w\[\]]+$/.test(tokens[0])) {
          const fn = tokens[1].replace(/=.*$/, '').trim();
          if (fn && /^\w+$/.test(fn)) structFields.push({ type: tokens[0], name: fn });
        }
      }
      continue;
    }

    const cm = CUSTOMEVENT_RE.exec(raw);
    if (cm) { customEvents.push(cm[1]); continue; }

    const sm = STRUCT_RE.exec(raw);
    if (sm) { inStruct = sm[1]; structFields = []; continue; }

    const fm = FUNC_RE.exec(raw);
    if (fm) {
      const retType  = fm[1] ?? 'void';
      const fname    = fm[2];
      const params   = fm[3].trim();
      const flags    = fm[4].trim().toLowerCase();
      const isNative = flags.includes('native');
      const isGlobal = flags.includes('global');
      const doc      = readDocstring(lines, i + 1) ?? commentDoc;
      // Capture access modifiers and SelfOnly
      const access     = /\bprivate\b/.test(flags) ? 'private'
                       : /\bprotected\b/.test(flags) ? 'protected'
                       : /\binternal\b/.test(flags) ? 'internal'
                       : undefined;
      const selfOnly   = /\bselfonly\b/.test(flags) || undefined;
      const debugOnly  = /\bdebugonly\b/.test(flags) || undefined;
      const betaOnly   = /\bbetaonly\b/.test(flags) || undefined;
      functions.push({ ret: retType, name: fname, params, native: isNative, doc, access, selfOnly, debugOnly, betaOnly });
      if (isGlobal) globals.push(fname);
      continue;
    }

    const em = EVENT_RE.exec(raw);
    if (em) {
      const doc = readDocstring(lines, i + 1) ?? commentDoc;
      events.push({ name: em[1], params: em[2].trim(), doc });
      continue;
    }

    const pm = PROP_RE.exec(raw);
    if (pm) {
      const doc      = readDocstring(lines, i + 1) ?? commentDoc;
      const propFlags = raw.toLowerCase();
      const access   = /\bprivate\b/.test(propFlags) ? 'private'
                     : /\bprotected\b/.test(propFlags) ? 'protected'
                     : /\binternal\b/.test(propFlags) ? 'internal'
                     : undefined;
      const selfOnly = /\bselfonly\b/.test(propFlags) || undefined;
      properties.push({ type: pm[1], name: pm[2], readonly: /\bautoreadonly\b/i.test(raw), doc, access, selfOnly });
    }
  }
  return name ? { name, extendsType, functions, events, properties, structs, globals, customEvents, scriptDoc, sourcePath: filePath, scriptDebugOnly: scriptDebugOnly || undefined, scriptBetaOnly: scriptBetaOnly || undefined } : null;
}

function walkDir(dir, results) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(full, results);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.psc')) {
      const info = parsePsc(full);
      if (info) results.set(info.name.toLowerCase(), info);
    }
  }
}

console.log('Scanning scripts...');
const db = new Map();
for (const d of DIRS) {
  if (!fs.existsSync(d)) { console.log(`  ${d}: missing, skipped`); continue; }
  const before = db.size;
  walkDir(d, db);
  console.log(`  ${d}: +${db.size - before} scripts`);
}

if (db.size === 0) {
  console.error('\nNo .psc files found. Pass source dirs explicitly, or fetch the bundled\n' +
                'vanilla scripts with `npm run fetch-vanilla`.');
  process.exit(1);
}

const out = Object.fromEntries(db);
fs.writeFileSync(OUT, JSON.stringify(out, null, 0));
console.log(`\nWrote ${db.size} scripts → ${OUT} (${(fs.statSync(OUT).size/1024).toFixed(0)} KB)`);
