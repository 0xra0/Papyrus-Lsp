import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  TextDocumentPositionParams,
  CompletionItem,
  CompletionItemKind,
  CompletionParams,
  Hover,
  MarkupKind,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  Location,
  Range,
  SymbolInformation,
  SymbolKind,
  WorkspaceSymbolParams,
  ReferenceParams,
  InsertTextFormat,
  DocumentSymbol,
  DocumentSymbolParams,
  WorkspaceEdit,
  TextEdit,
  RenameParams,
  InlayHint,
  InlayHintParams,
  InlayHintKind,
  CodeAction,
  CodeActionParams,
  CodeActionKind,
  SemanticTokensBuilder,
  SemanticTokensParams,
  CodeLens,
  CodeLensParams,
  FoldingRange,
  SelectionRange,
  SelectionRangeParams,
  DocumentDiagnosticReportKind,
  DocumentDiagnosticReport,
  DocumentDiagnosticParams,
  WorkspaceDiagnosticReport,
  WorkspaceDiagnosticParams,
  WorkspaceDocumentDiagnosticReport,
} from 'vscode-languageserver/node';
import {
  TypeHierarchyItem,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
} from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments<TextDocument>(TextDocument);

// Client-capability flags captured at initialize (drive live-diagnostics behaviour).
let clientDiagRefreshSupport = false;

// ── Keyword table ─────────────────────────────────────────────────────────────

interface KwDoc { detail: string; doc: string; }

const KEYWORDS: Record<string, KwDoc> = {
  ScriptName:  { detail: 'ScriptName <Name> [extends <Type>] [flags]', doc: 'Declares the script name. Must be the first non-comment statement in every `.psc` file.' },
  extends:     { detail: 'extends <ParentType>', doc: 'Specifies the parent script type to inherit from.' },
  Import:      { detail: 'Import <ScriptName>', doc: 'Imports a script namespace so its global functions can be called without the type prefix.' },
  Function:    { detail: 'Function <Name>([params]) [Native] [Global]', doc: 'Declares a function. Ends with `EndFunction`.' },
  EndFunction: { detail: 'EndFunction', doc: 'Closes a `Function` block.' },
  Event:       { detail: 'Event <Name>([params])', doc: 'Declares an event handler. Ends with `EndEvent`.' },
  EndEvent:    { detail: 'EndEvent', doc: 'Closes an `Event` block.' },
  Property:    { detail: '<Type> Property <Name> [= value] Auto|AutoReadOnly', doc: 'Declares a property. `Auto` generates get/set. Full property (with explicit get/set) needs `EndProperty`.' },
  EndProperty: { detail: 'EndProperty', doc: 'Closes a full `Property` block.' },
  State:       { detail: '[Auto] State <Name>', doc: 'Declares a named state. Events and functions inside override default behaviour. Ends with `EndState`.' },
  EndState:    { detail: 'EndState', doc: 'Closes a `State` block.' },
  Auto:        { detail: 'Auto State <Name>', doc: 'Marks the initial/default state of the script.' },
  Struct:      { detail: 'Struct <Name>', doc: 'Declares a struct (value type). Ends with `EndStruct`.' },
  EndStruct:   { detail: 'EndStruct', doc: 'Closes a `Struct` block.' },
  Group:       { detail: 'Group <Name>', doc: 'Groups properties together for the Creation Kit editor. Ends with `EndGroup`.' },
  EndGroup:    { detail: 'EndGroup', doc: 'Closes a `Group` block.' },
  CustomEvent: { detail: 'CustomEvent <Name>', doc: 'Declares a custom event other scripts can listen to via `RegisterForCustomEvent`.' },
  Guard:       { detail: 'Guard <Name>', doc: '(Starfield) Declares a guard for thread-safe state management.' },
  EndGuard:    { detail: 'EndGuard', doc: 'Closes a `Guard` block.' },
  If:          { detail: 'If <condition>', doc: 'Conditional branch. Ends with `EndIf`.' },
  ElseIf:      { detail: 'ElseIf <condition>', doc: 'Alternative conditional branch inside an `If` block.' },
  Else:        { detail: 'Else', doc: 'Default branch of an `If`/`ElseIf` chain.' },
  EndIf:       { detail: 'EndIf', doc: 'Closes an `If` block.' },
  While:       { detail: 'While <condition>', doc: 'Loops while condition is true. Ends with `EndWhile`.' },
  EndWhile:    { detail: 'EndWhile', doc: 'Closes a `While` loop.' },
  Return:      { detail: 'Return [value]', doc: 'Returns from the current function or event.' },
  New:         { detail: 'new <Type>[<size>]', doc: 'Creates a new array.' },
  As:          { detail: '<expr> as <Type>', doc: 'Casts an expression to a type. Returns `None` if cast fails.' },
  Is:          { detail: '<expr> is <Type>', doc: 'Tests whether an expression is an instance of a type. Returns `bool`.' },
  None:        { detail: 'None', doc: 'The null value for object reference types.' },
  true:        { detail: 'true', doc: 'Boolean literal `true`.' },
  false:       { detail: 'false', doc: 'Boolean literal `false`.' },
  Self:        { detail: 'Self', doc: 'Reference to the current script instance.' },
  Parent:      { detail: 'Parent', doc: 'Reference to the parent script. Used to call overridden functions: `Parent.OnInit()`.' },
  int:         { detail: 'int', doc: '32-bit signed integer.' },
  float:       { detail: 'float', doc: 'Single-precision floating point.' },
  bool:        { detail: 'bool', doc: 'Boolean type (`true` / `false`).' },
  string:      { detail: 'string', doc: 'Immutable text string.' },
  var:         { detail: 'var', doc: 'Dynamic type — can hold any value.' },
};

const FLAGS = [
  'Conditional', 'Default', 'Hidden', 'Native', 'Global', 'Const',
  'DebugOnly', 'BetaOnly', 'AutoReadOnly', 'Mandatory', 'CollapseOnRef', 'CollapseOnBase',
];

// Built-in types — base game + Starfield-specific
const BUILTIN_TYPES = [
  'Actor', 'ActorBase', 'Activator', 'ActiveMagicEffect', 'Alias', 'Ammunition',
  'Armor', 'ArmorAddon', 'Book', 'Cell', 'Container', 'Door', 'EffectShader',
  'EncounterZone', 'Explosion', 'Faction', 'Flora', 'Form', 'FormList',
  'Furniture', 'GlobalVariable', 'Hazard', 'Idle', 'ImageSpaceModifier',
  'Ingredient', 'Keyword', 'LeveledActor', 'LeveledItem', 'Light', 'Location',
  'LocationAlias', 'MagicEffect', 'Message', 'MiscObject', 'MoveableStatic',
  'Music', 'MusicType', 'NPC', 'ObjectReference', 'Outfit', 'Package', 'Perk',
  'Potion', 'Projectile', 'Quest', 'Race', 'ReferenceAlias', 'Scene', 'Scroll',
  'Shout', 'SoulGem', 'Sound', 'SoundCategory', 'SoundDescriptor', 'Spell',
  'Static', 'TalkingActivator', 'TextureSet', 'Topic', 'TopicInfo', 'VisualEffect',
  'VoiceType', 'Weapon', 'Weather', 'WordOfPower', 'WorldSpace', 'WwiseEvent',
  // Starfield-specific
  'SpaceshipBase', 'SpaceshipReference', 'Biome', 'Resource', 'Planet',
  'SolarSystem', 'ResearchProject', 'GameplayOption',
];

interface GlobalNS { label: string; detail: string; doc: string; }
const BUILTIN_GLOBALS: GlobalNS[] = [
  { label: 'Debug',      detail: 'Debug (global)',     doc: '`Debug.Trace(msg)`, `Debug.Notification(msg)`, `Debug.MessageBox(msg)`, `Debug.TraceUser(id, msg)`' },
  { label: 'Game',       detail: 'Game (global)',       doc: '`Game.GetPlayer()`, `Game.GetForm(id)`, `Game.GetCredits()`, `Game.SetInChargen(b)`, `Game.FastTravel(ref)`' },
  { label: 'Utility',    detail: 'Utility (global)',    doc: '`Utility.Wait(sec)`, `Utility.WaitMenuMode(sec)`, `Utility.RandomInt(min,max)`, `Utility.RandomFloat(min,max)`, `Utility.GetCurrentGameTime()`' },
  { label: 'Math',       detail: 'Math (global)',       doc: '`Math.Abs(n)`, `Math.Sqrt(n)`, `Math.Floor(n)`, `Math.Ceiling(n)`, `Math.Round(n)`, `Math.Sin(deg)`, `Math.Cos(deg)`, `Math.Log(n)`' },
  { label: 'StringUtil', detail: 'StringUtil (global)', doc: '`StringUtil.Substring(s,i,n)`, `StringUtil.Find(s,sub)`, `StringUtil.ToInt(s)`, `StringUtil.ToFloat(s)`, `StringUtil.GetLength(s)`' },
  { label: 'Input',      detail: 'Input (global)',      doc: '`Input.GetMappedKey(name)`, `Input.IsKeyPressed(key)`, `Input.TapKey(key)`' },
  { label: 'UI',         detail: 'UI (global)',         doc: '`UI.IsMenuOpen(name)`, `UI.CloseMenu(name)`, `UI.OpenCustomMenu(path)`' },
];

// ── Starfield events with real signatures (from mod source analysis) ──────────

interface EventDoc { sig: string; doc: string; base?: string; }
const STARFIELD_EVENTS: EventDoc[] = [
  // Quest
  { sig: 'Event OnQuestInit()',                                         base: 'Quest',           doc: 'Fires when the quest is first initialized.' },
  { sig: 'Event OnQuestStarted()',                                      base: 'Quest',           doc: 'Fires when the quest stage is set and the quest begins.' },
  { sig: 'Event OnQuestShutdown()',                                     base: 'Quest',           doc: 'Fires when the quest ends.' },
  { sig: 'Event OnTimer(int aiTimerID)',                                base: 'Quest',           doc: 'Fires when a `StartTimer(id)` expires.' },
  { sig: 'Event OnGameplayOptionChanged(GameplayOption[] aChangedOptions)', base: 'Quest',      doc: 'Fires when a tracked gameplay option is changed by the player.' },
  // Alias / ReferenceAlias
  { sig: 'Event OnAliasInit()',                                         base: 'ReferenceAlias', doc: 'Fires when the alias is filled.' },
  { sig: 'Event OnAliasReset()',                                        base: 'ReferenceAlias', doc: 'Fires when the alias is cleared.' },
  { sig: 'Event OnAliasShutdown()',                                     base: 'ReferenceAlias', doc: 'Fires when the parent quest ends.' },
  { sig: 'Event OnPlayerLoadGame()',                                    base: 'ReferenceAlias', doc: 'Fires each time the player loads a saved game.' },
  // ObjectReference / Actor
  { sig: 'Event OnActivate(ObjectReference akActionRef)',               base: 'ObjectReference',doc: 'Fires when this reference is activated.' },
  { sig: 'Event OnInit()',                                              base: 'ObjectReference',doc: 'Fires when the reference is first created/loaded.' },
  { sig: 'Event OnLoad()',                                              base: 'ObjectReference',doc: 'Fires when the reference enters the loaded area.' },
  { sig: 'Event OnUnload()',                                            base: 'ObjectReference',doc: 'Fires when the reference leaves the loaded area.' },
  { sig: 'Event OnDeath(Actor akKiller)',                               base: 'Actor',          doc: 'Fires when this actor dies.' },
  { sig: 'Event OnKill(Actor akVictim)',                                base: 'Actor',          doc: 'Fires when this actor kills another.' },
  { sig: 'Event OnCombatStateChanged(Actor akTarget, int aiCombatState)', base: 'Actor',       doc: 'Fires when this actor enters or leaves combat.' },
  { sig: 'Event OnSit(ObjectReference akFurniture)',                    base: 'Actor',          doc: 'Fires when this actor sits in furniture.' },
  { sig: 'Event OnGetUp(ObjectReference akFurniture)',                  base: 'Actor',          doc: 'Fires when this actor gets up from furniture.' },
  { sig: 'Event OnLocationChange(Location akOldLoc, Location akNewLoc)', base: 'Actor',        doc: 'Fires when this actor moves into a new location.' },
  // Remote events (cross-script)
  { sig: 'Event Actor.OnLocationChange(Actor akSender, Location akOldLoc, Location akNewLoc)', doc: 'Remote event — register via `RegisterForRemoteEvent(ref, "OnLocationChange")`.' },
  { sig: 'Event Actor.OnDeath(Actor akSender, Actor akKiller)',         doc: 'Remote event — register via `RegisterForRemoteEvent(actor, "OnDeath")`.' },
  // Workshop / Outpost
  { sig: 'Event OnWorkshopObjectRemoved(ObjectReference akReference)',  doc: 'Fires when a workshop object is removed in an outpost.' },
  { sig: 'Event OnWorkshopObjectPlaced(ObjectReference akReference)',   doc: 'Fires when a workshop object is placed in an outpost.' },
  // Magic / Effects
  { sig: 'Event OnEffectStart(ObjectReference akTarget, Actor akCaster, MagicEffect akBaseEffect, float afMagnitude, float afDuration)', base: 'ActiveMagicEffect', doc: 'Fires when this magic effect begins.' },
  { sig: 'Event OnEffectFinish(ObjectReference akTarget, Actor akCaster, MagicEffect akBaseEffect, float afMagnitude, float afDuration)', base: 'ActiveMagicEffect', doc: 'Fires when this magic effect ends.' },
  // Book / Misc
  { sig: 'Event OnRead()',                                              base: 'ObjectReference',doc: 'Fires when this book reference is read by the player.' },
  // Container
  { sig: 'Event OnItemAdded(Form akBaseItem, int aiItemCount, ObjectReference akItemReference, ObjectReference akSourceContainer)',    doc: 'Fires when an item is added to this container.' },
  { sig: 'Event OnItemRemoved(Form akBaseItem, int aiItemCount, ObjectReference akItemReference, ObjectReference akDestContainer)',    doc: 'Fires when an item is removed from this container.' },
];

// ── Array intrinsic methods & property ────────────────────────────────────────
// These are hardcoded in PapyrusCompiler.exe — they never appear in .psc files
// and therefore never enter scripts-db.json. 'E' is the placeholder for the
// array's element type; it is substituted at display / signature-help time.

interface ArrayIntrinsic {
  kind: 'method' | 'property';
  sig: string;    // signature with 'E' as element-type placeholder
  ret: string;    // return type ('int', 'none', 'E', 'E[]')
  doc: string;
}

const ARRAY_INTRINSICS: Record<string, ArrayIntrinsic> = {
  find:                  { kind: 'method',   sig: 'int Find(E akElement, int aiStartIndex = 0)',                                                   ret: 'int',  doc: 'Returns the first index of `akElement` in the array, or `-1` if not found.' },
  rfind:                 { kind: 'method',   sig: 'int RFind(E akElement, int aiStartIndex = -1)',                                                 ret: 'int',  doc: 'Returns the last index of `akElement` searching backwards, or `-1` if not found.' },
  findstruct:            { kind: 'method',   sig: 'int FindStruct(string asVarName, E akElement, int aiStartIndex = 0)',                           ret: 'int',  doc: 'Returns the first index where the struct field named `asVarName` equals `akElement`, or `-1`.' },
  rfindstruct:           { kind: 'method',   sig: 'int RFindStruct(string asVarName, E akElement, int aiStartIndex = -1)',                         ret: 'int',  doc: 'Returns the last index where the struct field named `asVarName` equals `akElement` searching backwards, or `-1`.' },
  getallmatchingstructs: { kind: 'method',   sig: 'E[] GetAllMatchingStructs(string asVarName, E akElement, int aiStartIndex = 0, int aiEndIndex = -1)', ret: 'E[]', doc: 'Returns a new array of all elements where the struct field named `asVarName` equals `akElement`.' },
  add:                   { kind: 'method',   sig: 'void Add(E akElement, int aiCount = 1)',                                                        ret: 'none', doc: 'Appends `aiCount` copies of `akElement` to the end of the array.' },
  insert:                { kind: 'method',   sig: 'void Insert(E akElement, int aiLocation)',                                                      ret: 'none', doc: 'Inserts `akElement` at index `aiLocation`, shifting all subsequent elements right.' },
  remove:                { kind: 'method',   sig: 'void Remove(int aiLocation, int aiCount = 1)',                                                  ret: 'none', doc: 'Removes `aiCount` elements starting at `aiLocation`.' },
  removelast:            { kind: 'method',   sig: 'void RemoveLast()',                                                                             ret: 'none', doc: 'Removes the last element from the array.' },
  clear:                 { kind: 'method',   sig: 'void Clear()',                                                                                  ret: 'none', doc: 'Removes all elements from the array.' },
  length:                { kind: 'property', sig: 'int Length',                                                                                    ret: 'int',  doc: 'The number of elements currently in the array. Read-only.' },
};

/** Substitute the element-type placeholder `E` with the actual element type. */
function resolveArraySig(sig: string, elemType: string): string {
  const display = elemType.charAt(0).toUpperCase() + elemType.slice(1);
  return sig.replace(/\bE\[\]/g, `${display}[]`).replace(/\bE\b/g, display);
}

// ── Script database (populated by scanning .psc dirs at startup) ─────────────

type AccessLevel = 'private' | 'protected' | 'internal';

interface FuncAccessEntry {
  access?:    AccessLevel;
  selfOnly?:  boolean;
  debugOnly?: boolean;
  betaOnly?:  boolean;
}

interface ScriptInfo {
  name: string;
  extendsType: string | null;
  functions: string[];
  events: string[];
  properties: Array<{ type: string; name: string; readonly?: boolean; access?: AccessLevel; selfOnly?: boolean }>;
  structs:    Array<{ name: string; fields: Array<{ type: string; name: string }> }>;
  globals:      string[]; // names of Global functions
  customEvents: string[]; // CustomEvent declarations
  sourcePath:   string;
  scriptDebugOnly?: boolean; // entire script is DebugOnly
  scriptBetaOnly?:  boolean; // entire script is BetaOnly
  /** funcNameLower → access/compilation flags for non-public or conditional functions */
  funcAccess: Map<string, FuncAccessEntry>;
}

const scriptDb        = new Map<string, ScriptInfo>();
const structDb        = new Map<string, Array<{ type: string; name: string }>>();
/** Reverse index: unqualified struct name → all fully-qualified structDb keys.
 *  Allows resolving bare struct names (e.g. "ParentScriptFunctionParams") returned
 *  by functions or stored as field types, to the canonical "script:struct" key. */
const structNameIndex = new Map<string, string[]>();
const funcDocDb    = new Map<string, string>(); // "scriptname.funcname" → doc
const propDocDb    = new Map<string, string>(); // "scriptname.propname" → doc
const scriptDocDb  = new Map<string, string>(); // "scriptname" → doc
const globalFuncDb = new Map<string, ScriptInfo>(); // funcNameLower → owning script (O(1) lookup)
const eventNameSet = new Set<string>();
const typeMapCache = new Map<string, { version: number; map: Map<string, string> }>();
let   workspaceRoot: string | null = null;

function getInheritanceChain(startName: string): ScriptInfo[] {
  const chain: ScriptInfo[] = [];
  const seen = new Set<string>();
  let cur = scriptDb.get(startName.toLowerCase());
  while (cur && !seen.has(cur.name.toLowerCase())) {
    chain.push(cur);
    seen.add(cur.name.toLowerCase());
    if (!cur.extendsType) break;
    cur = scriptDb.get(cur.extendsType.toLowerCase());
  }
  return chain;
}

const SCRIPTNAME_RE = /^\s*scriptname\s+(\S+)(?:\s+extends\s+(\S+))?/i;
const FUNC_RE       = /^\s*(?:(\w[\w\[\]]*)\s+)?function\s+(\w+)\s*\(([^)]*)\)([^;]*)/i;
const EVENT_RE      = /^\s*event\s+([\w.]+)\s*\(([^)]*)\)/i;
const PROP_RE       = /^\s*([\w\[\]]+)\s+property\s+(\w+)/i;

// ── Type inference for dot completions ────────────────────────────────────────

const PRIMITIVES = new Set(['int', 'float', 'bool', 'string', 'var']);
const STMT_KEYWORDS = new Set([
  'if', 'elseif', 'else', 'endif', 'while', 'endwhile', 'return', 'new', 'as', 'is',
  'none', 'true', 'false', 'function', 'endfunction', 'event', 'endevent',
  'state', 'endstate', 'property', 'endproperty', 'struct', 'endstruct',
  'group', 'endgroup', 'customevent', 'guard', 'endguard', 'import', 'scriptname', 'auto',
]);

function isKnownType(token: string): boolean {
  const base = token.toLowerCase().replace(/\[\]$/, '');
  return PRIMITIVES.has(base) || scriptDb.has(base) ||
         structDb.has(base) || structNameIndex.has(base);
}

/**
 * Normalize a type to its canonical structDb key if it is a struct type.
 * - Already-qualified key (`script:struct`) → returned as-is
 * - Unqualified short name → looks up via structNameIndex, preferring structs
 *   defined on `preferScript`'s inheritance chain when there is ambiguity
 * - Primitives, script types, void, none → returned unchanged
 * Preserves trailing `[]` for array types.
 */
function qualifyStructType(typeLower: string, preferScript?: string): string {
  const isArr = typeLower.endsWith('[]');
  const base  = isArr ? typeLower.slice(0, -2) : typeLower;
  // Nothing to do for primitives / already-known scripts / already-qualified structs
  if (PRIMITIVES.has(base) || base === 'none' || base === 'void' ||
      scriptDb.has(base) || structDb.has(base)) return typeLower;
  const candidates = structNameIndex.get(base);
  if (!candidates || candidates.length === 0) return typeLower;
  let key = candidates[0];
  if (candidates.length > 1 && preferScript) {
    for (const info of getInheritanceChain(preferScript)) {
      const k = `${info.name.toLowerCase()}:${base}`;
      if (structDb.has(k)) { key = k; break; }
    }
  }
  return isArr ? key + '[]' : key;
}

/** Pull the function name out of a stored signature like "void Foo(int x)" */
function sigToName(sig: string): string {
  const m = /^\S+\s+(\w+)\s*\(/.exec(sig);
  return m ? m[1] : sig;
}

/**
 * Scan the open document and return varName.toLowerCase() → typeName.toLowerCase().
 * Covers: ScriptName (Self/Parent), properties, function/event params, local vars.
 */
/** Join lines ending with \ before parsing */
function joinContinuationLines(lines: string[]): string[] {
  const out: string[] = []; let pending = '';
  for (const ln of lines) {
    if (ln.trimEnd().endsWith('\\')) { pending += ln.trimEnd().slice(0, -1) + ' '; }
    else { out.push(pending + ln); pending = ''; }
  }
  if (pending) out.push(pending);
  return out;
}

function buildTypeMap(doc: TextDocument): Map<string, string> {
  const cached = typeMapCache.get(doc.uri);
  if (cached?.version === doc.version) return cached.map;
  const map = new Map<string, string>();
  for (const raw of joinContinuationLines(doc.getText().split(/\r?\n/))) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;

    const tokens = line.split(/\s+/);
    const t0l = tokens[0].toLowerCase().replace(/\(.*$/, '');

    // ScriptName → Self, Parent, and __state (compiler-injected into every non-global scope)
    if (t0l === 'scriptname' && tokens.length >= 2) {
      map.set('self', tokens[1].toLowerCase());
      const exIdx = tokens.findIndex(t => t.toLowerCase() === 'extends');
      if (exIdx !== -1 && tokens[exIdx + 1])
        map.set('parent', tokens[exIdx + 1].toLowerCase());
      map.set('__state', 'string');
      continue;
    }

    // Property:  `Type Property Name ...`
    if (tokens.length >= 3 && tokens[1].toLowerCase() === 'property' && isKnownType(tokens[0])) {
      map.set(tokens[2].toLowerCase(), tokens[0].toLowerCase()); // preserve [] for arrays
      continue;
    }

    // Function/Event parameters — capture everything inside `(...)`
    const sigMatch = /(?:function|event)\s+[\w.]+\s*\(([^)]*)\)/i.exec(line);
    if (sigMatch && sigMatch[1].trim()) {
      for (const param of sigMatch[1].split(',')) {
        const parts = param.trim().split(/\s+/);
        if (parts.length >= 2 && isKnownType(parts[0])) {
          const pname = parts[1].replace(/=.*$/, '').trim();
          if (pname && /^\w+$/.test(pname))
            map.set(pname.toLowerCase(), parts[0].toLowerCase()); // preserve [] for arrays
        }
      }
      continue;
    }

    // Local variable:  `Type Name [= ...]`
    if (tokens.length >= 2 && !STMT_KEYWORDS.has(t0l) && isKnownType(tokens[0])) {
      const varName = tokens[1].replace(/=.*$/, '').trim();
      if (varName && /^\w+$/.test(varName) && !STMT_KEYWORDS.has(varName.toLowerCase()))
        map.set(varName.toLowerCase(), tokens[0].toLowerCase()); // preserve [] for arrays
    }
  }

  // Conditional type narrowing: `if akTarget is Actor` → treat akTarget as Actor
  for (const raw of joinContinuationLines(doc.getText().split(/\r?\n/))) {
    const line = raw.replace(/;.*$/, '').trim();
    const narrowM = /^(?:elseif\s+)?if\s+(\w+)\s+is\s+([\w]+)/i.exec(line);
    if (narrowM) {
      const varName  = narrowM[1].toLowerCase();
      const typeName = narrowM[2].toLowerCase();
      if (scriptDb.has(typeName) && !PRIMITIVES.has(typeName) && map.has(varName))
        map.set(varName, typeName);
    }
  }

  typeMapCache.set(doc.uri, { version: doc.version, map });
  return map;
}

/**
 * Extract a Papyrus `{...}` docstring starting at lines[startIdx].
 * Allows at most one blank line between the declaration and the `{`.
 * Handles multi-line blocks. Returns trimmed text or undefined.
 */
function readPscDocstring(lines: string[], startIdx: number): string | undefined {
  let i = startIdx;
  if (i < lines.length && lines[i].replace(/;.*$/, '').trim() === '') i++;
  if (i >= lines.length) return undefined;
  const first = lines[i].replace(/;.*$/, '').trim();
  if (!first.startsWith('{')) return undefined;
  const close = first.indexOf('}', 1);
  if (close !== -1) return first.slice(1, close).trim() || undefined;
  const parts: string[] = [first.slice(1).trim()];
  for (let j = i + 1; j < lines.length; j++) {
    const ln = lines[j];
    const ci = ln.indexOf('}');
    if (ci !== -1) { parts.push(ln.slice(0, ci).trim()); break; }
    parts.push(ln.trim());
  }
  return parts.filter(Boolean).join('\n') || undefined;
}

/** Parse an open document and upsert it into scriptDb/structDb so other files see it immediately. */
function indexDocument(doc: TextDocument): void {
  typeMapCache.delete(doc.uri);
  const filePath = doc.uri.replace(/^file:\/\//, '');
  const lines    = joinContinuationLines(doc.getText().split(/\r?\n/));
  const len      = lines.length;
  let sname: string | null = null, extendsType: string | null = null;
  let scriptDebugOnly = false, scriptBetaOnly = false;
  const functions: string[] = [], events: string[] = [], properties: Array<{ type: string; name: string; readonly?: boolean }> = [];
  const structs:   Array<{ name: string; fields: Array<{ type: string; name: string }> }> = [];
  const globals:   string[] = [], customEvents: string[] = [];
  const funcAccessMap = new Map<string, FuncAccessEntry>();
  let inStruct: string | null = null, structFields: Array<{ type: string; name: string }> = [];
  const ENDSTRUCT_RE_L = /^\s*endstruct\b/i;
  const STRUCT_RE_L    = /^\s*struct\s+(\w+)/i;
  for (let i = 0; i < len; i++) {
    const raw  = lines[i];
    const line = raw.replace(/;.*$/, '').trim();
    if (!line || line.startsWith('{')) continue;
    if (!sname) {
      const m = SCRIPTNAME_RE.exec(line);
      if (m) {
        sname = m[1]; extendsType = m[2] ?? null;
        const d = readPscDocstring(lines, i + 1);
        if (d) scriptDocDb.set(sname.toLowerCase(), d);
        // Capture script-level conditional compilation flags
        scriptDebugOnly = /\bDebugOnly\b/i.test(line);
        scriptBetaOnly  = /\bBetaOnly\b/i.test(line);
        continue;
      }
    }
    if (inStruct) {
      if (ENDSTRUCT_RE_L.test(line)) { structs.push({ name: inStruct, fields: structFields }); inStruct = null; structFields = []; }
      else {
        const tokens = line.split(/\s+/);
        if (tokens.length >= 2) { const fn = tokens[1].replace(/=.*$/, '').trim(); if (fn && /^\w+$/.test(fn)) structFields.push({ type: tokens[0], name: fn }); }
      }
      continue;
    }
    const ceM = /^\s*customevent\s+(\w+)/i.exec(line);
    if (ceM) { customEvents.push(ceM[1]); continue; }
    const sm = STRUCT_RE_L.exec(line); if (sm) { inStruct = sm[1]; structFields = []; continue; }
    const fm = FUNC_RE.exec(line);
    if (fm) {
      functions.push(`${fm[1] ?? 'void'} ${fm[2]}(${(fm[3] ?? '').trim()})`);
      const flags4 = (fm[4] ?? '').toLowerCase();
      if (flags4.includes('global')) globals.push(fm[2].toLowerCase());
      // Capture per-function conditional compilation flags
      const fDebug = /\bdebugonly\b/.test(flags4);
      const fBeta  = /\bbetaonly\b/.test(flags4);
      const fAccess = /\bprivate\b/.test(flags4) ? 'private' as AccessLevel
                    : /\bprotected\b/.test(flags4) ? 'protected' as AccessLevel
                    : /\binternal\b/.test(flags4) ? 'internal' as AccessLevel
                    : undefined;
      const fSelfOnly = /\bselfonly\b/.test(flags4);
      if (fAccess || fSelfOnly || fDebug || fBeta)
        funcAccessMap.set(fm[2].toLowerCase(), { access: fAccess, selfOnly: fSelfOnly, debugOnly: fDebug, betaOnly: fBeta });
      if (sname) {
        const d = readPscDocstring(lines, i + 1);
        if (d) funcDocDb.set(`${sname.toLowerCase()}.${fm[2].toLowerCase()}`, d);
      }
      continue;
    }
    const em = EVENT_RE.exec(line);
    if (em) {
      events.push(`Event ${em[1]}(${(em[2] ?? '').trim()})`);
      if (sname) {
        const d = readPscDocstring(lines, i + 1);
        if (d) funcDocDb.set(`${sname.toLowerCase()}.${em[1].toLowerCase()}`, d);
      }
      continue;
    }
    const pm = PROP_RE.exec(line);
    if (pm) {
      properties.push({ type: pm[1], name: pm[2], readonly: /\bautoreadonly\b/i.test(line) });
      if (sname) {
        const d = readPscDocstring(lines, i + 1);
        if (d) propDocDb.set(`${sname.toLowerCase()}.${pm[2].toLowerCase()}`, d);
      }
    }
  }
  if (sname) {
    const key = sname.toLowerCase();
    scriptDb.set(key, { name: sname, extendsType: extendsType ?? null, functions, events, properties, structs, globals, customEvents, sourcePath: filePath, scriptDebugOnly, scriptBetaOnly, funcAccess: funcAccessMap });
    for (const struct of structs) structDb.set(`${key}:${struct.name.toLowerCase()}`, struct.fields);
    for (const ce of customEvents) eventNameSet.add(ce);
    for (const g of globals) { if (!globalFuncDb.has(g)) globalFuncDb.set(g, scriptDb.get(key)!); }
  }
}

// ── Runtime configuration ─────────────────────────────────────────────────────
//
// The server is self-contained: the vanilla script sources, the Papyrus compiler,
// and the flags file all ship under INSTALL_ROOT. No Creation Kit, game install,
// or editor extension is required. Each setting resolves independently, first
// hit wins:
//
//   1. `.papyrus-lsp.json` — searched from the workspace root upward
//   2. PAPYRUS_LSP_* environment variables
//   3. A game install, when one is named via `gameRoot`
//   4. The copies bundled with this install
//
// A configured path that doesn't exist is dropped rather than honoured, so a
// stale entry degrades to the bundled default instead of silently disabling the
// compiler — which is what a dangling `flagsFile` used to do.

const INSTALL_ROOT      = path.join(__dirname, '..');
const BUNDLED_VANILLA   = path.join(INSTALL_ROOT, '_vanilla-sf-scripts', 'Scripts', 'Source');
const BUNDLED_COMPILER  = path.join(INSTALL_ROOT, '_vanilla-sf-scripts', 'bin', 'PapyrusCompiler', 'PapyrusCompiler.exe');
const BUNDLED_FLAGS     = path.join(BUNDLED_VANILLA, 'Starfield_Papyrus_Flags.flg');
const MOD_EXTENDERS_DIR = path.join(INSTALL_ROOT, 'mod-extenders');
const SCRIPTS_DB_PATH   = path.join(INSTALL_ROOT, 'scripts-db.json');
const FLAGS_BASENAME    = 'Starfield_Papyrus_Flags.flg';

const exists = (p: string | null | undefined): p is string => !!p && fs.existsSync(p);

/** First path in `cands` that exists on disk, or null. */
function firstExisting(...cands: Array<string | null | undefined>): string | null {
  for (const c of cands) if (exists(c)) return c;
  return null;
}

/** Expand a leading `~`, then resolve a relative path against `base`. */
function resolvePath(p: string, base: string): string {
  const raw = p.trim();
  const expanded = (raw === '~' || raw.startsWith('~/')) ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
}

/** Does this directory supply the base game types? Cheap proxy: ScriptObject, the root of
 *  every Papyrus inheritance chain. Case-insensitive — .psc casing varies across dumps. */
function suppliesBaseTypes(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some(f => f.toLowerCase() === 'scriptobject.psc');
  } catch { return false; }
}

interface PapyrusConfig {
  scanDirs: string[];
  compilerExe: string | null;
  flagsFile: string | null;
}

const cfg: PapyrusConfig = {
  scanDirs:    [BUNDLED_VANILLA].filter(exists),
  compilerExe: firstExisting(BUNDLED_COMPILER),
  flagsFile:   firstExisting(BUNDLED_FLAGS),
};

/** Nearest `.papyrus-lsp.json` at `startDir` or any ancestor. */
function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.papyrus-lsp.json');
    if (exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Populate `cfg` from config file → env → gameRoot → bundled defaults.
 *  `root` is the workspace root, or null when the client sent none. */
function resolveConfig(root: string | null): void {
  let file: Record<string, unknown> = {};
  // Paths inside a config file are relative to that file, not to the cwd.
  let base = root ?? INSTALL_ROOT;

  const cfgFile = root ? findConfigFile(root) : null;
  if (cfgFile) {
    try {
      file = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
      base = path.dirname(cfgFile);
      connection.console.log(`[papyrus-lsp] config: ${cfgFile}`);
    } catch (err) {
      connection.console.warn(`[papyrus-lsp] ignoring unparsable ${cfgFile}: ${err}`);
      file = {};
    }
  }

  const env = process.env;
  const fromFile = (key: string): string | null =>
    typeof file[key] === 'string' ? resolvePath(file[key] as string, base) : null;
  const fromEnv = (key: string): string | null =>
    env[key] ? resolvePath(env[key]!, base) : null;

  // A game install we can derive the stock layout from.
  const gameRoot     = firstExisting(fromFile('gameRoot'), fromEnv('PAPYRUS_LSP_GAME_ROOT'));
  const gameSrc      = gameRoot ? path.join(gameRoot, 'Data', 'Scripts', 'Source') : null;
  const gameCompiler = gameRoot ? path.join(gameRoot, 'Tools', 'Papyrus Compiler', 'PapyrusCompiler.exe') : null;

  // ── import dirs ──
  const requested: string[] =
    Array.isArray(file.importDirs) ? (file.importDirs as unknown[]).map(d => resolvePath(String(d), base))
    : env.PAPYRUS_LSP_IMPORTS      ? env.PAPYRUS_LSP_IMPORTS.split(path.delimiter).filter(Boolean).map(d => resolvePath(d, base))
    : [gameSrc, BUNDLED_VANILLA].filter((d): d is string => !!d);

  const dirs: string[] = [];
  const add = (d: string | null | undefined) => { if (exists(d) && !dirs.includes(d)) dirs.push(d); };

  for (const d of requested) {
    if (exists(d)) add(d);
    else connection.console.warn(`[papyrus-lsp] import dir not found, skipping: ${d}`);
  }
  add(root);              // the workspace's own scripts are always importable
  add(MOD_EXTENDERS_DIR); // and so are the bundled extender stubs
  // Guarantee the base game types resolve. Only appended when nothing else supplies
  // them, so a user pointing at their own vanilla dump doesn't get it twice.
  if (!dirs.some(suppliesBaseTypes)) add(BUNDLED_VANILLA);
  cfg.scanDirs = dirs;

  cfg.compilerExe = firstExisting(
    fromFile('compilerPath'), fromEnv('PAPYRUS_LSP_COMPILER'), gameCompiler, BUNDLED_COMPILER,
  );

  // The flags file normally sits alongside the sources it governs, so prefer a copy
  // from the import dirs before falling back to the bundled one.
  cfg.flagsFile = firstExisting(
    fromFile('flagsFile'), fromEnv('PAPYRUS_LSP_FLAGS'),
    ...cfg.scanDirs.map(d => path.join(d, FLAGS_BASENAME)),
    BUNDLED_FLAGS,
  );

  refreshCompilerReady();
}

// ── Compiler runner ───────────────────────────────────────────────────────────
//
// PapyrusCompiler.exe is a .NET assembly: it runs natively on Windows and needs a
// CLR shim everywhere else. Resolved once — it cannot change while we run.

const monoExe: string | null = (() => {
  if (process.platform === 'win32') return null; // runs natively, no shim
  const override = process.env.PAPYRUS_LSP_MONO;
  if (override) return exists(override) ? override : null;
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    return execSync('command -v mono', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
})();

/** True when compiler-augmented diagnostics can actually run. */
let compilerReady = false;
function refreshCompilerReady(): void {
  compilerReady = !!(cfg.compilerExe && cfg.flagsFile && (process.platform === 'win32' || monoExe));
}

/** Build the argv for a compiler run, or null if it can't be run on this machine. */
function compilerArgv(args: string[]): { cmd: string; argv: string[] } | null {
  if (!compilerReady || !cfg.compilerExe) return null;
  return process.platform === 'win32'
    ? { cmd: cfg.compilerExe, argv: args }
    : { cmd: monoExe!, argv: [cfg.compilerExe, ...args] };
}

// ── Papyrus block-structure parser ────────────────────────────────────────────

interface RawDiag {
  line: number; startChar: number; endChar: number;
  severity: DiagnosticSeverity; message: string;
}
interface BlockEntry { keyword: string; line: number; col: number; }

function stripLineComment(raw: string): string {
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"' && raw[i - 1] !== '\\') inStr = !inStr;
    if (!inStr && c === ';') return raw.slice(0, i);
  }
  return raw;
}

function parsePapyrus(text: string): RawDiag[] {
  const lines = text.split(/\r?\n/);
  const diags: RawDiag[] = [];
  const stack: BlockEntry[] = [];
  let hasScriptName = false;
  let inBlockComment = false;

  const OPEN_TO_CLOSE: Record<string, string> = {
    function: 'endfunction', event: 'endevent', state: 'endstate',
    struct: 'endstruct', group: 'endgroup', if: 'endif', while: 'endwhile', guard: 'endguard',
  };
  const CLOSERS = new Set(Object.values(OPEN_TO_CLOSE));
  const CLOSE_TO_OPEN: Record<string, string> = Object.fromEntries(
    Object.entries(OPEN_TO_CLOSE).map(([o, c]) => [c, o])
  );
  CLOSE_TO_OPEN['endproperty'] = 'property';

  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];

    // Handle ;/ block comment /;
    if (inBlockComment) {
      const ci = raw.indexOf('/;');
      if (ci !== -1) { inBlockComment = false; raw = raw.slice(ci + 2); }
      else continue;
    }
    const bo = raw.indexOf(';/');
    if (bo !== -1) {
      const bc = raw.indexOf('/;', bo + 2);
      if (bc !== -1) { raw = raw.slice(0, bo) + raw.slice(bc + 2); }
      else { inBlockComment = true; raw = raw.slice(0, bo); }
    }

    const stripped = stripLineComment(raw);
    const trimmed = stripped.trim();
    if (!trimmed) continue;

    const tokens = trimmed.split(/\s+/);
    const t0 = tokens[0];
    // Handle "if(cond)" / "while(cond)" / "elseif(cond)" without a space before "("
    const t0l = (t0.match(/^([a-zA-Z]+)\(/) ? t0.match(/^([a-zA-Z]+)/)![1] : t0).toLowerCase();
    const colStart = stripped.length - stripped.trimStart().length;

    // ScriptName
    if (t0l === 'scriptname') {
      hasScriptName = true;
      if (tokens.length < 2) {
        diags.push({ line: i, startChar: colStart, endChar: colStart + t0.length,
          severity: DiagnosticSeverity.Error, message: 'ScriptName requires a name argument.' });
      }
      continue;
    }

    if (t0l === 'import') continue;

    // "Auto State"
    if (t0l === 'auto' && tokens.length > 1 && tokens[1].toLowerCase() === 'state') {
      stack.push({ keyword: 'state', line: i, col: colStart }); continue;
    }

    // EndProperty
    if (t0l === 'endproperty') {
      handleCloser('endproperty', 'property', t0, i, colStart, trimmed.length, stack, diags); continue;
    }

    // "<Type> Property <Name> ..." — push only if not Auto / AutoReadOnly
    if (tokens.length >= 3 && tokens[1].toLowerCase() === 'property') {
      // Auto and AutoReadOnly are simple properties (no EndProperty needed)
      if (!/\bauto\b/i.test(trimmed) && !/\bautoreadonly\b/i.test(trimmed))
        stack.push({ keyword: 'property', line: i, col: colStart });
      continue;
    }

    // Bare openers: Function, Event, State, Struct, Group, If, While, Guard
    if (OPEN_TO_CLOSE[t0l]) {
      // Native functions are single-line declarations — no EndFunction
      if (t0l === 'function' && /\bnative\b/i.test(trimmed)) continue;
      stack.push({ keyword: t0l, line: i, col: colStart }); continue;
    }

    // Typed openers: "float Function Foo()", "int Function Bar()", etc.
    if (tokens.length >= 2 && OPEN_TO_CLOSE[tokens[1].toLowerCase()]) {
      const kw = tokens[1].toLowerCase();
      // Native functions have no body
      if (kw === 'function' && /\bnative\b/i.test(trimmed)) continue;
      stack.push({ keyword: kw, line: i, col: colStart }); continue;
    }

    // Closers
    if (CLOSERS.has(t0l)) {
      handleCloser(t0l, CLOSE_TO_OPEN[t0l], t0, i, colStart, trimmed.length, stack, diags); continue;
    }

    // ElseIf / Else must be inside If
    if (t0l === 'elseif' || t0l === 'else') {
      const top = stack.length ? stack[stack.length - 1] : null;
      if (!top || top.keyword !== 'if') {
        diags.push({ line: i, startChar: colStart, endChar: colStart + t0.length,
          severity: DiagnosticSeverity.Error, message: `'${t0}' used outside of an If block.` });
      }
      continue;
    }
  }

  // Unclosed blocks
  for (const entry of stack) {
    const closer = 'End' + entry.keyword[0].toUpperCase() + entry.keyword.slice(1);
    diags.push({ line: entry.line, startChar: entry.col,
      endChar: entry.col + (lines[entry.line]?.trimStart().length ?? 1),
      severity: DiagnosticSeverity.Error,
      message: `Unclosed '${entry.keyword}' — missing '${closer}'.` });
  }

  if (!hasScriptName && text.trim().length > 0) {
    diags.push({ line: 0, startChar: 0, endChar: 0,
      severity: DiagnosticSeverity.Warning, message: 'Papyrus script is missing a ScriptName declaration.' });
  }

  return diags;
}

function handleCloser(
  closerL: string, expectedOpen: string, origToken: string,
  line: number, col: number, tokenLen: number,
  stack: BlockEntry[], diags: RawDiag[],
): void {
  if (!stack.length) {
    diags.push({ line, startChar: col, endChar: col + tokenLen,
      severity: DiagnosticSeverity.Error, message: `'${origToken}' has no matching opening '${expectedOpen}'.` });
    return;
  }
  const top = stack[stack.length - 1];
  if (top.keyword !== expectedOpen) {
    diags.push({ line, startChar: col, endChar: col + tokenLen,
      severity: DiagnosticSeverity.Error,
      message: `'${origToken}' closes '${expectedOpen}' but the open block is '${top.keyword}' (line ${top.line + 1}).` });
  } else {
    stack.pop();
  }
}

/** Warn when a non-void function has no Return statement anywhere in its body. */
function checkMissingReturns(text: string): RawDiag[] {
  const diags: RawDiag[] = [];
  const lines = text.split(/\r?\n/);
  interface FuncFrame { line: number; col: number; retType: string; hasReturn: boolean; }
  const stack: FuncFrame[] = [];

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/;.*$/, '').trim();
    if (!stripped) continue;
    const col = lines[i].length - lines[i].trimStart().length;

    const fm = FUNC_RE.exec(stripped);
    if (fm) {
      const retType = (fm[1] ?? 'void').toLowerCase();
      const isNative = /\bnative\b/i.test(stripped);
      if (!isNative && retType !== 'void') {
        stack.push({ line: i, col, retType: fm[1] ?? 'void', hasReturn: false });
      }
      continue;
    }

    if (/^endfunction\b/i.test(stripped) && stack.length > 0) {
      const frame = stack.pop()!;
      if (!frame.hasReturn) {
        diags.push({
          line: frame.line, startChar: frame.col,
          endChar: frame.col + lines[frame.line].trimStart().length,
          severity: DiagnosticSeverity.Warning,
          message: `Non-void function (returns '${frame.retType}') has no Return statement.`,
        });
      }
      continue;
    }

    if (/^return\b/i.test(stripped) && stack.length > 0)
      stack[stack.length - 1].hasReturn = true;
  }
  return diags;
}

/** Warn when a clearly primitive value is assigned to an object-type variable or vice-versa. */
/**
 * Returns true when rhsType can be implicitly assigned to lhsType in Papyrus.
 *
 * Legal implicit coercions (compiler allows without a cast):
 *   - identical types (case-insensitive)
 *   - var on either side (wildcard)
 *   - none → any reference/array/struct (null assignment)
 *   - any type → bool  (non-zero / non-null treated as true)
 *   - any type → string (toString coercion)
 *   - int → float (widening)
 *   - child → parent (inheritance, object types only)
 */
function isImplicitlyAssignable(lhsType: string, rhsType: string): boolean {
  const lhs = lhsType.toLowerCase();
  const rhs = rhsType.toLowerCase();
  if (lhs === rhs) return true;
  if (lhs === 'var' || rhs === 'var') return true;
  if (rhs === 'none') return !PRIMITIVES.has(lhs.replace(/\[\]$/, ''));
  if (lhs === 'bool' || lhs === 'string') return true;
  if (lhs === 'float' && rhs === 'int') return true;
  // child → parent: both must be non-primitive, non-array script types
  if (!lhs.endsWith('[]') && !rhs.endsWith('[]') &&
      !PRIMITIVES.has(lhs) && !PRIMITIVES.has(rhs)) {
    for (const info of getInheritanceChain(rhs)) {
      if (info.name.toLowerCase() === lhs) return true;
    }
  }
  return false;
}

function checkTypeMismatch(doc: TextDocument): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const typeMap = buildTypeMap(doc);
  const lines   = doc.getText().split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/;.*$/, '').trim();
    if (!stripped) continue;
    const tokens = stripped.split(/\s+/);
    const t0l = tokens[0].toLowerCase().replace(/\[\]$/, '');
    if (tokens.length < 3 || STMT_KEYWORDS.has(t0l) || !isKnownType(tokens[0])) continue;
    // Require `Type Name = rhs` form (skip property / function headers)
    if (tokens[1]?.toLowerCase() === 'property' || tokens[1]?.toLowerCase() === 'function') continue;
    const varName = tokens[1].replace(/=.*$/, '').trim();
    if (!varName || !/^\w+$/.test(varName)) continue;
    const eqIdx = stripped.indexOf('=', tokens[0].length);
    if (eqIdx === -1) continue;
    const rhs = stripped.slice(eqIdx + 1).trim();
    if (!rhs) continue;
    if (/\bas\s+[\w\[\]]+/.test(rhs)) continue; // explicit cast — developer asserts the type
    const rhsType = resolveExprType(rhs, typeMap);
    if (!rhsType) continue;
    if (isImplicitlyAssignable(tokens[0], rhsType)) continue;
    const col = lines[i].indexOf(varName);
    if (col < 0) continue;
    diags.push({
      range: Range.create(i, col, i, col + varName.length),
      severity: DiagnosticSeverity.Warning,
      message: `type mismatch while assigning to a ${tokens[0].toLowerCase()} (cast missing or types unrelated)`,
      source: 'papyrus',
    });
  }
  return diags;
}

/**
 * Returns true when `curLine` is inside a `global` function body.
 * `self` and `parent` are not available in global scope — the compiler rejects them.
 */
function isGlobalScope(doc: TextDocument, curLine: number): boolean {
  const lines = doc.getText().split(/\r?\n/);
  for (let i = curLine; i >= 0; i--) {
    const stripped = lines[i].replace(/;.*$/, '').trim();
    if (!stripped) continue;
    if (/^end(?:function|event)\b/i.test(stripped)) return false;
    const fm = FUNC_RE.exec(stripped);
    if (fm) return /\bglobal\b/i.test(fm[4] ?? '');
    if (EVENT_RE.exec(stripped)) return false;
  }
  return false;
}

/**
 * True when `curLine` is at script body level (not inside any Function/Event block).
 * Scans backward: the first structural line found determines the answer.
 */
function isAtScriptLevel(doc: TextDocument, curLine: number): boolean {
  const lines = doc.getText().split(/\r?\n/);
  for (let i = curLine - 1; i >= 0; i--) {
    const s = lines[i].replace(/;.*$/, '').trim();
    if (!s) continue;
    if (/^end(?:function|event)\b/i.test(s)) return true;
    if (FUNC_RE.test(s) || EVENT_RE.test(s)) return false;
  }
  return true;
}

/**
 * Build override/implement snippet stubs for functions and events from the parent chain.
 * Triggered when the cursor is at script level on a line starting with `Function` or `Event`.
 *
 * The textEdit replaces everything from the first non-whitespace character on the line to
 * the cursor, so the user gets the full declaration including the correct return type.
 */
function buildOverrideStubs(doc: TextDocument, cpParams: CompletionParams): CompletionItem[] {
  const lineUpTo = doc.getText({
    start: { line: cpParams.position.line, character: 0 },
    end:   cpParams.position,
  });

  // Detect Function or Event context at the start of the line
  const fnMatch = /^(\s*)(?:([\w\[\]]+)\s+)?function\s+(\w*)$/i.exec(lineUpTo);
  const evMatch = !fnMatch ? /^(\s*)event\s+(\w*)$/i.exec(lineUpTo) : null;
  if (!fnMatch && !evMatch) return [];

  if (!isAtScriptLevel(doc, cpParams.position.line)) return [];

  const typeMap  = buildTypeMap(doc);
  const selfType = typeMap.get('self');
  if (!selfType) return [];

  const indentLen = fnMatch ? fnMatch[1].length : evMatch![1].length;
  const partial   = ((fnMatch ? fnMatch[3] : evMatch![2]) ?? '').toLowerCase();
  const mode      = fnMatch ? 'function' : 'event';
  const bodyTab   = lineUpTo.slice(0, indentLen) + '\t';

  // Names already defined in this document — don't re-offer them
  const defined = new Set<string>();
  for (const ln of doc.getText().split(/\r?\n/)) {
    const s = ln.replace(/;.*$/, '').trim();
    const fm = FUNC_RE.exec(s); if (fm) defined.add(fm[2].toLowerCase());
    const em = EVENT_RE.exec(s); if (em) defined.add(em[1].split('.').pop()!.toLowerCase());
  }

  // textEdit range: replace from first non-whitespace character to cursor
  const editRange = Range.create(cpParams.position.line, indentLen, cpParams.position.line, cpParams.position.character);

  const items: CompletionItem[] = [];
  const chain = getInheritanceChain(selfType);

  if (mode === 'function') {
    for (let depth = 1; depth < chain.length; depth++) {
      const info = chain[depth];
      for (const sig of info.functions) {
        const fname    = sigToName(sig);
        const fnameLow = fname.toLowerCase();
        if (defined.has(fnameLow)) continue;
        if (partial && !fnameLow.startsWith(partial)) continue;

        const sigM = /^(\S+)\s+\w+\s*\(([^)]*)\)/.exec(sig);
        if (!sigM) continue;
        const retType  = sigM[1];
        const fnParams = sigM[2];
        const retLow   = retType.toLowerCase();
        const isVoid   = retLow === 'void';

        const defRet = retLow === 'bool' ? 'false'
                     : retLow === 'int' || retLow === 'float' ? '0'
                     : retLow === 'string' ? '""' : 'None';

        const body = isVoid
          ? `${fname}(${fnParams})\n${bodyTab}$0\n${lineUpTo.slice(0, indentLen)}EndFunction`
          : `${fname}(${fnParams})\n${bodyTab}Return \${1:${defRet}}\n${lineUpTo.slice(0, indentLen)}EndFunction`;

        const newText = isVoid ? `Function ${body}` : `${retType} Function ${body}`;
        const docNote = funcDocDb.get(`${info.name.toLowerCase()}.${fnameLow}`);

        items.push({
          label: fname,
          kind:  CompletionItemKind.Function,
          detail: `Override · ${sig}`,
          documentation: docNote
            ? { kind: MarkupKind.Markdown, value: docNote }
            : { kind: MarkupKind.PlainText, value: `Inherited from ${info.name}` },
          textEdit: TextEdit.replace(editRange, newText),
          insertTextFormat: InsertTextFormat.Snippet,
          filterText: fname,
          sortText: `1_${String(depth).padStart(3, '0')}_${fnameLow}`,
        });
      }
    }
  } else {
    // Event stubs — chain events + STARFIELD_EVENTS
    const offerSet = new Set<string>();

    for (let depth = 0; depth < chain.length; depth++) {
      const info = chain[depth];
      for (const ev of info.events) {
        const evM = /^Event\s+([\w.]+)\s*\(([^)]*)\)/i.exec(ev);
        if (!evM) continue;
        const evName  = evM[1].split('.').pop()!;
        const evLow   = evName.toLowerCase();
        if (defined.has(evLow) || offerSet.has(evLow)) continue;
        if (partial && !evLow.startsWith(partial)) continue;
        offerSet.add(evLow);

        const evParams = evM[2];
        const newText = `Event ${evName}(${evParams})\n${bodyTab}$0\n${lineUpTo.slice(0, indentLen)}EndEvent`;
        const docNote = funcDocDb.get(`${info.name.toLowerCase()}.${evLow}`);

        items.push({
          label: evName,
          kind:  CompletionItemKind.Event,
          detail: `Event · ${info.name}`,
          documentation: docNote
            ? { kind: MarkupKind.Markdown, value: docNote }
            : { kind: MarkupKind.PlainText, value: `Event from ${info.name}` },
          textEdit: TextEdit.replace(editRange, newText),
          insertTextFormat: InsertTextFormat.Snippet,
          filterText: evName,
          sortText: `1_${String(depth).padStart(3, '0')}_${evLow}`,
        });
      }
    }

    // Augment with STARFIELD_EVENTS not already covered by the chain
    for (const evDef of STARFIELD_EVENTS) {
      const evM = /^Event\s+(\w+)\s*\(([^)]*)\)/i.exec(evDef.sig);
      if (!evM) continue;
      const evName  = evM[1];
      const evLow   = evName.toLowerCase();
      if (defined.has(evLow) || offerSet.has(evLow)) continue;
      if (partial && !evLow.startsWith(partial)) continue;
      offerSet.add(evLow);

      const evParams = evM[2];
      const newText = `Event ${evName}(${evParams})\n${bodyTab}$0\n${lineUpTo.slice(0, indentLen)}EndEvent`;

      items.push({
        label: evName,
        kind:  CompletionItemKind.Event,
        detail: evDef.base ? `Native event · ${evDef.base}` : 'Native event',
        documentation: { kind: MarkupKind.Markdown, value: evDef.doc },
        textEdit: TextEdit.replace(editRange, newText),
        insertTextFormat: InsertTextFormat.Snippet,
        filterText: evName,
        sortText: `2_${evLow}`,
      });
    }
  }

  return items;
}

function rawToDiag(d: RawDiag): Diagnostic {
  return {
    range: {
      start: { line: d.line, character: d.startChar },
      end:   { line: d.line, character: Math.max(d.startChar + 1, d.endChar) },
    },
    severity: d.severity,
    message: d.message,
    source: 'papyrus',
  };
}

/** Find the first matching function signature in a type's full inheritance chain */
function findFunctionAndOwner(typeName: string, funcNameLower: string): { sig: string; ownerLower: string } | null {
  for (const info of getInheritanceChain(typeName)) {
    const sig = info.functions.find(s => sigToName(s).toLowerCase() === funcNameLower);
    if (sig) return { sig, ownerLower: info.name.toLowerCase() };
  }
  return null;
}

function findFunctionScope(doc: TextDocument, curLine: number): { start: number; end: number } | null {
  const lines = doc.getText().split(/\r?\n/);
  let funcStart = -1;
  for (let i = curLine; i >= 0; i--) {
    const s = lines[i].replace(/;.*$/, '').trim();
    if (/^\s*end(?:function|event)\b/i.test(s)) return null;
    if (FUNC_RE.test(s) || EVENT_RE.test(s)) { funcStart = i; break; }
  }
  if (funcStart === -1) return null;
  for (let i = funcStart + 1; i < lines.length; i++) {
    if (/^\s*end(?:function|event)\b/i.test(lines[i])) return { start: funcStart, end: i };
  }
  return null;
}

function findGlobalFunction(funcNameLower: string): ScriptInfo | null {
  return globalFuncDb.get(funcNameLower) ?? null;
}

function isInsideString(text: string, pos: number): boolean {
  let inStr = false;
  for (let i = 0; i < pos; i++) { if (text[i] === '"') inStr = !inStr; }
  return inStr;
}

function findImportInsertLine(text: string): number {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*scriptname\s+/i.test(lines[i])) return i + 1;
  }
  return 0;
}

function findFunctionInChain(typeName: string, funcNameLower: string): string | null {
  for (const info of getInheritanceChain(typeName)) {
    const sig = info.functions.find(s => sigToName(s).toLowerCase() === funcNameLower);
    if (sig) return sig;
  }
  return null;
}

function findReturnTypeInChain(typeName: string, funcNameLower: string): string | null {
  for (const info of getInheritanceChain(typeName)) {
    const sig = info.functions.find(s => sigToName(s).toLowerCase() === funcNameLower);
    if (sig) { const m = /^(\S+)\s+\w+\s*\(/.exec(sig); return m ? m[1] : null; }
  }
  return null;
}

function findPropertyTypeInChain(typeName: string, propNameLower: string): string | null {
  for (const info of getInheritanceChain(typeName)) {
    const prop = info.properties.find(p => p.name.toLowerCase() === propNameLower);
    if (prop) return prop.type;
  }
  return null;
}

/** Split "Game.GetPlayer().GetLinkedRef(kw)" at top-level dots into segments */
function splitDotChain(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '.' && depth === 0) { parts.push(expr.slice(start, i)); start = i + 1; }
  }
  parts.push(expr.slice(start));
  return parts.filter(p => p.length > 0);
}

/** Resolve a chain expression like "Game.GetPlayer()" to its return type */
function resolveExprType(expr: string, typeMap: Map<string, string>): string | null {
  const segments = splitDotChain(expr.trim());
  if (segments.length === 0) return null;

  // First segment: handle cast `(expr as Type[])`, else plain identifier / call
  let curType: string | null = null;
  const seg0 = segments[0].trim();
  const castM = /\bas\s+([\w]+(?:\[\])?)\s*\)$/.exec(seg0);
  if (castM) {
    const t = castM[1].toLowerCase();
    const base = t.replace(/\[\]$/, '');
    curType = (scriptDb.has(base) || structDb.has(base) || structNameIndex.has(base)) &&
              !PRIMITIVES.has(base) ? qualifyStructType(t) : null;
  } else {
    const bracketIdx = seg0.indexOf('[');
    const parenIdx   = seg0.indexOf('(');
    const hasArrayAccess = bracketIdx !== -1 && (parenIdx === -1 || bracketIdx < parenIdx);
    const firstLower = seg0.replace(/[\[(].*$/, '').trim().toLowerCase();
    curType = typeMap.get(firstLower) ?? null;
    if (!curType && scriptDb.has(firstLower)) curType = firstLower;
    // arr[i] → element type
    if (curType && hasArrayAccess && curType.endsWith('[]')) curType = curType.slice(0, -2);
    // Qualify unqualified struct names from typeMap
    if (curType) curType = qualifyStructType(curType);
  }
  if (!curType) return null;
  let cur: string = curType; // non-null working variable for the chain
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const nm = /^(\w+)/.exec(seg);
    if (!nm) return null;
    const memberLower = nm[1].toLowerCase();

    // Array type: resolve against hardcoded intrinsics
    if (cur.endsWith('[]')) {
      const intr = ARRAY_INTRINSICS[memberLower];
      if (!intr) return null;
      const elemType = cur.slice(0, -2);
      const ret: string = intr.ret === 'E' ? elemType : intr.ret === 'E[]' ? cur : intr.ret;
      if (ret === 'none' || ret === 'void' || PRIMITIVES.has(ret)) return null;
      cur = ret;
      continue;
    }

    if (seg.includes('(')) {
      // Trailing `as Type` cast overrides the return type (e.g. `GetArray() as Foo[]`)
      const asCastM = /\bas\s+([\w]+(?:\[\])?)\s*$/.exec(seg);
      if (asCastM) {
        const castType = asCastM[1].toLowerCase();
        const castBase = castType.replace(/\[\]$/, '');
        if ((scriptDb.has(castBase) || structDb.has(castBase) || structNameIndex.has(castBase)) &&
            !PRIMITIVES.has(castBase)) {
          cur = qualifyStructType(castType); continue;
        }
      }
      const ret = findReturnTypeInChain(cur, memberLower);
      if (!ret) return null;
      let retLower = ret.toLowerCase(); // keep [] suffix — array return types are valid chain targets
      if (retLower === 'void' || retLower === 'none' || PRIMITIVES.has(retLower.replace(/\[\]$/, ''))) {
        if (!retLower.endsWith('[]')) return null;
      }
      cur = qualifyStructType(retLower, cur.replace(/\[\]$/, ''));
    } else {
      const sFields = structDb.get(cur);
      if (sFields) {
        const f = sFields.find(x => x.name.toLowerCase() === memberLower);
        if (!f) return null;
        const ft = f.type.toLowerCase();
        if (PRIMITIVES.has(ft.replace(/\[\]$/, '')) && !ft.endsWith('[]')) return null;
        cur = qualifyStructType(ft);
      } else {
        const propType = findPropertyTypeInChain(cur, memberLower);
        if (!propType) return null;
        const propLower = propType.toLowerCase();
        if (PRIMITIVES.has(propLower.replace(/\[\]$/, '')) && !propLower.endsWith('[]')) return null;
        cur = qualifyStructType(propLower, cur.replace(/\[\]$/, ''));
      }
    }
  }
  return cur;
}

/**
 * Scan backwards from `text[end-1]` to extract a receiver expression
 * (word chars, dots, colons, and balanced paren groups).
 */
function scanReceiver(text: string, end: number): string {
  let i = end - 1, depth = 0;
  while (i >= 0) {
    const c = text[i];
    if (c === ')' || c === ']') { depth++; i--; continue; }
    if (c === '(' || c === '[') { if (depth === 0) break; depth--; i--; continue; }
    if (depth === 0 && !/[\w.:]/.test(c)) break;
    i--;
  }
  return text.slice(i + 1, end).trim();
}

/** For dot completion: find last dot in text and return {receiver, partial} */
function parseDotAccess(text: string): { receiver: string; partial: string } | null {
  const lastDot = text.lastIndexOf('.');
  if (lastDot === -1) return null;
  const receiver = scanReceiver(text, lastDot);
  if (!receiver) return null;
  return { receiver, partial: text.slice(lastDot + 1) };
}

/** For signature help: extract {receiver, funcName} from text before the open paren */
function parseCallReceiver(beforeParen: string): { receiver: string; funcName: string } | null {
  const nm = /(\w+)$/.exec(beforeParen);
  if (!nm) return null;
  const funcName = nm[1];
  const beforeFunc = beforeParen.slice(0, beforeParen.length - funcName.length);
  if (!beforeFunc.endsWith('.')) return null;
  const receiver = scanReceiver(beforeFunc, beforeFunc.length - 1);
  if (!receiver) return null;
  return { receiver, funcName };
}

/** Build a SignatureInformation with [start,end] parameter spans into the label string */
function buildSignatureInfo(sig: string): SignatureInformation {
  const openParen  = sig.indexOf('(');
  const closeParen = sig.lastIndexOf(')');
  const parameters: ParameterInformation[] = [];
  if (openParen !== -1 && closeParen > openParen) {
    const paramStr = sig.slice(openParen + 1, closeParen);
    if (paramStr.trim()) {
      let pos = openParen + 1;
      for (const part of paramStr.split(',')) {
        const lead  = part.length - part.trimStart().length;
        const start = pos + lead;
        const end   = start + part.trim().length;
        parameters.push({ label: [start, end] });
        pos += part.length + 1; // +1 for the comma
      }
    }
  }
  return { label: sig, parameters };
}

/**
 * Build hover markdown for a resolved inheritance chain.
 * prefix is prepended to the type name header, e.g. "`akTarget` — " for variable hover.
 */
function buildScriptHoverMd(chain: ScriptInfo[], prefix = ''): string {
  const [script, ...ancestors] = chain;
  const extendsStr = ancestors.length > 0
    ? `\nextends ${ancestors.map(a => `\`${a.name}\``).join(' → ')}` : '';
  const props = script.properties.slice(0, 6).map(p => `- \`${p.type} ${p.name}\`${p.readonly ? ' *(readonly)*' : ''}`).join('\n');
  const fns   = script.functions.slice(0, 8).map(f => `- \`${f}\``).join('\n');
  const evs   = script.events.slice(0, 5).map(ev => `- \`${ev}\``).join('\n');
  const moreProps = script.properties.length > 6 ? `\n*…and ${script.properties.length - 6} more*` : '';
  const moreFns   = script.functions.length  > 8 ? `\n*…and ${script.functions.length  - 8} more*` : '';
  const iFns   = ancestors.reduce((n, a) => n + a.functions.length, 0);
  const iProps = ancestors.reduce((n, a) => n + a.properties.length, 0);
  let inheritedStr = '';
  if (ancestors.length > 0) {
    const parts: string[] = [];
    if (iFns   > 0) parts.push(`${iFns} functions`);
    if (iProps > 0) parts.push(`${iProps} properties`);
    if (parts.length > 0)
      inheritedStr = `*Inherits ${parts.join(' and ')} from ${ancestors.map(a => `\`${a.name}\``).join(', ')}*`;
  }
  const doc = scriptDocDb.get(script.name.toLowerCase());
  return (
    `${prefix}**\`${script.name}\`**${extendsStr}\n\n` +
    (doc          ? `*${doc}*\n\n`                              : '') +
    (props        ? `**Properties:**\n${props}${moreProps}\n\n` : '') +
    (fns          ? `**Functions:**\n${fns}${moreFns}\n\n`      : '') +
    (evs          ? `**Events:**\n${evs}\n\n`                   : '') +
    (inheritedStr ? inheritedStr                                 : '')
  );
}

// ── LSP ───────────────────────────────────────────────────────────────────────

/** Rebuild the lookup indexes derived from scriptDb/structDb. Idempotent. */
function buildDerivedIndexes(): void {
  eventNameSet.clear(); globalFuncDb.clear(); structNameIndex.clear();

  for (const info of scriptDb.values()) {
    for (const ev of info.events) {
      const m = /^Event\s+([\w.]+)/i.exec(ev);
      if (m) { const parts = m[1].split('.'); eventNameSet.add(parts[parts.length - 1]); }
    }
    for (const ce of info.customEvents) eventNameSet.add(ce);
    for (const g of info.globals) { if (!globalFuncDb.has(g)) globalFuncDb.set(g, info); }
  }
  // Reverse index: unqualified struct name → [qualified keys...]
  for (const key of structDb.keys()) {
    const sName = key.slice(key.lastIndexOf(':') + 1);
    if (!structNameIndex.has(sName)) structNameIndex.set(sName, []);
    structNameIndex.get(sName)!.push(key);
  }
}

/** Parse every .psc under `dirs` straight into scriptDb — the same data
 *  scripts-db.json holds, derived on the spot. Later dirs override earlier ones. */
function scanScriptDbFromSources(dirs: string[]): number {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.psc')) files.push(full);
    }
  };
  for (const dir of dirs) walk(dir);

  for (const f of files) {
    try {
      indexDocument(TextDocument.create(`file://${f}`, 'papyrus', 0, fs.readFileSync(f, 'utf8')));
    } catch { /* skip unreadable files */ }
  }
  return files.length;
}

/** Populate scriptDb from the pre-built cache, falling back to a source scan.
 *  The cache is an optimisation, never a requirement. */
function loadScriptDb(dbPath: string): void {
  scriptDb.clear(); structDb.clear(); structNameIndex.clear(); funcDocDb.clear();
  propDocDb.clear(); scriptDocDb.clear(); globalFuncDb.clear(); eventNameSet.clear();
  typeMapCache.clear();

  const rebuildFromSources = (why: string): void => {
    const started = Date.now();
    // Drop anything a half-parsed cache left behind before re-deriving.
    scriptDb.clear(); structDb.clear(); funcDocDb.clear(); propDocDb.clear(); scriptDocDb.clear();
    const n = scanScriptDbFromSources(cfg.scanDirs);
    buildDerivedIndexes();
    connection.console.log(
      `[papyrus-lsp] ${why} — indexed ${n} scripts from source in ${Date.now() - started}ms. ` +
      `Run \`npm run rebuild-db\` in ${INSTALL_ROOT} to cache this and cut startup time.`
    );
  };

  // The source scan already covers cfg.scanDirs, workspace included.
  if (!exists(dbPath)) { rebuildFromSources('no scripts-db.json'); return; }
  try {
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8')) as Record<string, any>;
    for (const [k, v] of Object.entries(raw)) {
      const funcAccessMap = new Map<string, FuncAccessEntry>();
      for (const f of (v.functions ?? [])) {
        if (f.access || f.selfOnly || f.debugOnly || f.betaOnly)
          funcAccessMap.set(String(f.name).toLowerCase(), {
            access: f.access, selfOnly: f.selfOnly ?? false,
            debugOnly: f.debugOnly ?? false, betaOnly: f.betaOnly ?? false,
          });
      }
      scriptDb.set(k, {
        name:            v.name,
        extendsType:     v.extendsType ?? null,
        functions:       (v.functions  ?? []).map((f: any) => `${f.ret} ${f.name}(${f.params})`),
        events:          (v.events     ?? []).map((e: any) => `Event ${e.name}(${e.params})`),
        properties:      (v.properties ?? []).map((p: any) => ({
          type: p.type, name: p.name, readonly: p.readonly ?? false,
          access: p.access, selfOnly: p.selfOnly ?? false,
        })),
        structs:         (v.structs    ?? []),
        globals:         (v.globals      ?? []).map((g: any) => String(g).toLowerCase()),
        customEvents:    (v.customEvents ?? []).map((c: any) => String(c)),
        sourcePath:      v.sourcePath ?? '',
        scriptDebugOnly: v.scriptDebugOnly ?? false,
        scriptBetaOnly:  v.scriptBetaOnly  ?? false,
        funcAccess:      funcAccessMap,
      });
      for (const struct of (v.structs ?? []))
        structDb.set(`${k}:${struct.name.toLowerCase()}`, struct.fields ?? []);
      if (v.scriptDoc) scriptDocDb.set(k, v.scriptDoc);
      for (const f of (v.functions ?? []))
        if (f.doc) funcDocDb.set(`${k}.${f.name.toLowerCase()}`, f.doc);
      for (const e of (v.events ?? []))
        if (e.doc) funcDocDb.set(`${k}.${String(e.name).toLowerCase()}`, e.doc);
      for (const p of (v.properties ?? []))
        if (p.doc) propDocDb.set(`${k}.${String(p.name).toLowerCase()}`, p.doc);
    }
    // The cache only knows the dirs build-db.js was pointed at. Layer the dirs it
    // can't have seen — the workspace, and anything else configured — on top, so a
    // project's own scripts resolve without rebuilding the cache first.
    const cached = scriptDb.size;
    const overlaid = scanScriptDbFromSources(cfg.scanDirs.filter(d => d !== BUNDLED_VANILLA));
    buildDerivedIndexes();
    connection.console.log(
      `[papyrus-lsp] loaded ${cached} scripts from scripts-db.json, ` +
      `overlaid ${overlaid} from source — ${scriptDb.size} total, ${structDb.size} structs`
    );
  } catch (err) {
    // A corrupt cache shouldn't cost us hover/completions — derive the data instead.
    connection.console.warn(`[papyrus-lsp] scripts-db.json unreadable (${err})`);
    rebuildFromSources('falling back to a source scan');
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  // Whether the client can be asked to re-pull diagnostics (LSP `workspace/diagnostic/refresh`).
  clientDiagRefreshSupport = params.capabilities?.workspace?.diagnostics?.refreshSupport === true;

  // Store workspace root for later (batch diagnostics, etc.)
  const rootUri = params.rootUri ?? (params.workspaceFolders?.[0]?.uri ?? null);
  if (rootUri) workspaceRoot = decodeURIComponent(rootUri.replace(/^file:\/\//, ''));

  // Must precede loadScriptDb: the on-the-fly fallback scans cfg.scanDirs.
  resolveConfig(workspaceRoot);
  loadScriptDb(SCRIPTS_DB_PATH);

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: false }, // enables didSave → authoritative recheck
      },
      completionProvider: { triggerCharacters: ['.'], resolveProvider: true },
      hoverProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ','] },
      definitionProvider: true,
      workspaceSymbolProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      renameProvider: { prepareProvider: true },
      inlayHintProvider: true,
      codeActionProvider: true,
      codeLensProvider:    { resolveProvider: false },
      foldingRangeProvider:      true,
      typeHierarchyProvider:     true,
      callHierarchyProvider:     true,
      executeCommandProvider:    { commands: ['papyrus.checkAllScripts'] },
      selectionRangeProvider:    true,
      documentFormattingProvider: true,
      diagnosticProvider: {
        identifier: 'papyrus',
        interFileDependencies: true,
        workspaceDiagnostics: true,
      },
      semanticTokensProvider: {
        legend: {
          tokenTypes:     ['class', 'function', 'event', 'property', 'variable', 'parameter'],
          tokenModifiers: ['declaration'],
        },
        full: true,
      },
    },
  };
});

// ── Reference index ───────────────────────────────────────────────────────────

const refIndex     = new Map<string, Location[]>();
const funcCallIndex = new Map<string, Array<{ loc: Location; scriptName: string }>>();
let   refIndexReady = false;

async function buildRefIndex(): Promise<void> {
  // Show a progress notification while the background index builds
  let reporter: { report(msg: string): void; done(): void } | null = null;
  try {
    const r = await connection.window.createWorkDoneProgress();
    r.begin('Papyrus LSP', undefined, 'Indexing script references…', false);
    reporter = { report: (msg) => r.report(msg), done: () => r.done() };
  } catch { /* progress not supported by this client */ }

  const WORD_RE = /\b([A-Za-z_]\w*)\b/g;
  const CALL_RE = /\b(\w+)\s*\(/g;

  // Set of all known function names for call-index filtering
  const allFuncNames = new Set<string>();
  for (const info of scriptDb.values())
    for (const sig of info.functions) { const n = sigToName(sig); if (n) allFuncNames.add(n.toLowerCase()); }

  function indexFile(filePath: string): void {
    const scriptName = path.basename(filePath, '.psc');
    let text: string;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { return; }
    const uri   = `file://${filePath}`;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/;.*$/, '');

      // Type reference index
      WORD_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WORD_RE.exec(stripped)) !== null) {
        const lc = m[1].toLowerCase();
        if (!scriptDb.has(lc)) continue;
        const loc = Location.create(uri, Range.create(i, m.index, i, m.index + m[1].length));
        let arr = refIndex.get(lc);
        if (!arr) { arr = []; refIndex.set(lc, arr); }
        arr.push(loc);
      }

      // Function call index — skip declaration lines to avoid false positives
      if (FUNC_RE.test(stripped) || EVENT_RE.test(stripped)) continue;
      CALL_RE.lastIndex = 0;
      while ((m = CALL_RE.exec(stripped)) !== null) {
        const lc = m[1].toLowerCase();
        if (!allFuncNames.has(lc)) continue;
        const callLoc = Location.create(uri, Range.create(i, m.index, i, m.index + m[1].length));
        let carr = funcCallIndex.get(lc);
        if (!carr) { carr = []; funcCallIndex.set(lc, carr); }
        carr.push({ loc: callLoc, scriptName });
      }
    }
  }

  // Collect all .psc paths first (directory walk is fast), then index in chunks
  // so the event loop can process LSP requests between chunks.
  function collectPscPaths(dir: string, out: string[]): void {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collectPscPaths(full, out);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.psc')) out.push(full);
      }
    } catch { /* skip inaccessible dirs */ }
  }

  const allPaths: string[] = [];
  for (const dir of cfg.scanDirs) collectPscPaths(dir, allPaths);

  const CHUNK = 50;
  for (let i = 0; i < allPaths.length; i += CHUNK) {
    for (let j = i; j < Math.min(i + CHUNK, allPaths.length); j++) indexFile(allPaths[j]);
    // Yield event loop so hover/completion requests are serviced between chunks
    await new Promise<void>(r => setImmediate(r));
  }

  refIndexReady = true;
  reporter?.done();
  connection.console.log(`[papyrus-lsp] reference index ready — ${refIndex.size} types indexed`);
}

// Build the index after the handshake so startup latency stays low
// ── Startup requirement checks ────────────────────────────────────────────────

/** Log what the server resolved. Nothing here is fatal: the native checker covers
 *  diagnostics without a compiler, and scriptDb is derived from source without a cache. */
function reportResolvedSetup(): void {
  connection.console.log(`[papyrus-lsp] import dirs: ${cfg.scanDirs.join(', ') || '(none)'}`);

  if (compilerReady) {
    const via = process.platform === 'win32' ? 'native' : `mono ${monoExe}`;
    connection.console.log(`[papyrus-lsp] compiler diagnostics enabled — ${cfg.compilerExe} (${via})`);
    return;
  }

  const missing: string[] = [];
  if (!cfg.compilerExe) missing.push('PapyrusCompiler.exe not found');
  if (!cfg.flagsFile)   missing.push(`no ${FLAGS_BASENAME} in any import dir`);
  if (process.platform !== 'win32' && !monoExe) missing.push('mono not in PATH (set PAPYRUS_LSP_MONO)');
  connection.console.log(
    `[papyrus-lsp] compiler diagnostics unavailable (${missing.join('; ')}) — native checker only.`
  );
}

connection.onInitialized(() => {
  reportResolvedSetup();
  setImmediate(buildRefIndex);

  // Hot-reload the cache when it appears or changes (e.g. after `npm run rebuild-db`).
  // Watch the directory, not the file: the file may not exist yet.
  try {
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    fs.watch(INSTALL_ROOT, { persistent: false }, (_evt, filename) => {
      if (filename !== path.basename(SCRIPTS_DB_PATH)) return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        connection.console.log('[papyrus-lsp] scripts-db.json changed — reloading…');
        loadScriptDb(SCRIPTS_DB_PATH);
        connection.window.showInformationMessage('[papyrus-lsp] Papyrus script database reloaded.');
      }, 500);
    });
  } catch { /* watching is a nicety; a failed watch must not break the session */ }
});

// ── Compiler-backed diagnostics ───────────────────────────────────────────────

const TEMP_DIR = path.join(os.tmpdir(), 'papyrus-lsp');

// filename(line,col): message  — line is 1-indexed, col is 0-indexed
const COMPILER_LINE_RE = /^.+\((\d+),(\d+)\):\s*(.+)$/;

function extractScriptName(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const m = /^\s*scriptname\s+(\S+)/i.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** Run PapyrusCompiler.exe and return its diagnostics via callback (no side-effects).
 *  Returns the spawned child process (or null if it bailed before spawning) so callers
 *  can cancel a stale run when a newer edit arrives. */
function collectCompilerDiags(doc: TextDocument, cb: (diags: Diagnostic[]) => void): ReturnType<typeof execFile> | null {
  const text = doc.getText();
  const scriptName = extractScriptName(text) ?? path.basename(doc.uri.replace(/^file:\/\//, ''), '.psc');

  const runDir = path.join(TEMP_DIR, `run_${process.hrtime.bigint().toString(36)}`);
  fs.mkdirSync(runDir, { recursive: true });
  const tempFile = path.join(runDir, `${scriptName}.psc`);
  try { fs.writeFileSync(tempFile, text, 'utf8'); } catch (e) {
    connection.console.warn(`[papyrus-lsp] could not write temp file: ${e}`);
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}
    cb([]); return null;
  }

  // `;` is PapyrusCompiler's own list separator, not the platform's.
  const run = compilerArgv([
    tempFile,
    `-import=${cfg.scanDirs.join(';')}`,
    `-flags=${cfg.flagsFile}`,
    '-noasm',
    `-output=${runDir}`,
    '-quiet',
  ]);
  if (!run) {
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}
    cb([]); return null;
  }

  return execFile(run.cmd, run.argv, { timeout: 15000 }, (_err, stdout, stderr) => {
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}

    const output = stdout + stderr;
    const diagnostics: Diagnostic[] = [];
    const srcLines = text.split(/\r?\n/);

    for (const raw of output.split(/\r?\n/)) {
      const m = COMPILER_LINE_RE.exec(raw.trim());
      if (!m) continue;
      const msg = m[3].trim();
      if (msg.includes('filename does not match')) continue;

      const lineNum = Math.max(0, parseInt(m[1], 10) - 1); // 1-indexed → 0-indexed
      const colNum  = parseInt(m[2], 10);

      const srcLine = srcLines[lineNum] ?? '';
      let endCol = colNum;
      while (endCol < srcLine.length && /\w/.test(srcLine[endCol])) endCol++;
      if (endCol === colNum) endCol = colNum + 1;

      diagnostics.push({
        range: {
          start: { line: lineNum, character: colNum },
          end:   { line: lineNum, character: endCol },
        },
        severity: DiagnosticSeverity.Error,
        message: msg,
        source: 'papyrus-compiler',
      });
    }

    cb(diagnostics);
  });
}

/** Run compiler and publish diagnostics directly — used by the batch `papyrus.checkAllScripts` command. */
function runCompilerDiagnostics(doc: TextDocument, onDone?: () => void): void {
  collectCompilerDiags(doc, diags => {
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: [...diags, ...analyzeUnusedImports(doc)] });
    onDone?.();
  });
}

/** Report unused `import` statements (runs in both compiler and fallback modes). */
function analyzeUnusedImports(doc: TextDocument): Diagnostic[] {
  const lines = doc.getText().split(/\r?\n/);
  const docText = doc.getText();
  const diags: Diagnostic[] = [];
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/;.*$/, '').trim();
    const m = /^\s*import\s+(\w+)/i.exec(stripped);
    if (!m) continue;
    const importName = m[1];

    // 1. Direct qualified usage: Foo.Bar() or variable of type Foo
    const nameRe = new RegExp(`\\b${importName}\\b`, 'i');
    const usedDirectly = lines.some((l, idx) => idx !== i && nameRe.test(l.replace(/;.*$/, '')));
    if (usedDirectly) continue;

    // 2. Unqualified call: `import Foo` lets callers write Bar() instead of Foo.Bar().
    //    If the script is in our DB, check whether any of its global functions are called.
    const importedInfo = scriptDb.get(importName.toLowerCase());
    if (!importedInfo) continue; // Unknown script — can't prove it's unused; skip warning
    if (importedInfo.globals.length > 0) {
      const globalUsed = importedInfo.globals.some(g =>
        new RegExp(`\\b${g}\\s*\\(`, 'i').test(docText)
      );
      if (globalUsed) continue;
    }

    const col = lines[i].indexOf(importName);
    diags.push({
      range: Range.create(i, col, i, col + importName.length),
      severity: DiagnosticSeverity.Hint,
      message: `'${importName}' is imported but never used.`,
      source: 'papyrus',
      tags: [DiagnosticTag.Unnecessary],
    });
  }
  return diags;
}

/** Report unused local variables inside function/event bodies (fallback mode only). */
function analyzeUnusedLocals(doc: TextDocument): Diagnostic[] {
  const lines = doc.getText().split(/\r?\n/);
  const diags: Diagnostic[] = [];
  let inFunc = false, funcStart = -1;
  const localDecls: Array<{ name: string; line: number; col: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/;.*$/, '').trim();
    if (!inFunc) {
      if (FUNC_RE.test(stripped) || EVENT_RE.test(stripped)) {
        inFunc = true; funcStart = i; localDecls.length = 0;
      }
      continue;
    }

    if (/^end(?:function|event)\b/i.test(stripped.toLowerCase())) {
      for (const decl of localDecls) {
        const re = new RegExp(`\\b${decl.name}\\b`, 'i');
        const used = lines.slice(funcStart, i + 1).some((l, off) =>
          funcStart + off !== decl.line && re.test(l.replace(/;.*$/, ''))
        );
        if (!used) {
          diags.push({
            range: Range.create(decl.line, decl.col, decl.line, decl.col + decl.name.length),
            severity: DiagnosticSeverity.Hint,
            message: `Local variable '${decl.name}' is declared but never used.`,
            source: 'papyrus',
            tags: [DiagnosticTag.Unnecessary],
          });
        }
      }
      inFunc = false;
      continue;
    }

    // Local variable declaration: Type VarName [= ...]
    const tokens = stripped.split(/\s+/);
    const t0l = tokens[0].toLowerCase();
    if (tokens.length >= 2 && !STMT_KEYWORDS.has(t0l) && isKnownType(tokens[0])) {
      const varName = tokens[1].replace(/=.*$/, '').trim();
      if (varName && /^\w+$/.test(varName) && !STMT_KEYWORDS.has(varName.toLowerCase())) {
        const col = lines[i].indexOf(varName);
        if (col >= 0) localDecls.push({ name: varName, line: i, col });
      }
    }
  }
  return diags;
}

/**
 * Semantic checks that run only when the real compiler is unavailable.
 * Catches unknown types, unknown imports, and bad declaration types.
 * When the compiler IS available it supersedes these with authoritative errors.
 */
/**
 * Structural checks that always run (even when the compiler is present).
 * These catch definitively-illegal constructs: oversized identifiers, out-of-range
 * array sizes, const without init, illegal struct field types, duplicate imports.
 */
function checkStructural(doc: TextDocument): Diagnostic[] {
  const lines = doc.getText().split(/\r?\n/);
  const diags: Diagnostic[] = [];
  let inBlockComment = false;
  let inStruct       = false;
  const importsSeen  = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];

    if (inBlockComment) {
      const ci = raw.indexOf('/;');
      if (ci !== -1) { inBlockComment = false; raw = raw.slice(ci + 2); }
      else continue;
    }
    const bo = raw.indexOf(';/');
    if (bo !== -1) {
      const bc = raw.indexOf('/;', bo + 2);
      if (bc !== -1) { raw = raw.slice(0, bo) + raw.slice(bc + 2); }
      else { inBlockComment = true; raw = raw.slice(0, bo); }
    }

    const stripped = raw.replace(/;.*$/, '').trim();
    if (!stripped) continue;
    const tokens = stripped.split(/\s+/);
    const t0l = tokens[0].toLowerCase();

    // ── Struct block tracking ──────────────────────────────────────────────
    if (t0l === 'struct') { inStruct = true; continue; }
    if (t0l === 'endstruct') { inStruct = false; continue; }

    if (inStruct) {
      if (tokens.length >= 2 && /^[\w\[\]]+$/.test(tokens[0])) {
        const fieldType = tokens[0];
        const col = raw.indexOf(fieldType);
        if (fieldType.endsWith('[]')) {
          diags.push({
            range: Range.create(i, col, i, col + fieldType.length),
            severity: DiagnosticSeverity.Error,
            message: `struct variables cannot be arrays`,
            source: 'papyrus',
          });
        } else if (fieldType.toLowerCase() === 'var') {
          diags.push({
            range: Range.create(i, col, i, col + fieldType.length),
            severity: DiagnosticSeverity.Error,
            message: `structs may not contain var variables`,
            source: 'papyrus',
          });
        }
      }
      continue;
    }

    // ── Array literal size: new Type[N] must be 0–128 ─────────────────────
    const newArrayRe = /\bnew\s+[\w:]+\s*\[\s*(\d+)\s*\]/gi;
    let naM: RegExpExecArray | null;
    while ((naM = newArrayRe.exec(stripped)) !== null) {
      const size = parseInt(naM[1], 10);
      if (size < 0 || size > 128) {
        const numStart = raw.indexOf(naM[1], raw.toLowerCase().indexOf('new'));
        diags.push({
          range: Range.create(i, numStart < 0 ? 0 : numStart,
                              i, numStart < 0 ? naM[1].length : numStart + naM[1].length),
          severity: DiagnosticSeverity.Error,
          message: `Array size of ${size} is invalid, must be between 0 and 128 inclusive`,
          source: 'papyrus',
        });
      }
    }

    // ── ScriptName X [extends Y]: component length ─────────────────────────
    if (t0l === 'scriptname' && tokens[1]) {
      const snRaw = tokens[1];
      const components = snRaw.split(':');
      let searchFrom = raw.indexOf(snRaw);
      for (let ci = 0; ci < components.length; ci++) {
        const comp = components[ci];
        const col = raw.indexOf(comp, searchFrom);
        if (comp.length > 38 && col >= 0) {
          // First component is the script name; subsequent ones are namespace segments
          const msg = ci === components.length - 1
            ? `Script name "${comp}" is too long, please shorten it to 38 characters or less`
            : `Namespace name "${comp}" is too long, please shorten it to 38 characters or less`;
          diags.push({
            range: Range.create(i, col, i, col + comp.length),
            severity: DiagnosticSeverity.Error,
            message: msg,
            source: 'papyrus',
          });
        }
        if (col >= 0) searchFrom = col + comp.length;
      }
      continue;
    }

    // ── Duplicate import ───────────────────────────────────────────────────
    if (t0l === 'import' && tokens[1]) {
      const importName = tokens[1];
      const importLower = importName.toLowerCase();
      const col = raw.indexOf(importName);
      if (importsSeen.has(importLower)) {
        if (col >= 0) diags.push({
          range: Range.create(i, col, i, col + importName.length),
          severity: DiagnosticSeverity.Error,
          message: `${importName} imported more then once`,
          source: 'papyrus',
        });
      } else {
        importsSeen.add(importLower);
      }
      continue;
    }

    // ── const variable without initializer ────────────────────────────────
    if (tokens.length >= 3 && tokens[1]?.toLowerCase() === 'const' &&
        !stripped.includes('=') && isKnownType(tokens[0])) {
      const varName = tokens[2];
      if (varName && /^\w+$/.test(varName)) {
        const constIdx = raw.toLowerCase().indexOf('const');
        const col = raw.indexOf(varName, constIdx + 5);
        diags.push({
          range: Range.create(i, col < 0 ? 0 : col,
                              i, col < 0 ? varName.length : col + varName.length),
          severity: DiagnosticSeverity.Error,
          message: `const variables must be given an initial value`,
          source: 'papyrus',
        });
      }
    }
  }

  return diags;
}

// ── Access modifier helpers ───────────────────────────────────────────────────

/** True if the script name (colon-separated) contains a namespace component. */
function isNamespaced(scriptNameLower: string): boolean {
  return scriptNameLower.includes(':');
}

/**
 * Check whether `accessorScript` may access a member with `access` declared on `ownerScript`.
 *   private   → accessor must be the same script
 *   protected → accessor must be owner or a child of owner (owner in accessor's chain)
 *   internal  → both must be namespaced and accessor's leading namespaces must include owner's
 */
function canAccess(access: AccessLevel, ownerScript: string, accessorScript: string): boolean {
  const owner = ownerScript.toLowerCase();
  const accessor = accessorScript.toLowerCase();
  if (owner === accessor) return true;
  switch (access) {
    case 'private':   return false;
    case 'protected': {
      // accessor is a child of owner → owner appears in accessor's inheritance chain
      for (const info of getInheritanceChain(accessor)) {
        if (info.name.toLowerCase() === owner) return true;
      }
      return false;
    }
    case 'internal': {
      if (!isNamespaced(owner) || !isNamespaced(accessor)) return false;
      // owner's namespace components must be a prefix of accessor's
      const ownerNs   = owner.split(':').slice(0, -1);
      const accessorNs = accessor.split(':').slice(0, -1);
      if (accessorNs.length < ownerNs.length) return false;
      return ownerNs.every((part, i) => part === accessorNs[i]);
    }
  }
}

/**
 * Declaration-level access modifier checks — always run.
 *
 * Errors:
 *  - Multiple access modifiers on the same member
 *  - SelfOnly without Private or Protected
 *  - SelfOnly on a Global member
 *  - Internal on a non-namespaced script
 *  - Access modifier on a non-auto property
 */
function checkAccessModifiers(doc: TextDocument): Diagnostic[] {
  const lines = doc.getText().split(/\r?\n/);
  const diags: Diagnostic[] = [];

  function err(line: number, col: number, end: number, msg: string): void {
    diags.push({ range: Range.create(line, col, line, Math.max(col + 1, end)), severity: DiagnosticSeverity.Error, message: msg, source: 'papyrus' });
  }

  // Determine if this script is namespaced (for Internal check)
  let scriptNamespaced = false;
  const ACCESS_KWS = ['private', 'protected', 'internal'];

  let inBC = false;

  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    if (inBC) { const ci = raw.indexOf('/;'); if (ci !== -1) { inBC = false; raw = raw.slice(ci + 2); } else continue; }
    const bo = raw.indexOf(';/');
    if (bo !== -1) { const bc = raw.indexOf('/;', bo + 2); if (bc !== -1) raw = raw.slice(0, bo) + raw.slice(bc + 2); else { inBC = true; raw = raw.slice(0, bo); } }
    const stripped = raw.replace(/;.*$/, '').trim();
    if (!stripped) continue;
    const tokens = stripped.split(/\s+/);
    const t0l = tokens[0].toLowerCase();

    if (t0l === 'scriptname' && tokens[1]) {
      scriptNamespaced = isNamespaced(tokens[1].toLowerCase());
      continue;
    }

    // Collect the flags portion (after the closing paren for functions, or full line for properties/vars)
    let flagsText = '';
    let declLabel = '';
    let isProperty = false;
    let isAutoProperty = false;

    const fmatch = FUNC_RE.exec(stripped);
    if (fmatch) {
      flagsText = (fmatch[4] ?? '').toLowerCase();
      declLabel = fmatch[2];
    } else if (tokens.length >= 3 && tokens[1]?.toLowerCase() === 'property') {
      isProperty = true;
      isAutoProperty = /\bauto(?:readonly)?\b/i.test(stripped);
      flagsText = stripped.toLowerCase();
      declLabel = tokens[2];
    } else if (tokens.length >= 2 && !STMT_KEYWORDS.has(t0l) && isKnownType(tokens[0])) {
      flagsText = stripped.toLowerCase();
      declLabel = tokens[1];
    }

    if (!flagsText) continue;

    const accessFound = ACCESS_KWS.filter(kw => new RegExp(`\\b${kw}\\b`).test(flagsText));
    const hasSelfOnly = /\bselfonly\b/.test(flagsText);
    const hasGlobal   = /\bglobal\b/.test(flagsText);

    // Find a representative column for the first access modifier on the line
    const firstAccCol = ((): number => {
      let best = raw.length;
      for (const kw of [...accessFound, ...(hasSelfOnly ? ['selfonly'] : [])]) {
        const idx = raw.toLowerCase().indexOf(kw);
        if (idx >= 0 && idx < best) best = idx;
      }
      return best < raw.length ? best : 0;
    })();

    if (accessFound.length > 1) {
      err(i, firstAccCol, firstAccCol + accessFound[0].length,
        `Multiple access modifiers not allowed on the same member`);
    }

    if (hasSelfOnly) {
      const selfOnlyCol = raw.toLowerCase().indexOf('selfonly');
      if (!accessFound.includes('private') && !accessFound.includes('protected')) {
        err(i, selfOnlyCol, selfOnlyCol + 8,
          `SelfOnly is only allowed on private or protected members`);
      }
      if (hasGlobal) {
        err(i, selfOnlyCol, selfOnlyCol + 8,
          `SelfOnly is not allowed on global members, as there is no self`);
      }
    }

    if (accessFound.includes('internal') && !scriptNamespaced) {
      const intCol = raw.toLowerCase().indexOf('internal');
      err(i, intCol, intCol + 8,
        `Internal access modifier only allowed on members of scripts inside a namespace`);
    }

    if (isProperty && accessFound.length > 0 && !isAutoProperty) {
      err(i, firstAccCol, firstAccCol + accessFound[0].length,
        `Only auto properties can have access restrictions - non-auto properties can only have access restrictions on their get and set functions`);
    }
  }

  return diags;
}

/**
 * Access-site validation — flag calls to private/protected/internal/selfonly members
 * from scripts that don't have access.
 *
 * Checks dot-access patterns `receiver.member` where the receiver's type is known
 * and the member has an explicit access modifier in the DB.
 */
function checkAccessSites(doc: TextDocument): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const typeMap    = buildTypeMap(doc);
  const selfScript = typeMap.get('self'); // current document's script type
  if (!selfScript) return diags;

  const lines = doc.getText().split(/\r?\n/);

  // Dot-access pattern: capture receiver.member (simple cases only)
  const DOT_RE = /(\w+)\.(\w+)/g;

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/;.*$/, '');
    let m: RegExpExecArray | null;
    DOT_RE.lastIndex = 0;
    while ((m = DOT_RE.exec(stripped)) !== null) {
      const receiver   = m[1];
      const memberName = m[2];
      const memberLower = memberName.toLowerCase();
      const col = m.index + m[0].length - memberName.length;

      const receiverType = resolveExprType(receiver, typeMap);
      if (!receiverType || receiverType.endsWith('[]')) continue;

      // Find the member in the receiver's inheritance chain
      for (const info of getInheritanceChain(receiverType)) {
        // Check function access
        const fa = info.funcAccess.get(memberLower);
        if (fa?.access) {
          if (!canAccess(fa.access, info.name.toLowerCase(), selfScript)) {
            diags.push({
              range: Range.create(i, col, i, col + memberName.length),
              severity: DiagnosticSeverity.Error,
              message: `Cannot access ${fa.access} function ${memberName} declared in ${info.name}`,
              source: 'papyrus',
            });
          } else if (fa.selfOnly && receiver.toLowerCase() !== 'self' && receiver.toLowerCase() !== 'parent') {
            diags.push({
              range: Range.create(i, col, i, col + memberName.length),
              severity: DiagnosticSeverity.Error,
              message: `Cannot access self-only function ${memberName} declared in ${info.name}`,
              source: 'papyrus',
            });
          }
          break;
        }
        // Check property access
        const prop = info.properties.find(p => p.name.toLowerCase() === memberLower);
        if (prop?.access) {
          if (!canAccess(prop.access, info.name.toLowerCase(), selfScript)) {
            diags.push({
              range: Range.create(i, col, i, col + memberName.length),
              severity: DiagnosticSeverity.Error,
              message: `Cannot access ${prop.access} property ${memberName} declared in ${info.name}`,
              source: 'papyrus',
            });
          } else if (prop.selfOnly && receiver.toLowerCase() !== 'self' && receiver.toLowerCase() !== 'parent') {
            diags.push({
              range: Range.create(i, col, i, col + memberName.length),
              severity: DiagnosticSeverity.Error,
              message: `Cannot access self-only property ${memberName} declared in ${info.name}`,
              source: 'papyrus',
            });
          }
          break;
        }
        if (fa || prop) break; // found the member (no access modifier = public, stop)
      }
    }
  }

  return diags;
}

/**
 * Conditional compilation warnings: DebugOnly / BetaOnly.
 *
 * DebugOnly functions are silently removed in release builds.
 * BetaOnly functions are silently removed in final builds.
 *
 * We warn when a function marked with these flags is called from a context
 * that is NOT marked with the same flag — matching the compiler's
 * ShouldRemoveFunctionCall logic.
 */
function checkConditionalCompilation(doc: TextDocument): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const typeMap    = buildTypeMap(doc);
  const selfScript = typeMap.get('self') ?? '';
  const selfInfo   = selfScript ? scriptDb.get(selfScript) : undefined;

  // Compile-time flags of the current script (inherited by all its functions)
  const docDebugOnly = selfInfo?.scriptDebugOnly ?? false;
  const docBetaOnly  = selfInfo?.scriptBetaOnly  ?? false;

  const lines = doc.getText().split(/\r?\n/);
  let curFuncDebugOnly = docDebugOnly;
  let curFuncBetaOnly  = docBetaOnly;
  let inFunc = false;

  function warn(line: number, col: number, len: number, msg: string): void {
    diags.push({ range: Range.create(line, col, line, col + len), severity: DiagnosticSeverity.Warning, message: msg, source: 'papyrus' });
  }

  // Dot-call pattern: `receiver.funcName(`
  const DOTCALL_RE = /\b(\w+)\s*\.\s*(\w+)\s*\(/g;

  for (let i = 0; i < lines.length; i++) {
    const raw      = lines[i].replace(/;.*$/, '');
    const stripped = raw.trim();
    if (!stripped) continue;

    // ── Function/Event entry: capture DebugOnly/BetaOnly flags ──────────────
    const fmatch = FUNC_RE.exec(stripped);
    const ematch = !fmatch ? EVENT_RE.exec(stripped) : null;
    if (fmatch || ematch) {
      const flags4 = fmatch ? (fmatch[4] ?? '').toLowerCase() : '';
      curFuncDebugOnly = docDebugOnly || /\bdebugonly\b/.test(flags4);
      curFuncBetaOnly  = docBetaOnly  || /\bbetaonly\b/.test(flags4);
      inFunc = true;
      continue;
    }
    if (/^end(?:function|event)\b/i.test(stripped)) {
      curFuncDebugOnly = docDebugOnly;
      curFuncBetaOnly  = docBetaOnly;
      inFunc = false;
      continue;
    }
    if (!inFunc) continue;

    // ── Scan dot-access calls ─────────────────────────────────────────────
    DOTCALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DOTCALL_RE.exec(raw)) !== null) {
      const receiver = m[1];
      const funcName = m[2];
      const funcLow  = funcName.toLowerCase();
      // Column of the function name itself (after the dot)
      const col = m.index + m[0].lastIndexOf(funcName);

      const recvType = resolveExprType(receiver, typeMap);
      if (!recvType || recvType.endsWith('[]')) continue;

      const targetInfo = scriptDb.get(recvType);

      // Script-level flag: every function in the script is DebugOnly/BetaOnly
      if (targetInfo?.scriptDebugOnly && !curFuncDebugOnly) {
        warn(i, col, funcName.length, `Call to DebugOnly function '${funcName}' will be removed in release builds`);
        continue;
      }
      if (targetInfo?.scriptBetaOnly && !curFuncBetaOnly) {
        warn(i, col, funcName.length, `Call to BetaOnly function '${funcName}' will be removed in final builds`);
        continue;
      }

      // Function-level flag in the inheritance chain
      for (const chainInfo of getInheritanceChain(recvType)) {
        const fa = chainInfo.funcAccess.get(funcLow);
        if (fa?.debugOnly && !curFuncDebugOnly) {
          warn(i, col, funcName.length, `Call to DebugOnly function '${funcName}' will be removed in release builds`);
          break;
        }
        if (fa?.betaOnly && !curFuncBetaOnly) {
          warn(i, col, funcName.length, `Call to BetaOnly function '${funcName}' will be removed in final builds`);
          break;
        }
        if (fa !== undefined) break; // found the member — it's public; stop
      }
    }

    // ── Bare calls (own method or global import) ───────────────────────────
    // Pattern: identifier( — but not after a dot, and not a keyword
    const BARE_RE = /(?<![.\w])([A-Za-z_]\w*)\s*\(/g;
    BARE_RE.lastIndex = 0;
    while ((m = BARE_RE.exec(raw)) !== null) {
      const funcName = m[1];
      const funcLow  = funcName.toLowerCase();
      if (STMT_KEYWORDS.has(funcLow)) continue;
      if (funcLow === 'if' || funcLow === 'while' || funcLow === 'elseif') continue;
      // Avoid re-checking names already caught as `receiver.funcName`
      if (m.index > 0 && raw[m.index - 1] === '.') continue;

      const col = m.index;

      // Check own chain (self calls)
      if (selfScript) {
        for (const chainInfo of getInheritanceChain(selfScript)) {
          const fa = chainInfo.funcAccess.get(funcLow);
          if (fa?.debugOnly && !curFuncDebugOnly) {
            warn(i, col, funcName.length, `Call to DebugOnly function '${funcName}' will be removed in release builds`);
            break;
          }
          if (fa?.betaOnly && !curFuncBetaOnly) {
            warn(i, col, funcName.length, `Call to BetaOnly function '${funcName}' will be removed in final builds`);
            break;
          }
          if (fa !== undefined) break;
        }
      }
    }
  }

  return diags;
}

// ── Guard regex constants ──────────────────────────────────────────────────────
const GUARD_DECL_RE      = /^\s*guard\s+(\w+)(.*)/i;
const LOCKGUARD_RE       = /^\s*lockguard\b(.*)/i;
const TRYLOCKGUARD_RE    = /^\s*(try|else)lockguard\b(.*)|^\s*elsetrylockguard\b(.*)/i;
const ENDLOCKGUARD_RE    = /^\s*endlockguard\b/i;
const ENDTRYLOCKGUARD_RE = /^\s*endtrylockguard\b/i;
const REQUIRESGUARD_RE   = /\bRequiresGuard\s*\(([^)]*)\)/gi;

/** Extract comma/space-separated identifiers from a guard name list string */
function parseGuardNames(text: string): string[] {
  return text.split(/[\s,]+/).map(s => s.trim()).filter(s => /^\w+$/.test(s));
}

/**
 * Guard system diagnostics (Starfield-specific).
 * Checks all 15 distinct guard-related compiler errors statically.
 */
function checkGuards(doc: TextDocument): Diagnostic[] {
  const lines = doc.getText().split(/\r?\n/);
  const diags: Diagnostic[] = [];

  function err(line: number, col: number, end: number, msg: string, sev: DiagnosticSeverity = DiagnosticSeverity.Error): void {
    diags.push({ range: Range.create(line, col, line, Math.max(col + 1, end)), severity: sev, message: msg, source: 'papyrus' });
  }

  function colOf(raw: string, word: string, from = 0): number {
    const idx = raw.toLowerCase().indexOf(word.toLowerCase(), from);
    return idx < 0 ? 0 : idx;
  }

  // ── Pass 1: collect Guard declarations ────────────────────────────────────
  // guardDecls: name.lower → { line, isFuncLogic }
  const guardDecls = new Map<string, { line: number; isFuncLogic: boolean }>();
  let funcDepth = 0;
  let inBC = false; // block comment

  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    if (inBC) { const ci = raw.indexOf('/;'); if (ci !== -1) { inBC = false; raw = raw.slice(ci + 2); } else continue; }
    const bo = raw.indexOf(';/');
    if (bo !== -1) { const bc = raw.indexOf('/;', bo + 2); if (bc !== -1) { raw = raw.slice(0, bo) + raw.slice(bc + 2); } else { inBC = true; raw = raw.slice(0, bo); } }
    const stripped = raw.replace(/;.*$/, '').trim();
    if (!stripped) continue;
    const t0l = stripped.split(/\s+/)[0].toLowerCase();

    if (FUNC_RE.test(stripped) || EVENT_RE.test(stripped)) { funcDepth++; continue; }
    if (/^end(?:function|event)\b/i.test(stripped)) { funcDepth = Math.max(0, funcDepth - 1); continue; }

    const dm = GUARD_DECL_RE.exec(stripped);
    if (dm) {
      const gname = dm[1];
      const glower = gname.toLowerCase();
      const isFuncLogic = /\bProtectsFunctionLogic\b/i.test(dm[2] ?? '');
      const col = colOf(raw, gname);

      if (funcDepth > 0) {
        // Guard declarations must be at script level
        err(i, col, col + gname.length, `script guard ${gname} cannot be defined inside a function`);
      } else if (guardDecls.has(glower)) {
        err(i, col, col + gname.length, `script guard ${gname} already defined`);
      } else {
        guardDecls.set(glower, { line: i, isFuncLogic });
      }
    }
  }

  if (guardDecls.size === 0) return diags; // no guards → skip all further checks

  // ── Pass 2: check all guard uses ──────────────────────────────────────────
  // Track guard usage for "guard not protecting anything" check
  const guardsUsedOnData     = new Set<string>(); // guard used on var/prop
  const guardsUsedOnFunc     = new Set<string>(); // guard used on function
  // Track locked-guard stack for "already locked" and "global function" checks
  let inGlobal = false;
  funcDepth = 0;
  inBC = false;
  // Stack of guard-name arrays per LockGuard depth (per-function, reset on function entry)
  let lockStack: string[][] = [];
  function lockedNow(): Set<string> { const s = new Set<string>(); for (const l of lockStack) l.forEach(g => s.add(g)); return s; }

  // Names of all functions, events, properties (for naming-conflict check)
  const identNames = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    if (inBC) { const ci = raw.indexOf('/;'); if (ci !== -1) { inBC = false; raw = raw.slice(ci + 2); } else continue; }
    const bo2 = raw.indexOf(';/');
    if (bo2 !== -1) { const bc = raw.indexOf('/;', bo2 + 2); if (bc !== -1) { raw = raw.slice(0, bo2) + raw.slice(bc + 2); } else { inBC = true; raw = raw.slice(0, bo2); } }
    const stripped = raw.replace(/;.*$/, '').trim();
    if (!stripped) continue;
    const tokens = stripped.split(/\s+/);
    const t0l = tokens[0].toLowerCase();

    // ── Function / Event entry ─────────────────────────────────────────────
    const fmatch = FUNC_RE.exec(stripped);
    const ematch = !fmatch ? EVENT_RE.exec(stripped) : null;
    if (fmatch || ematch) {
      funcDepth++;
      lockStack = [];
      inGlobal = fmatch ? /\bglobal\b/i.test(fmatch[4] ?? '') : false;
      // Collect function/event name for conflict check
      const fname = fmatch ? fmatch[2] : ematch![1].split('.').pop()!;
      if (fname) identNames.add(fname.toLowerCase());
      // Check RequiresGuard on function declaration
      const rMatches = [...stripped.matchAll(REQUIRESGUARD_RE)];
      for (const rm of rMatches) {
        const gnames = parseGuardNames(rm[1]);
        if (gnames.length > 1) {
          const col = raw.indexOf(rm[0]);
          err(i, col, col + rm[0].length, `variables may not require more than one guard`);
        }
        for (const gn of gnames) {
          const gl = gn.toLowerCase();
          const col = colOf(raw, gn, raw.toLowerCase().indexOf('requiresguard'));
          if (!guardDecls.has(gl)) {
            err(i, col, col + gn.length, `${fmatch ? 'function' : 'event'} ${fname} cannot require guard ${gn} because a guard with that name does not exist`);
          } else {
            guardsUsedOnFunc.add(gl);
          }
        }
      }
      continue;
    }
    if (/^end(?:function|event)\b/i.test(stripped)) {
      funcDepth = Math.max(0, funcDepth - 1);
      lockStack = [];
      inGlobal = false;
      continue;
    }

    // ── Guard declaration (already handled in pass 1) ──────────────────────
    if (GUARD_DECL_RE.test(stripped)) continue;

    // ── LockGuard ─────────────────────────────────────────────────────────
    const lgm = LOCKGUARD_RE.exec(stripped);
    if (lgm) {
      const gnames = parseGuardNames(lgm[1]);
      const currently = lockedNow();
      const thisLevel: string[] = [];
      for (const gn of gnames) {
        const gl = gn.toLowerCase();
        const col = colOf(raw, gn);
        if (!guardDecls.has(gl)) {
          err(i, col, col + gn.length, `guard ${gn} is undefined`);
        } else {
          if (inGlobal)    err(i, col, col + gn.length, `Guards cannot be locked in global functions`);
          if (currently.has(gl)) err(i, col, col + gn.length, `guard ${gn} is already locked, and does not need to be locked again`);
          thisLevel.push(gl);
        }
      }
      lockStack.push(thisLevel);
      continue;
    }

    // ── EndLockGuard ──────────────────────────────────────────────────────
    if (ENDLOCKGUARD_RE.test(stripped)) {
      if (lockStack.length > 0) lockStack.pop();
      continue;
    }

    // ── TryLockGuard / ElseTryLockGuard ───────────────────────────────────
    const tlm = /^\s*(?:else)?trylockguard\b(.*)/i.exec(stripped);
    if (tlm) {
      const gnames = parseGuardNames(tlm[1]);
      for (const gn of gnames) {
        const gl = gn.toLowerCase();
        const col = colOf(raw, gn);
        if (!guardDecls.has(gl))     err(i, col, col + gn.length, `guard ${gn} is undefined`);
        else if (inGlobal)            err(i, col, col + gn.length, `Guards cannot be locked in global functions`);
      }
      // TryLockGuard lock is conditional — don't push to lockStack for "already locked" checks
      continue;
    }
    if (ENDTRYLOCKGUARD_RE.test(stripped)) continue;

    // ── Property declaration ───────────────────────────────────────────────
    if (tokens.length >= 3 && tokens[1]?.toLowerCase() === 'property') {
      const propName = tokens[2];
      identNames.add(propName.toLowerCase());
      const isAuto = /\bauto(?:readonly)?\b/i.test(stripped);
      const rMatches2 = [...stripped.matchAll(REQUIRESGUARD_RE)];
      for (const rm of rMatches2) {
        const col = raw.indexOf(rm[0]);
        if (!isAuto) {
          err(i, col, col + rm[0].length, `Only auto properties can have guard requirements - non-auto properties can only have guard requirements on their get and set functions`);
          continue;
        }
        const gnames = parseGuardNames(rm[1]);
        if (gnames.length > 1) {
          err(i, col, col + rm[0].length, `auto properties may not require more than one guard`);
        }
        if (/\bSelfOnly\b/i.test(stripped)) {
          err(i, col, col + rm[0].length, `RequiresGuard cannot be used with SelfOnly, as requiring a guard implies self-only`);
        }
        if (/\bProtected\b/i.test(stripped)) {
          err(i, col, col + rm[0].length, `RequiresGuard cannot be used with an access modifier, as requiring a guard implies private`);
        }
        for (const gn of gnames) {
          const gl = gn.toLowerCase();
          const gcol = colOf(raw, gn, raw.toLowerCase().indexOf('requiresguard'));
          if (!guardDecls.has(gl)) {
            err(i, gcol, gcol + gn.length, `${propName} cannot require guard ${gn} because a guard with that name does not exist`);
          } else {
            const gd = guardDecls.get(gl)!;
            if (gd.isFuncLogic) {
              err(i, gcol, gcol + gn.length, `${propName} cannot require guard ${gn} because the guard is flagged as protecting function logic only`);
            } else {
              guardsUsedOnData.add(gl);
            }
          }
        }
      }
      continue;
    }

    // ── Variable declaration (possibly with RequiresGuard) ─────────────────
    if (funcDepth === 0 && tokens.length >= 2 && isKnownType(tokens[0])) {
      const rMatches3 = [...stripped.matchAll(REQUIRESGUARD_RE)];
      for (const rm of rMatches3) {
        const col = raw.indexOf(rm[0]);
        const gnames = parseGuardNames(rm[1]);
        if (gnames.length > 1) err(i, col, col + rm[0].length, `variables may not require more than one guard`);
        if (/\bSelfOnly\b/i.test(stripped)) {
          err(i, col, col + rm[0].length, `RequiresGuard cannot be used with SelfOnly, as requiring a guard implies self-only`);
        }
        if (/\bProtected\b/i.test(stripped)) {
          err(i, col, col + rm[0].length, `RequiresGuard cannot be used with an access modifier, as requiring a guard implies private`);
        }
        for (const gn of gnames) {
          const gl = gn.toLowerCase();
          const gcol = colOf(raw, gn, raw.toLowerCase().indexOf('requiresguard'));
          if (!guardDecls.has(gl)) {
            err(i, gcol, gcol + gn.length, `${tokens[1]} cannot require guard ${gn} because a guard with that name does not exist`);
          } else {
            const gd = guardDecls.get(gl)!;
            if (gd.isFuncLogic) {
              err(i, gcol, gcol + gn.length, `${tokens[1]} cannot require guard ${gn} because the guard is flagged as protecting function logic only`);
            } else {
              guardsUsedOnData.add(gl);
            }
          }
        }
      }
    }
  }

  // ── Post-scan checks ──────────────────────────────────────────────────────
  for (const [gl, gd] of guardDecls) {
    const rawLine = lines[gd.line];
    const m = GUARD_DECL_RE.exec(rawLine.replace(/;.*$/, '').trim());
    const gname = m ? m[1] : gl;
    const col = colOf(rawLine, gname);

    // Guard name conflicts with a function/property/event name
    if (identNames.has(gl)) {
      err(gd.line, col, col + gname.length, `${gname} cannot have the same name as a guard`);
    }

    if (gd.isFuncLogic) {
      // ProtectsFunctionLogic guard: valid if used on at least one function
      // (no error if only used on functions — that's its purpose)
    } else {
      // Data guard: must protect at least one variable or auto property
      if (!guardsUsedOnData.has(gl)) {
        err(gd.line, col, col + gname.length,
          `guard ${gname} is not protecting any variables or auto properties`,
          DiagnosticSeverity.Warning);
      }
    }
  }

  return diags;
}

/**
 * Semantic checks run only when the compiler is absent.
 * The compiler supersedes these with authoritative type/name errors.
 */
function checkSemantics(doc: TextDocument): Diagnostic[] {
  const lines = doc.getText().split(/\r?\n/);
  const diags: Diagnostic[] = [];

  function flagUnknownType(typeName: string, line: number, col: number): void {
    if (!typeName || col < 0) return;
    const base = typeName.replace(/\[\]$/, '');
    if (STMT_KEYWORDS.has(base.toLowerCase()) || isKnownType(base)) return;
    diags.push({
      range: Range.create(line, col, line, col + typeName.length),
      severity: DiagnosticSeverity.Error,
      message: `unknown type ${typeName}`,
      source: 'papyrus',
    });
  }

  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];

    if (inBlockComment) {
      const ci = raw.indexOf('/;');
      if (ci !== -1) { inBlockComment = false; raw = raw.slice(ci + 2); }
      else continue;
    }
    const bo = raw.indexOf(';/');
    if (bo !== -1) {
      const bc = raw.indexOf('/;', bo + 2);
      if (bc !== -1) { raw = raw.slice(0, bo) + raw.slice(bc + 2); }
      else { inBlockComment = true; raw = raw.slice(0, bo); }
    }

    const stripped = raw.replace(/;.*$/, '').trim();
    if (!stripped) continue;
    const tokens = stripped.split(/\s+/);
    const t0l = tokens[0].toLowerCase();

    // ScriptName X [extends Y]
    if (t0l === 'scriptname') {
      const m = /\bextends\s+(\S+)/i.exec(stripped);
      if (m) {
        const base = m[1];
        const extendsIdx = raw.toLowerCase().indexOf('extends');
        const col = raw.indexOf(base, extendsIdx >= 0 ? extendsIdx : 0);
        flagUnknownType(base, i, col);
      }
      continue;
    }

    // Import X
    if (t0l === 'import' && tokens[1]) {
      const importName = tokens[1];
      const importLower = importName.toLowerCase();
      if (!scriptDb.has(importLower)) {
        const col = raw.indexOf(importName);
        if (col >= 0) diags.push({
          range: Range.create(i, col, i, col + importName.length),
          severity: DiagnosticSeverity.Error,
          message: `unknown namespace ${importName}`,
          source: 'papyrus',
        });
      }
      continue;
    }

    // Type property Name [...]
    if (tokens.length >= 3 && tokens[1]?.toLowerCase() === 'property') {
      flagUnknownType(tokens[0], i, raw.indexOf(tokens[0]));
      continue;
    }

    // [ReturnType] Function Name([Type param, ...]) [flags]
    const fm = /^\s*(?:([\w\[\]]+)\s+)?function\s+\w+\s*\(([^)]*)\)/i.exec(stripped);
    if (fm) {
      if (fm[1]) flagUnknownType(fm[1], i, raw.indexOf(fm[1]));
      if (fm[2]) {
        let searchFrom = raw.indexOf('(') + 1;
        for (const param of fm[2].split(',')) {
          const pt = param.trim().split(/\s+/)[0];
          if (pt) {
            const col = raw.indexOf(pt, searchFrom);
            if (col >= 0) { flagUnknownType(pt, i, col); searchFrom = col + pt.length; }
          }
        }
      }
      continue;
    }

    // Event [Namespace.]Name([Type param, ...])
    const em = /^\s*event\s+(?:\w+\.)?\w+\s*\(([^)]*)\)/i.exec(stripped);
    if (em) {
      const paramStr = em[1] ?? '';
      if (paramStr) {
        let searchFrom = raw.indexOf('(') + 1;
        for (const param of paramStr.split(',')) {
          const pt = param.trim().split(/\s+/)[0];
          if (pt) {
            const col = raw.indexOf(pt, searchFrom);
            if (col >= 0) { flagUnknownType(pt, i, col); searchFrom = col + pt.length; }
          }
        }
      }
    }
  }

  return diags;
}

/** Run the fast native diagnostic suite (parser + semantic checks). No compiler, no I/O spawn. */
function computeNativeDiagnostics(doc: TextDocument): Diagnostic[] {
  const text = doc.getText();
  const compilerAvailable = compilerReady;

  // Native suite always runs — provides immediate feedback and works without the compiler.
  // checkSemantics is included only when the compiler is absent; the compiler supersedes
  // it with authoritative type/name errors so there are no duplicates.
  return [
    ...parsePapyrus(text).map(rawToDiag),
    ...checkMissingReturns(text).map(rawToDiag),
    ...checkTypeMismatch(doc),
    ...checkStructural(doc),
    ...checkAccessModifiers(doc),
    ...checkAccessSites(doc),
    ...checkConditionalCompilation(doc),
    ...checkGuards(doc),
    ...analyzeUnusedImports(doc),
    ...analyzeUnusedLocals(doc),
    ...(compilerAvailable ? [] : checkSemantics(doc)),
  ];
}

/** Merge compiler diagnostics over native ones: on lines the compiler flags, its
 *  authoritative messages replace native errors; hints/unnecessary tags are always kept. */
function mergeCompilerDiags(native: Diagnostic[], compilerDiags: Diagnostic[]): Diagnostic[] {
  if (!compilerDiags.length) return native; // compiler clean — native results stand as-is
  const compilerLines = new Set(compilerDiags.map(d => d.range.start.line));
  const filtered = native.filter(d =>
    d.tags?.includes(DiagnosticTag.Unnecessary) ||
    d.severity === DiagnosticSeverity.Hint ||
    !compilerLines.has(d.range.start.line)
  );
  return [...filtered, ...compilerDiags];
}

// Shared cache so the push path (publishDiagnostics) and the pull path
// (textDocument/diagnostic) don't each spawn the compiler for the same edit.
// `final` = true once compiler results are folded in (or the compiler is unavailable);
// a native-only entry (final:false) is still refined by the compiler on a pull.
const diagCache = new Map<string, { version: number; diags: Diagnostic[]; final: boolean }>();

// De-dupe concurrent full computes for the same uri@version (e.g. overlapping pulls,
// or a pull racing the debounced push) so the compiler runs at most once per version.
const pendingCompute = new Map<string, Promise<Diagnostic[]>>();

/** Compute the full diagnostic set for a document (native + compiler when available),
 *  caching by document version. Both push and pull go through this. */
function computeDiagnostics(doc: TextDocument): Promise<Diagnostic[]> {
  const cached = diagCache.get(doc.uri);
  if (cached && cached.version === doc.version && cached.final) return Promise.resolve(cached.diags);

  const key = `${doc.uri}@${doc.version}`;
  const existing = pendingCompute.get(key);
  if (existing) return existing;

  indexDocument(doc);
  const native = computeNativeDiagnostics(doc);
  const compilerAvailable = compilerReady;

  if (!compilerAvailable) {
    diagCache.set(doc.uri, { version: doc.version, diags: native, final: true });
    return Promise.resolve(native);
  }

  const p = new Promise<Diagnostic[]>(resolve => {
    collectCompilerDiags(doc, compilerDiags => {
      pendingCompute.delete(key);
      const merged = mergeCompilerDiags(native, compilerDiags);
      diagCache.set(doc.uri, { version: doc.version, diags: merged, final: true });
      resolve(merged);
    });
  });
  pendingCompute.set(key, p);
  return p;
}

// ── Live diagnostics (two-tier, clangd-style) ─────────────────────────────────
// Fast native checks publish instantly on every edit; the slower compiler pass is
// debounced, cancellable, and stale-guarded so a late result never clobbers a newer
// edit. Every publish carries the document version so the client can drop stale sets.

const debounceTimers   = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightCompiler = new Map<string, ReturnType<typeof execFile>>();

/** Publish the instant native suite for the document's current version. */
function publishNative(doc: TextDocument): Diagnostic[] {
  indexDocument(doc);
  const native = computeNativeDiagnostics(doc);
  // Native is the final word only when there's no compiler to refine it.
  const compilerAvailable = compilerReady;
  diagCache.set(doc.uri, { version: doc.version, diags: native, final: !compilerAvailable });
  connection.sendDiagnostics({ uri: doc.uri, version: doc.version, diagnostics: native });
  return native;
}

/** Run the compiler in the background and merge its authoritative results on top of
 *  `native`, cancelling any older run for the same file and discarding stale output. */
function augmentWithCompiler(doc: TextDocument, native: Diagnostic[]): void {
  if (!compilerReady) return;
  const uri = doc.uri;
  const version = doc.version;

  // Cancel a compiler run still churning on an older version of this file.
  const prev = inFlightCompiler.get(uri);
  if (prev) { try { prev.kill(); } catch {} inFlightCompiler.delete(uri); }

  const child = collectCompilerDiags(doc, compilerDiags => {
    if (inFlightCompiler.get(uri) === child) inFlightCompiler.delete(uri);
    // Discard if the document moved on (a newer edit owns the output now). This also
    // absorbs the empty callback a killed process fires, so we never clear on cancel.
    const live = documents.get(uri);
    if (!live || live.version !== version) return;

    const merged = mergeCompilerDiags(native, compilerDiags);
    diagCache.set(uri, { version, diags: merged, final: true });
    if (!compilerDiags.length) return; // native already published and stands as-is
    connection.sendDiagnostics({ uri, version, diagnostics: merged });
    // A file's errors can change what its dependents see — ask the client to refresh.
    requestInterFileRefresh();
  });
  if (child) inFlightCompiler.set(uri, child);
}

/** Full check for a document: instant native + background compiler. */
function sendDiagnostics(doc: TextDocument): void {
  const native = publishNative(doc);
  augmentWithCompiler(doc, native);
}

/** On every keystroke: publish native immediately, debounce the compiler pass. */
function scheduleDiagnostics(doc: TextDocument): void {
  const uri = doc.uri;
  const native = publishNative(doc);
  const t = debounceTimers.get(uri);
  if (t) clearTimeout(t);
  debounceTimers.set(uri, setTimeout(() => {
    debounceTimers.delete(uri);
    const live = documents.get(uri);
    if (live && live.version === doc.version) augmentWithCompiler(live, native);
  }, 600));
}

// Coalesced inter-file refresh: when a file's compiler diagnostics change, its
// dependents may too. Pull-capable clients are asked once to re-pull everything
// (our pull handlers recompute on demand); a no-op for push-only clients.
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function requestInterFileRefresh(): void {
  if (refreshTimer || !clientDiagRefreshSupport) return; // coalescing, or nothing to do
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    try { connection.languages.diagnostics.refresh(); } catch { /* client declined */ }
  }, 400);
}

documents.onDidOpen(e => sendDiagnostics(e.document));
documents.onDidChangeContent(e => scheduleDiagnostics(e.document));
documents.onDidSave(e => sendDiagnostics(e.document)); // authoritative recheck on save
documents.onDidClose(e => {
  const uri = e.document.uri;
  const t = debounceTimers.get(uri);
  if (t) { clearTimeout(t); debounceTimers.delete(uri); }
  const c = inFlightCompiler.get(uri);
  if (c) { try { c.kill(); } catch {} inFlightCompiler.delete(uri); }
  diagCache.delete(uri);
  connection.sendDiagnostics({ uri, diagnostics: [] });
});

// ── Pull diagnostics (LSP 3.17) ───────────────────────────────────────────────
// clangd and most modern servers advertise `diagnosticProvider` and answer
// `textDocument/diagnostic` / `workspace/diagnostic` on demand, in addition to
// pushing via publishDiagnostics. This is what drives Claude Code's
// "Found N new diagnostic issues in M files" surfacing after edits.

/** Resolve a document for a pull request: prefer the open copy, else read from disk. */
function getDocForDiagnostics(uri: string): TextDocument | undefined {
  const open = documents.get(uri);
  if (open) return open;
  const fsPath = uri.replace(/^file:\/\//, '');
  try {
    const text = fs.readFileSync(decodeURIComponent(fsPath), 'utf8');
    return TextDocument.create(uri, 'papyrus', 0, text);
  } catch {
    return undefined;
  }
}

connection.languages.diagnostics.on(async (params: DocumentDiagnosticParams): Promise<DocumentDiagnosticReport> => {
  const doc = getDocForDiagnostics(params.textDocument.uri);
  if (!doc) {
    return { kind: DocumentDiagnosticReportKind.Full, items: [] };
  }
  const diags = await computeDiagnostics(doc);
  return { kind: DocumentDiagnosticReportKind.Full, items: diags };
});

connection.languages.diagnostics.onWorkspace(async (_params: WorkspaceDiagnosticParams): Promise<WorkspaceDiagnosticReport> => {
  // Report for the documents currently open in the client. We use fast native
  // checks here (no per-file compiler spawn) so a workspace pull stays cheap even
  // with thousands of scripts in scanDirs; the compiler still augments the
  // focused document through the single-document pull and the push path.
  const items: WorkspaceDocumentDiagnosticReport[] = [];
  for (const doc of documents.all()) {
    const cached = diagCache.get(doc.uri);
    const diags = cached && cached.version === doc.version
      ? cached.diags
      : (indexDocument(doc), computeNativeDiagnostics(doc));
    items.push({
      kind: DocumentDiagnosticReportKind.Full,
      uri: doc.uri,
      version: doc.version,
      items: diags,
    });
  }
  return { items };
});

connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);

  // ── Dot completion: `identifier.` or `identifier.partial` ──────────────────
  if (doc) {
    const lineUpToCursor = doc.getText({
      start: { line: params.position.line, character: 0 },
      end:   params.position,
    });

    // ── Override / implement stubs: Function/Event at script body level ──────
    const overrideStubs = buildOverrideStubs(doc, params);
    if (overrideStubs.length > 0) return overrideStubs;

    // Event-name suggestions inside string arguments to Register*Event calls
    if (isInsideString(lineUpToCursor, lineUpToCursor.length)) {
      const beforeStr = lineUpToCursor.slice(0, lineUpToCursor.lastIndexOf('"')).toLowerCase();
      if (/\bregister\w*event\b|\bunregister\w*event\b/.test(beforeStr)) {
        return [...eventNameSet].sort().map(n => ({ label: n, kind: CompletionItemKind.EnumMember, detail: 'Event name' }));
      }
      return [];
    }

    // Context-aware completions after `extends`, `as`, `import`, `new`
    const kwCtx = /\b(extends|as|import|new)\s+(\w*)$/i.exec(lineUpToCursor);
    if (kwCtx) {
      const kw = kwCtx[1].toLowerCase();
      if (kw === 'import') {
        // Only show scripts that have global functions — the only ones worth importing
        return [...scriptDb.values()]
          .filter(info => info.globals.length > 0)
          .map(info => ({ label: info.name, kind: CompletionItemKind.Module,
            detail: `${info.globals.length} global function${info.globals.length !== 1 ? 's' : ''}`, filterText: info.name }));
      }
      if (kw === 'new') {
        // Array creation: `new int[5]` or `new Actor[10]` — show primitives + scripts
        const primitiveItems: CompletionItem[] = ['int', 'float', 'bool', 'string'].map(p => ({
          label: p, kind: CompletionItemKind.Keyword, detail: 'Primitive (array)', sortText: '0_' + p,
        }));
        const scriptItems = [...scriptDb.values()].map(info => ({
          label: info.name, kind: CompletionItemKind.Class,
          detail: info.extendsType ? `extends ${info.extendsType}` : 'Script',
          filterText: info.name, sortText: '1_' + info.name,
        }));
        return [...primitiveItems, ...scriptItems];
      }
      // extends, as: object types only — primitives can't be extended or cast-to
      return [...scriptDb.values()].map(info => ({
        label: info.name,
        kind: CompletionItemKind.Class,
        detail: info.extendsType ? `extends ${info.extendsType}` : 'Script',
        filterText: info.name,
      }));
    }

    // Dot completion — handles simple vars, type names, and chained calls like Game.GetPlayer().
    const dotAccess = parseDotAccess(lineUpToCursor);
    if (dotAccess) {
      // self/parent are not in scope inside global functions
      if ((dotAccess.receiver === 'self' || dotAccess.receiver === 'parent') &&
          isGlobalScope(doc, params.position.line)) return [];
      const typeMap  = buildTypeMap(doc);
      const typeName = resolveExprType(dotAccess.receiver, typeMap);

      if (typeName) {
        // Array type: offer hardcoded intrinsic methods + Length property
        if (typeName.endsWith('[]')) {
          const elemType = typeName.slice(0, -2);
          return Object.entries(ARRAY_INTRINSICS).map(([name, intr]) => ({
            label: intr.kind === 'property' ? name.charAt(0).toUpperCase() + name.slice(1) : sigToName(resolveArraySig(intr.sig, elemType)),
            kind: intr.kind === 'property' ? CompletionItemKind.Property : CompletionItemKind.Method,
            detail: resolveArraySig(intr.sig, elemType),
            documentation: { kind: MarkupKind.Markdown, value: intr.doc },
            sortText: intr.kind === 'property' ? '0_length' : `1_${name}`,
          }));
        }

        // Struct field completions
        const sFields = structDb.get(typeName);
        if (sFields) {
          return sFields.map(f => ({ label: f.name, kind: CompletionItemKind.Field, detail: f.type }));
        }
        const chain = getInheritanceChain(typeName);
        if (chain.length > 0) {
          const items: CompletionItem[] = [];
          for (let i = 0; i < chain.length; i++) {
            const info = chain[i];
            const inheritedNote = i > 0
              ? { kind: MarkupKind.PlainText as typeof MarkupKind.PlainText, value: `Inherited from ${info.name}` }
              : undefined;

            for (const sig of info.functions) {
              const name = sigToName(sig);
              items.push({
                label: name,
                kind: CompletionItemKind.Method,
                detail: sig,
                documentation: inheritedNote,
                sortText: `${i}_${name}`,
              });
            }
            for (const prop of info.properties) {
              items.push({
                label: prop.name,
                kind: CompletionItemKind.Property,
                detail: `${prop.type} Property${prop.readonly ? ' (readonly)' : ''}`,
                documentation: inheritedNote,
                sortText: `${i}_${prop.name}`,
              });
            }
          }
          return items;
        }
      }
      // Dot after unknown identifier — return nothing rather than dumping all 4755 scripts
      return [];
    }
  }

  // ── Non-dot completion: keywords, types, scripts ───────────────────────────
  const items: CompletionItem[] = [];

  // Snippets
  const SNIPPETS: CompletionItem[] = [
    {
      label: 'fn',
      kind: CompletionItemKind.Snippet,
      detail: 'Function stub',
      insertText: 'Function ${1:Name}(${2})\n\t$0\nEndFunction',
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: '0_fn',
    },
    {
      label: 'fnr',
      kind: CompletionItemKind.Snippet,
      detail: 'Function stub with return type',
      insertText: '${1:Int} Function ${2:Name}(${3})\n\t$0\nEndFunction',
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: '0_fnr',
    },
    {
      label: 'ev',
      kind: CompletionItemKind.Snippet,
      detail: 'Event stub',
      insertText: 'Event ${1:Name}(${2})\n\t$0\nEndEvent',
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: '0_ev',
    },
    {
      label: 'prop',
      kind: CompletionItemKind.Snippet,
      detail: 'Auto property',
      insertText: '${1:Int} Property ${2:Name} Auto',
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: '0_prop',
    },
    {
      label: 'state',
      kind: CompletionItemKind.Snippet,
      detail: 'State block',
      insertText: 'State ${1:Name}\n\t$0\nEndState',
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: '0_state',
    },
  ];
  items.push(...SNIPPETS);

  for (const [kw, info] of Object.entries(KEYWORDS)) {
    items.push({ label: kw, kind: CompletionItemKind.Keyword, detail: info.detail,
      documentation: { kind: MarkupKind.Markdown, value: info.doc } });
  }

  for (const t of BUILTIN_TYPES) {
    items.push({ label: t, kind: CompletionItemKind.Class, detail: 'Built-in type',
      documentation: { kind: MarkupKind.Markdown, value: `**\`${t}\`** — Papyrus built-in object type.` } });
  }

  for (const g of BUILTIN_GLOBALS) {
    items.push({ label: g.label, kind: CompletionItemKind.Module, detail: g.detail,
      documentation: { kind: MarkupKind.Markdown, value: g.doc } });
  }

  for (const f of FLAGS) {
    items.push({ label: f, kind: CompletionItemKind.EnumMember, detail: 'Papyrus flag' });
  }

  for (const ev of STARFIELD_EVENTS) {
    const label = ev.sig.replace(/^Event /, '').replace(/\(.*$/, '');
    items.push({ label, kind: CompletionItemKind.Event, detail: ev.sig,
      documentation: { kind: MarkupKind.Markdown, value: (ev.base ? `*${ev.base} event*\n\n` : '') + ev.doc },
      insertText: ev.sig,
    });
  }

  for (const [, info] of scriptDb) {
    const extStr = info.extendsType ? ` extends ${info.extendsType}` : '';
    items.push({
      label: info.name,
      kind: CompletionItemKind.Class,
      detail: `Script${extStr}`,
      data: { kind: 'script', name: info.name.toLowerCase() },
    });
  }

  // __state — compiler-injected string var, available in non-global function scope
  if (doc && !isGlobalScope(doc, params.position.line)) {
    items.push({
      label: '__state',
      kind: CompletionItemKind.Variable,
      detail: 'String (current state name)',
      documentation: {
        kind: MarkupKind.Markdown,
        value: `Compiler-injected \`string\` variable holding the current script state (\`::state\` in bytecode).\n\n` +
               `**Prefer \`GetState()\` / \`GotoState()\` instead.**`,
      },
      sortText: '4___state',
    });
  }

  // Self-method completions — current script's own and inherited functions/properties
  if (doc) {
    const selfType = buildTypeMap(doc).get('self');
    if (selfType) {
      const chain = getInheritanceChain(selfType);
      for (let i = 0; i < chain.length; i++) {
        const info = chain[i];
        const note = i > 0
          ? { kind: MarkupKind.PlainText as typeof MarkupKind.PlainText, value: `Inherited from ${info.name}` }
          : undefined;
        for (const sig of info.functions)
          items.push({ label: sigToName(sig), kind: CompletionItemKind.Method, detail: sig, documentation: note, sortText: `5_${i}_${sigToName(sig)}` });
        for (const prop of info.properties)
          items.push({ label: prop.name, kind: CompletionItemKind.Property, detail: `${prop.type} Property${prop.readonly ? ' (readonly)' : ''}`, documentation: note, sortText: `5_${i}_${prop.name}` });
      }
    }
  }

  return items;
});

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const line = doc.getText({
    start: { line: params.position.line, character: 0 },
    end:   { line: params.position.line + 1, character: 0 },
  });

  // Find word at cursor (allow colon for namespaced names like COL:TaxScript)
  let s = params.position.character;
  let e = params.position.character;
  while (s > 0 && /[\w:]/.test(line[s - 1])) s--;
  while (e < line.length && /[\w:]/.test(line[e])) e++;
  const word = line.slice(s, e).replace(/^:+|:+$/g, '');
  if (!word) return null;

  const wl = word.toLowerCase();

  // self / parent → show the current script's type chain
  if (wl === 'self' || wl === 'parent') {
    if (isGlobalScope(doc, params.position.line)) return null;
    const resolved = buildTypeMap(doc).get(wl);
    if (resolved) {
      const chain = getInheritanceChain(resolved);
      if (chain.length > 0)
        return { contents: { kind: MarkupKind.Markdown, value: buildScriptHoverMd(chain, `\`${word}\` — `) } };
    }
  }

  // __state → compiler-injected string holding the current state name
  if (wl === '__state') {
    if (isGlobalScope(doc, params.position.line)) return null;
    return { contents: { kind: MarkupKind.Markdown, value:
      `\`\`\`papyrus\nString __state\n\`\`\`\n\n` +
      `Compiler-injected variable holding the current script state name (\`::state\` in bytecode).\n\n` +
      `**Prefer \`GetState()\` / \`GotoState()\` instead** — direct assignment to \`__state\` bypasses state-change events.`
    } };
  }

  // Qualified struct type: Script:Struct
  if (wl.includes(':')) {
    const sFields = structDb.get(wl);
    if (sFields) {
      const structLabel = wl.split(':')[1];
      return { contents: { kind: MarkupKind.Markdown, value:
        `**\`${structLabel}\`** struct\n\n` + sFields.slice(0, 12).map(f => `- \`${f.type} ${f.name}\``).join('\n') } };
    }
    return null;
  }

  const kwKey = Object.keys(KEYWORDS).find(k => k.toLowerCase() === wl);
  if (kwKey) {
    const kw = KEYWORDS[kwKey];
    return { contents: { kind: MarkupKind.Markdown, value: `\`\`\`papyrus\n${kw.detail}\n\`\`\`\n${kw.doc}` } };
  }

  // Type name hover (direct script lookup)
  const typeChain = getInheritanceChain(wl);
  if (typeChain.length > 0)
    return { contents: { kind: MarkupKind.Markdown, value: buildScriptHoverMd(typeChain) } };

  // Variable/parameter/property name hover — resolve type via document type map
  const varType = buildTypeMap(doc).get(wl);
  if (varType) {
    // Array variable: show element type chain with an "array" label
    if (varType.endsWith('[]')) {
      const elemType = varType.slice(0, -2);
      const displayType = elemType.charAt(0).toUpperCase() + elemType.slice(1);
      const elemChain = getInheritanceChain(elemType);
      if (elemChain.length > 0)
        return { contents: { kind: MarkupKind.Markdown, value: buildScriptHoverMd(elemChain, `\`${word}\` — \`${displayType}[]\` array — `) } };
      return { contents: { kind: MarkupKind.Markdown, value: `\`${word}\` — \`${displayType}[]\` array` } };
    }
    const sFields = structDb.get(varType);
    if (sFields) {
      const structLabel = varType.split(':')[1] ?? varType;
      const md = `\`${word}\` — **\`${structLabel}\`** struct\n\n` +
        sFields.slice(0, 12).map(f => `- \`${f.type} ${f.name}\``).join('\n');
      return { contents: { kind: MarkupKind.Markdown, value: md } };
    }
    const varChain = getInheritanceChain(varType);
    if (varChain.length > 0)
      return { contents: { kind: MarkupKind.Markdown, value: buildScriptHoverMd(varChain, `\`${word}\` — `) } };
  }

  const builtinType = BUILTIN_TYPES.find(t => t.toLowerCase() === wl);
  if (builtinType)
    return { contents: { kind: MarkupKind.Markdown, value: `**\`${builtinType}\`** — Papyrus built-in type` } };

  const global = BUILTIN_GLOBALS.find(g => g.label.toLowerCase() === wl);
  if (global)
    return { contents: { kind: MarkupKind.Markdown, value: `**\`${global.label}\`** — ${global.detail}\n\n${global.doc}` } };

  // Bare function / property hover — look up in the current script's own inheritance chain.
  // In global functions only global functions are in scope; member functions are not.
  if (!isGlobalScope(doc, params.position.line)) {
    const selfType = buildTypeMap(doc).get('self');
    if (selfType) {
      const found = findFunctionAndOwner(selfType, wl);
      if (found) {
        const docComment = funcDocDb.get(`${found.ownerLower}.${wl}`);
        const md = `\`\`\`papyrus\n${found.sig}\n\`\`\`` + (docComment ? `\n\n${docComment}` : '');
        return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
      const propType = findPropertyTypeInChain(selfType, wl);
      if (propType) {
        const ownerForProp = getInheritanceChain(selfType).find(s => s.properties.some(p => p.name.toLowerCase() === wl));
        const propDoc = ownerForProp ? propDocDb.get(`${ownerForProp.name.toLowerCase()}.${wl}`) : undefined;
        const md = `\`\`\`papyrus\n${propType} Property ${word}\n\`\`\`` + (propDoc ? `\n\n${propDoc}` : '');
        return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }
  }

  // Chained call hover — `receiver.Word` where Word is a function, property, or array intrinsic
  if (s > 0 && line[s - 1] === '.') {
    const typeMap    = buildTypeMap(doc);
    const receiverTx = scanReceiver(line, s - 1);
    const typeName   = receiverTx ? resolveExprType(receiverTx, typeMap) : null;
    if (typeName) {
      // Array intrinsic hover: arr.Find, arr.Length, etc.
      if (typeName.endsWith('[]')) {
        const intr = ARRAY_INTRINSICS[wl];
        if (intr) {
          const elemType = typeName.slice(0, -2);
          const sig = resolveArraySig(intr.sig, elemType);
          const md = `\`\`\`papyrus\n${sig}\n\`\`\`\n\n${intr.doc}`;
          return { contents: { kind: MarkupKind.Markdown, value: md } };
        }
        return null;
      }
      const found = findFunctionAndOwner(typeName, wl);
      if (found) {
        const docComment = funcDocDb.get(`${found.ownerLower}.${wl}`);
        const md = `\`\`\`papyrus\n${found.sig}\n\`\`\`` + (docComment ? `\n\n${docComment}` : '');
        return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
      const propType = findPropertyTypeInChain(typeName, wl);
      if (propType) {
        const ownerForProp = [...getInheritanceChain(typeName)].find(s => s.properties.some(p => p.name.toLowerCase() === wl));
        const propDoc = ownerForProp ? propDocDb.get(`${ownerForProp.name.toLowerCase()}.${wl}`) : undefined;
        const md = `\`\`\`papyrus\n${propType} Property ${word}\n\`\`\`` + (propDoc ? `\n\n${propDoc}` : '');
        return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }
  }

  return null;
});

connection.onSignatureHelp((params): SignatureHelp | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const lineText = doc.getText({
    start: { line: params.position.line, character: 0 },
    end:   params.position,
  });

  // Find innermost unclosed '(' scanning right-to-left.
  // Track [] pairs so array-subscript expressions like arr[Bar(x)] don't confuse the depth counter.
  let depth = 0, openIdx = -1;
  for (let i = lineText.length - 1; i >= 0; i--) {
    const c = lineText[i];
    if      (c === ')' || c === ']') depth++;
    else if (c === '[') { if (depth > 0) depth--; }
    else if (c === '(') { if (depth === 0) { openIdx = i; break; } depth--; }
  }
  if (openIdx === -1) return null;

  // Count commas at top nesting depth → active parameter index
  let activeParam = 0, innerDepth = 0;
  for (let i = openIdx + 1; i < lineText.length; i++) {
    const c = lineText[i];
    if      (c === '(' || c === '[') innerDepth++;
    else if (c === ')' || c === ']') innerDepth--;
    else if (c === ',' && innerDepth === 0) activeParam++;
  }

  // Identify `receiver.FuncName(` or bare `FuncName(`
  const beforeParen = lineText.slice(0, openIdx).trimEnd();
  let sig: string | null = null;

  const callRec = parseCallReceiver(beforeParen);
  if (callRec) {
    const typeMap  = buildTypeMap(doc);
    const typeName = resolveExprType(callRec.receiver, typeMap);
    if (typeName) {
      // Array intrinsic signature help: arr.Find(, arr.Add(, etc.
      if (typeName.endsWith('[]')) {
        const intr = ARRAY_INTRINSICS[callRec.funcName.toLowerCase()];
        if (intr && intr.kind === 'method') {
          sig = resolveArraySig(intr.sig, typeName.slice(0, -2));
        }
      } else {
        sig = findFunctionInChain(typeName, callRec.funcName.toLowerCase());
      }
    }
  } else {
    const plainCall = /(\w+)$/.exec(beforeParen);
    if (plainCall) {
      const selfType = buildTypeMap(doc).get('self');
      if (selfType) {
        if (selfType.endsWith('[]')) {
          const intr = ARRAY_INTRINSICS[plainCall[1].toLowerCase()];
          if (intr && intr.kind === 'method') sig = resolveArraySig(intr.sig, selfType.slice(0, -2));
        } else {
          sig = findFunctionInChain(selfType, plainCall[1].toLowerCase());
        }
      }
    }
  }

  if (!sig) return null;
  return { signatures: [buildSignatureInfo(sig)], activeSignature: 0, activeParameter: activeParam };
});

// ── Inlay hints (parameter names) ────────────────────────────────────────────

connection.languages.inlayHint.on((params: InlayHintParams): InlayHint[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const hints:   InlayHint[] = [];
  const typeMap  = buildTypeMap(doc);
  const startLn  = params.range.start.line;
  const endLn    = params.range.end.line;

  for (let ln = startLn; ln <= endLn; ln++) {
    const raw = doc.getText({ start: { line: ln, character: 0 }, end: { line: ln, character: 9999 } });
    const lineText = raw.replace(/;.*$/, '');

    for (let i = 0; i < lineText.length; i++) {
      if (lineText[i] !== '(') continue;

      const beforeParen = lineText.slice(0, i).trimEnd();
      let sig: string | null = null;
      const callRec = parseCallReceiver(beforeParen);
      if (callRec) {
        const t = resolveExprType(callRec.receiver, typeMap);
        if (t) sig = findFunctionInChain(t, callRec.funcName.toLowerCase());
      } else {
        const plain = /(\w+)$/.exec(beforeParen);
        if (plain) {
          const selfType = typeMap.get('self');
          if (selfType) sig = findFunctionInChain(selfType, plain[1].toLowerCase());
        }
      }
      if (!sig) continue;

      // Parse parameter names from signature
      const op = sig.indexOf('('), cl = sig.lastIndexOf(')');
      if (op === -1 || cl <= op) continue;
      const paramNames = sig.slice(op + 1, cl).split(',').map(p => {
        const parts = p.trim().split(/\s+/);
        return parts.length >= 2 ? parts[1].replace(/=.*$/, '').trim() : '';
      }).filter(n => n && /^\w+$/.test(n));
      if (paramNames.length < 2) continue;

      // Walk argument positions inside the call parens
      let depth = 0, argIdx = 0;
      hints.push({ position: { line: ln, character: i + 1 }, label: `${paramNames[0]}:`, kind: InlayHintKind.Parameter, paddingRight: true });
      argIdx = 1;
      for (let j = i + 1; j < lineText.length && argIdx < paramNames.length; j++) {
        const c = lineText[j];
        if      (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') { if (depth === 0) break; depth--; }
        else if (c === ',' && depth === 0) {
          let pos = j + 1;
          while (pos < lineText.length && lineText[pos] === ' ') pos++;
          hints.push({ position: { line: ln, character: pos }, label: `${paramNames[argIdx]}:`, kind: InlayHintKind.Parameter, paddingRight: true });
          argIdx++;
        }
      }
    }
  }
  return hints;
});

// ── Document symbols (Ctrl+Shift+O outline) ───────────────────────────────────

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const symbols: DocumentSymbol[] = [];
  const lines = doc.getText().split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const lineRange = Range.create(i, 0, i, raw.length);

    const sm = SCRIPTNAME_RE.exec(line);
    if (sm) { symbols.push(DocumentSymbol.create(sm[1], sm[2] ? `extends ${sm[2]}` : undefined, SymbolKind.Class, lineRange, lineRange)); continue; }

    const fm = FUNC_RE.exec(line);
    if (fm) { symbols.push(DocumentSymbol.create(`${fm[2]}(${fm[3] ?? ''})`, fm[1] ?? 'void', SymbolKind.Function, lineRange, lineRange)); continue; }

    const em = EVENT_RE.exec(line);
    if (em) { symbols.push(DocumentSymbol.create(`${em[1]}(${em[2] ?? ''})`, undefined, SymbolKind.Event, lineRange, lineRange)); continue; }

    const cem = /^\s*customevent\s+(\w+)/i.exec(line);
    if (cem) { symbols.push(DocumentSymbol.create(cem[1], 'CustomEvent', SymbolKind.Event, lineRange, lineRange)); continue; }

    const pm = PROP_RE.exec(line);
    if (pm) { symbols.push(DocumentSymbol.create(pm[2], pm[1], SymbolKind.Property, lineRange, lineRange)); }
  }

  return symbols;
});

// ── Workspace symbol search ───────────────────────────────────────────────────

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams): SymbolInformation[] => {
  const q = params.query.toLowerCase();
  const results: SymbolInformation[] = [];

  for (const info of scriptDb.values()) {
    if (results.length >= 200) break;

    const nameLower = info.name.toLowerCase();
    if (q && !nameLower.includes(q)) continue;

    const uri = info.sourcePath ? `file://${info.sourcePath}` : '';
    results.push(SymbolInformation.create(
      info.name,
      SymbolKind.Class,
      Range.create(0, 0, 0, 0),
      uri,
    ));
  }

  return results;
});

// ── Find references ───────────────────────────────────────────────────────────

connection.onReferences((params: ReferenceParams): Location[] => {
  if (!refIndexReady) return [];
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const pos  = params.position;
  const line = doc.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line, character: 9999 } });
  let start = pos.character, end = pos.character;
  while (start > 0 && /\w/.test(line[start - 1])) start--;
  while (end < line.length && /\w/.test(line[end])) end++;
  const word = line.slice(start, end);
  if (!word) return [];

  const wl = word.toLowerCase();
  let typeName = scriptDb.has(wl) ? wl : buildTypeMap(doc).get(wl);
  if (!typeName) return [];

  return refIndex.get(typeName) ?? [];
});

// ── Go-to-definition ──────────────────────────────────────────────────────────

/** Scan a .psc file (or open document) for the declaration line of a named symbol. */
function findDeclarationLine(filePath: string, targetNameLower: string): number {
  const uri = `file://${filePath}`;
  let lines: string[];
  const openDoc = documents.get(uri);
  if (openDoc) {
    lines = openDoc.getText().split(/\r?\n/);
  } else {
    try { lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/); } catch { return 0; }
  }
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/;.*$/, '').trim();
    const sm = SCRIPTNAME_RE.exec(stripped);
    if (sm && sm[1].toLowerCase() === targetNameLower) return i;
    const fm = FUNC_RE.exec(stripped);
    if (fm && fm[2].toLowerCase() === targetNameLower) return i;
    const em = EVENT_RE.exec(stripped);
    if (em && em[1].toLowerCase() === targetNameLower) return i;
    const pm = PROP_RE.exec(stripped);
    if (pm && pm[2].toLowerCase() === targetNameLower) return i;
    const stM = /^\s*struct\s+(\w+)/i.exec(stripped);
    if (stM && stM[1].toLowerCase() === targetNameLower) return i;
    const ceM = /^\s*customevent\s+(\w+)/i.exec(stripped);
    if (ceM && ceM[1].toLowerCase() === targetNameLower) return i;
  }
  return 0;
}

/** Find where a local variable / parameter is declared in the current document. */
function findLocalDeclarationLine(doc: TextDocument, targetNameLower: string): number | null {
  const lines = doc.getText().split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/;.*$/, '').trim();
    // Function / Event parameter
    const sigM = /(?:function|event)\s+[\w.]+\s*\(([^)]*)\)/i.exec(stripped);
    if (sigM && sigM[1].trim()) {
      for (const param of sigM[1].split(',')) {
        const parts = param.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1].replace(/=.*$/, '').trim().toLowerCase() === targetNameLower) return i;
      }
    }
    // Property
    const pm = PROP_RE.exec(stripped);
    if (pm && pm[2].toLowerCase() === targetNameLower) return i;
    // Local variable: Type Name [= ...]
    const tokens = stripped.split(/\s+/);
    if (tokens.length >= 2 && !STMT_KEYWORDS.has(tokens[0].toLowerCase()) && isKnownType(tokens[0])) {
      if (tokens[1].replace(/=.*$/, '').trim().toLowerCase() === targetNameLower) return i;
    }
  }
  return null;
}

connection.onDefinition((params: TextDocumentPositionParams): Location | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const pos  = params.position;
  const line = doc.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line, character: 9999 } });

  // Find the word under the cursor (include : for Script:Struct types)
  let start = pos.character, end = pos.character;
  while (start > 0 && /[\w:]/.test(line[start - 1])) start--;
  while (end < line.length && /[\w:]/.test(line[end])) end++;
  const word = line.slice(start, end).replace(/^:+|:+$/, '');
  if (!word) return null;
  const wl = word.toLowerCase();

  // Method / property call after '.': jump to declaration line inside the owner's file
  if (start > 0 && line[start - 1] === '.') {
    const typeMap  = buildTypeMap(doc);
    const recvTx   = scanReceiver(line, start - 1);
    const typeName = recvTx ? resolveExprType(recvTx, typeMap) : null;
    if (typeName) {
      const found = findFunctionAndOwner(typeName, wl);
      if (found) {
        const ownerInfo = scriptDb.get(found.ownerLower);
        if (ownerInfo?.sourcePath) {
          const ln = findDeclarationLine(ownerInfo.sourcePath, wl);
          return Location.create(`file://${ownerInfo.sourcePath}`, Range.create(ln, 0, ln, 0));
        }
      }
      for (const info of getInheritanceChain(typeName)) {
        const prop = info.properties.find(p => p.name.toLowerCase() === wl);
        if (prop && info.sourcePath) {
          const ln = findDeclarationLine(info.sourcePath, prop.name.toLowerCase());
          return Location.create(`file://${info.sourcePath}`, Range.create(ln, 0, ln, 0));
        }
      }
    }
  }

  let info: ScriptInfo | undefined;
  let targetLower: string | undefined;

  if (wl.includes(':')) {
    info = scriptDb.get(wl.split(':')[0]);
    targetLower = wl.split(':')[0];
  } else {
    info = scriptDb.get(wl);
    targetLower = wl;
    if (!info) {
      const varType = buildTypeMap(doc).get(wl);
      if (varType) {
        // Jump to the declaration of the variable in the current document first
        const localLine = findLocalDeclarationLine(doc, wl);
        if (localLine !== null)
          return Location.create(doc.uri, Range.create(localLine, 0, localLine, 0));
        info = scriptDb.get(varType);
        targetLower = varType;
      }
    }
    if (!info) {
      for (const key of structDb.keys()) {
        if (key.split(':')[1] === wl) { info = scriptDb.get(key.split(':')[0]); targetLower = key.split(':')[0]; break; }
      }
    }
  }

  if (!info?.sourcePath) return null;
  const ln = findDeclarationLine(info.sourcePath, targetLower ?? wl);
  return Location.create(`file://${info.sourcePath}`, Range.create(ln, 0, ln, 0));
});

// ── Code actions / quick fixes ───────────────────────────────────────────────

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const actions: CodeAction[] = [];

  for (const diag of params.context.diagnostics) {
    if (diag.source !== 'papyrus-compiler') continue;

    // Extract the unknown token from compiler error messages like:
    //   identifier 'Foo' not found  /  type 'Bar' is undefined  /  'Baz' is not a valid ...
    const m = /'([^']+)'/.exec(diag.message);
    if (!m) continue;
    const unknown = m[1].toLowerCase();
    if (unknown.length < 2) continue;

    // Find up to 5 scriptDb names that contain the unknown token or share its prefix
    const suggestions = [...scriptDb.values()]
      .filter(info => {
        const n = info.name.toLowerCase();
        return n.includes(unknown) || unknown.includes(n.slice(0, Math.min(4, n.length)));
      })
      .slice(0, 5);

    for (const info of suggestions) {
      actions.push(CodeAction.create(
        `Did you mean '${info.name}'?`,
        { changes: { [params.textDocument.uri]: [TextEdit.replace(diag.range, info.name)] } },
        CodeActionKind.QuickFix,
      ));
    }

    // Suggest adding `import ScriptName` if unknown token is a global function in some script
    const globalOwner = findGlobalFunction(unknown);
    if (globalOwner) {
      const docText = documents.get(params.textDocument.uri)?.getText() ?? '';
      const alreadyImported = new RegExp(`^\\s*import\\s+${globalOwner.name}\\s*$`, 'im').test(docText);
      if (!alreadyImported) {
        const insertLine = findImportInsertLine(docText);
        actions.push(CodeAction.create(
          `Add 'import ${globalOwner.name}'`,
          { changes: { [params.textDocument.uri]: [{ range: Range.create(insertLine, 0, insertLine, 0), newText: `import ${globalOwner.name}\n` }] } },
          CodeActionKind.QuickFix,
        ));
      }
    }
  }

  return actions;
});

// ── Rename symbol ─────────────────────────────────────────────────────────────

connection.onPrepareRename((params: TextDocumentPositionParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const line = doc.getText({ start: { line: params.position.line, character: 0 }, end: { line: params.position.line, character: 9999 } });
  let s = params.position.character, e = params.position.character;
  while (s > 0 && /\w/.test(line[s - 1])) s--;
  while (e < line.length && /\w/.test(line[e])) e++;
  const word = line.slice(s, e);
  if (!word) return null;
  const wl2 = word.toLowerCase();
  if (!scriptDb.has(wl2) && !buildTypeMap(doc).has(wl2)) return null;
  return { range: Range.create(params.position.line, s, params.position.line, e), placeholder: word };
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
  if (!refIndexReady) return null;
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const line = doc.getText({ start: { line: params.position.line, character: 0 }, end: { line: params.position.line, character: 9999 } });
  let s = params.position.character, e = params.position.character;
  while (s > 0 && /\w/.test(line[s - 1])) s--;
  while (e < line.length && /\w/.test(line[e])) e++;
  const word = line.slice(s, e);
  if (!word) return null;
  const wl3 = word.toLowerCase();

  if (scriptDb.has(wl3)) {
    // Script type rename — cross-file via refIndex
    const locations = refIndex.get(wl3) ?? [];
    const changes: { [uri: string]: TextEdit[] } = {};
    for (const loc of locations) {
      if (!changes[loc.uri]) changes[loc.uri] = [];
      changes[loc.uri].push(TextEdit.replace(loc.range, params.newName));
    }
    return { changes };
  }

  // Variable rename — scope-limited to the enclosing function/event
  const scope = findFunctionScope(doc, params.position.line);
  if (!scope) return null;
  const docLines = doc.getText().split(/\r?\n/);
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = new RegExp(`\\b${escaped}\\b`, 'g');
  const edits: TextEdit[] = [];
  for (let i = scope.start; i <= scope.end; i++) {
    wordRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(docLines[i])) !== null)
      edits.push(TextEdit.replace(Range.create(i, m.index, i, m.index + word.length), params.newName));
  }
  return edits.length > 0 ? { changes: { [doc.uri]: edits } } : null;
});

// ── Lazy completion docs ──────────────────────────────────────────────────────

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  if (item.data?.kind === 'script') {
    const info = scriptDb.get(item.data.name as string);
    if (info) {
      const extStr = info.extendsType ? ` extends ${info.extendsType}` : '';
      item.documentation = { kind: MarkupKind.Markdown, value:
        `**\`${info.name}\`**${extStr ? `\n\nextends \`${info.extendsType}\`` : ''}\n\n` +
        (info.functions.length ? `Functions: ${info.functions.slice(0, 3).join(', ')}${info.functions.length > 3 ? '…' : ''}\n` : '') +
        (info.events.length ? `Events: ${info.events.slice(0, 3).join(', ')}` : '') };
    }
  }
  return item;
});

// ── Workspace-wide diagnostics command ───────────────────────────────────────

connection.onExecuteCommand((params) => {
  if (params.command !== 'papyrus.checkAllScripts') return;
  if (!workspaceRoot) { connection.window.showWarningMessage('[papyrus-lsp] No workspace root'); return; }
  if (!compilerReady) {
    connection.window.showWarningMessage('[papyrus-lsp] Compiler not configured'); return;
  }

  const queue: string[] = [];
  function collectPsc(dir: string): void {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collectPsc(full);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.psc')) queue.push(full);
      }
    } catch { /* skip */ }
  }
  collectPsc(workspaceRoot!);

  const total = queue.length;
  if (total === 0) { connection.window.showInformationMessage('[papyrus-lsp] No .psc files found'); return; }
  connection.window.showInformationMessage(`[papyrus-lsp] Checking ${total} scripts…`);

  let active = 0, done = 0;
  const MAX = 4;
  function next(): void {
    while (active < MAX && queue.length > 0) {
      const filePath = queue.shift()!;
      active++;
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        const doc  = TextDocument.create(`file://${filePath}`, 'papyrus', 0, text);
        runCompilerDiagnostics(doc, () => {
          active--; done++;
          if (done === total) connection.window.showInformationMessage(`[papyrus-lsp] Done — ${done} scripts checked`);
          next();
        });
      } catch { active--; done++; next(); }
    }
  }
  next();
});

// ── Folding ranges & selection ranges ────────────────────────────────────────

const FOLD_OPEN_KW: Record<string, string> = {
  function: 'endfunction', event: 'endevent', state: 'endstate',
  property: 'endproperty', struct: 'endstruct', group: 'endgroup',
  if: 'endif', while: 'endwhile',
};
const FOLD_CLOSE_KW = new Set(Object.values(FOLD_OPEN_KW));

function computeFoldingRanges(doc: TextDocument): FoldingRange[] {
  const stack: Array<{ kw: string; line: number }> = [];
  const ranges: FoldingRange[] = [];
  const lines = doc.getText().split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const tokens = lines[i].replace(/;.*$/, '').trim().toLowerCase().split(/\s+/);
    let kw = '';
    for (let t = 0; t < Math.min(tokens.length, 3); t++) {
      if (FOLD_OPEN_KW[tokens[t]] || FOLD_CLOSE_KW.has(tokens[t])) { kw = tokens[t]; break; }
    }
    if (!kw) continue;
    if (FOLD_OPEN_KW[kw]) {
      stack.push({ kw, line: i });
    } else {
      for (let j = stack.length - 1; j >= 0; j--) {
        if (FOLD_OPEN_KW[stack[j].kw] === kw) {
          ranges.push(FoldingRange.create(stack[j].line, i));
          stack.splice(j, 1);
          break;
        }
      }
    }
  }
  return ranges;
}

connection.onFoldingRanges((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return computeFoldingRanges(doc);
});

connection.onSelectionRanges((params: SelectionRangeParams): SelectionRange[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const lineTexts = doc.getText().split(/\r?\n/);
  const folds     = computeFoldingRanges(doc);
  const fileRange = Range.create(0, 0, doc.lineCount, 0);

  return params.positions.map(pos => {
    // All fold blocks that fully contain the cursor line, innermost first
    const containing = folds
      .filter(f => f.startLine <= pos.line && f.endLine >= pos.line)
      .sort((a, b) => (b.startLine - a.startLine) || (a.endLine - b.endLine));

    // Build chain from outermost → file range at top
    let outer: SelectionRange = { range: fileRange };
    // Walk from outermost block inward, each level wraps the previous as its parent
    for (let i = containing.length - 1; i >= 0; i--) {
      const f = containing[i];
      const endChar = lineTexts[f.endLine]?.length ?? 0;
      outer = { range: Range.create(f.startLine, 0, f.endLine, endChar), parent: outer };
    }
    // Innermost: the current line
    return {
      range: Range.create(pos.line, 0, pos.line, lineTexts[pos.line]?.length ?? 0),
      parent: outer,
    };
  });
});

// ── Type hierarchy ────────────────────────────────────────────────────────────

function makeTypeHItem(info: ScriptInfo): TypeHierarchyItem {
  return {
    name: info.name,
    kind: SymbolKind.Class,
    uri:  info.sourcePath ? `file://${info.sourcePath}` : '',
    range: Range.create(0, 0, 0, 0),
    selectionRange: Range.create(0, 0, 0, 0),
    data: info.name.toLowerCase(),
  };
}

connection.languages.typeHierarchy.onPrepare((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const line = doc.getText({ start: { line: params.position.line, character: 0 }, end: { line: params.position.line, character: 9999 } });
  let s = params.position.character, e = s;
  while (s > 0 && /\w/.test(line[s - 1])) s--;
  while (e < line.length && /\w/.test(line[e])) e++;
  const wl = line.slice(s, e).toLowerCase();
  const info = scriptDb.get(wl) ?? scriptDb.get(buildTypeMap(doc).get(wl) ?? '');
  return info ? [makeTypeHItem(info)] : null;
});

connection.languages.typeHierarchy.onSupertypes((params) => {
  const typeName = (params.item.data as string).toLowerCase();
  const info = scriptDb.get(typeName);
  if (!info?.extendsType) return null;
  const parent = scriptDb.get(info.extendsType.toLowerCase());
  return parent ? [makeTypeHItem(parent)] : null;
});

connection.languages.typeHierarchy.onSubtypes((params) => {
  const typeName = (params.item.data as string).toLowerCase();
  const children = [...scriptDb.values()]
    .filter(i => i.extendsType?.toLowerCase() === typeName)
    .map(makeTypeHItem);
  return children.length ? children : null;
});

// ── Call hierarchy ────────────────────────────────────────────────────────────

function makeCallHItem(name: string, uri: string, range: Range): CallHierarchyItem {
  return { name, kind: SymbolKind.Function, uri, range, selectionRange: range };
}

connection.languages.callHierarchy.onPrepare((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const line = doc.getText({ start: { line: params.position.line, character: 0 }, end: { line: params.position.line, character: 9999 } });
  let s = params.position.character, e = s;
  while (s > 0 && /\w/.test(line[s - 1])) s--;
  while (e < line.length && /\w/.test(line[e])) e++;
  const word = line.slice(s, e);
  if (!word) return null;
  const wordRange = Range.create(params.position.line, s, params.position.line, e);
  const item = makeCallHItem(word, params.textDocument.uri, wordRange);
  (item as any).data = { funcNameLower: word.toLowerCase(), uri: params.textDocument.uri };
  return [item];
});

connection.languages.callHierarchy.onIncomingCalls((params) => {
  const data = (params.item as any).data as { funcNameLower: string } | undefined;
  if (!data) return null;
  const sites = funcCallIndex.get(data.funcNameLower) ?? [];
  const byScript = new Map<string, { loc: Location; scriptName: string }[]>();
  for (const s of sites) {
    let arr = byScript.get(s.scriptName);
    if (!arr) { arr = []; byScript.set(s.scriptName, arr); }
    arr.push(s);
  }
  const result: CallHierarchyIncomingCall[] = [];
  for (const [scriptName, entries] of byScript) {
    const info = scriptDb.get(scriptName.toLowerCase());
    const uri  = info?.sourcePath ? `file://${info.sourcePath}` : entries[0].loc.uri;
    const from = makeCallHItem(scriptName, uri, Range.create(0, 0, 0, 0));
    result.push({ from, fromRanges: entries.map(e => e.loc.range) });
  }
  return result.length ? result : null;
});

connection.languages.callHierarchy.onOutgoingCalls((params) => {
  const data = (params.item as any).data as { uri: string } | undefined;
  if (!data) return null;
  const doc = documents.get(data.uri);
  if (!doc) return null;

  // Find the function body starting from the item's range
  const startLine = params.item.range.start.line;
  const lines     = doc.getText().split(/\r?\n/);
  const typeMap   = buildTypeMap(doc);
  const CALL_PAT  = /\b(\w+)\s*\(/g;
  const seen      = new Set<string>();
  const result:   CallHierarchyOutgoingCall[] = [];

  for (let i = startLine + 1; i < lines.length; i++) {
    const stripped = lines[i].replace(/;.*$/, '');
    const lc       = stripped.trim().toLowerCase();
    if (/^end(function|event)/i.test(lc)) break;

    CALL_PAT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_PAT.exec(stripped)) !== null) {
      const funcLower = m[1].toLowerCase();
      if (seen.has(funcLower) || STMT_KEYWORDS.has(funcLower)) continue;

      // Resolve which type owns this function
      let ownerInfo: ScriptInfo | undefined;
      const callRec = parseCallReceiver(stripped.slice(0, m.index + m[1].length));
      if (callRec) {
        const t = resolveExprType(callRec.receiver, typeMap);
        if (t) ownerInfo = scriptDb.get(t) ?? undefined;
      } else {
        const selfType = typeMap.get('self');
        if (selfType) ownerInfo = scriptDb.get(selfType) ?? undefined;
      }
      if (!ownerInfo) continue;

      const sig = findFunctionInChain(ownerInfo.name.toLowerCase(), funcLower);
      if (!sig) continue;
      seen.add(funcLower);

      const callRange = Range.create(i, m.index, i, m.index + m[1].length);
      const toUri     = ownerInfo.sourcePath ? `file://${ownerInfo.sourcePath}` : '';
      result.push({ to: makeCallHItem(sigToName(sig), toUri, Range.create(0, 0, 0, 0)), fromRanges: [callRange] });
    }
  }
  return result.length ? result : null;
});

// ── Semantic tokens ───────────────────────────────────────────────────────────
// Token type indices matching the legend above
const TT_CLASS = 0, TT_FUNCTION = 1, TT_EVENT = 2, TT_PROPERTY = 3, TT_VARIABLE = 4, TT_PARAMETER = 5;
const TM_DECLARATION = 1; // bitmask for modifier index 0

connection.languages.semanticTokens.on((params: SemanticTokensParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };

  const builder = new SemanticTokensBuilder();

  function pushTok(line: number, char: number, len: number, type: number, mods = 0): void {
    if (len > 0) builder.push(line, char, len, type, mods);
  }

  const lines = doc.getText().split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.replace(/;.*$/, '');

    // ScriptName X extends Y
    const sm = SCRIPTNAME_RE.exec(line);
    if (sm) {
      const ni = raw.indexOf(sm[1]); if (ni >= 0) pushTok(i, ni, sm[1].length, TT_CLASS, TM_DECLARATION);
      if (sm[2]) { const ei = raw.lastIndexOf(sm[2]); if (ei >= 0) pushTok(i, ei, sm[2].length, TT_CLASS); }
      continue;
    }

    // [RetType] Function Name(Type Param, ...)
    const fm = FUNC_RE.exec(line);
    if (fm) {
      if (fm[1]) { const ri = raw.indexOf(fm[1]); if (ri >= 0 && scriptDb.has(fm[1].toLowerCase())) pushTok(i, ri, fm[1].length, TT_CLASS); }
      const ni = raw.indexOf(fm[2], fm[1] ? raw.indexOf(fm[1]) + fm[1].length : 0);
      if (ni >= 0) pushTok(i, ni, fm[2].length, TT_FUNCTION, TM_DECLARATION);
      // Parameters
      if (fm[3]?.trim()) {
        for (const param of fm[3].split(',')) {
          const parts = param.trim().split(/\s+/);
          if (parts.length >= 2) {
            const typeName = parts[0].replace(/\[\]$/, '');
            if (scriptDb.has(typeName.toLowerCase())) {
              const ti = raw.indexOf(typeName, ni); if (ti >= 0) pushTok(i, ti, typeName.length, TT_CLASS);
            }
            const pname = parts[1].replace(/=.*$/, '').trim();
            if (pname) { const pi = raw.indexOf(pname, ni); if (pi >= 0) pushTok(i, pi, pname.length, TT_PARAMETER, TM_DECLARATION); }
          }
        }
      }
      continue;
    }

    // Event Name(...)
    const em = EVENT_RE.exec(line);
    if (em) {
      const ni = raw.indexOf(em[1]); if (ni >= 0) pushTok(i, ni, em[1].length, TT_EVENT, TM_DECLARATION);
      continue;
    }

    // Type Property Name
    const pm = PROP_RE.exec(line);
    if (pm) {
      const typeName = pm[1].replace(/\[\]$/, '');
      if (scriptDb.has(typeName.toLowerCase())) { const ti = raw.indexOf(pm[1]); if (ti >= 0) pushTok(i, ti, pm[1].length, TT_CLASS); }
      const ni = raw.indexOf(pm[2], raw.indexOf(pm[1]) + pm[1].length);
      if (ni >= 0) pushTok(i, ni, pm[2].length, TT_PROPERTY, TM_DECLARATION);
      continue;
    }

    // Local variable: Type name (type must be a known script type)
    const tokens = line.trim().split(/\s+/);
    if (tokens.length >= 2) {
      const typeName = tokens[0].replace(/\[\]$/, '');
      if (scriptDb.has(typeName.toLowerCase()) && !STMT_KEYWORDS.has(typeName.toLowerCase())) {
        const ti = raw.indexOf(typeName); if (ti >= 0) pushTok(i, ti, typeName.length, TT_CLASS);
        const varName = tokens[1].replace(/=.*$/, '').trim();
        if (varName && /^\w+$/.test(varName)) { const vi = raw.indexOf(varName, ti + typeName.length); if (vi >= 0) pushTok(i, vi, varName.length, TT_VARIABLE, TM_DECLARATION); }
      }
    }
  }

  return builder.build();
});

// ── Code lens ─────────────────────────────────────────────────────────────────

connection.onCodeLens((params: CodeLensParams): CodeLens[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const lenses: CodeLens[] = [];
  const typeMap  = buildTypeMap(doc);
  const selfType = typeMap.get('self');
  const lines    = doc.getText().split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.replace(/;.*$/, '').trim();
    const lr   = Range.create(i, 0, i, raw.length);

    const sm = SCRIPTNAME_RE.exec(line);
    if (sm) {
      const count = (refIndex.get(sm[1].toLowerCase()) ?? []).length;
      lenses.push(CodeLens.create(lr, { title: count === 1 ? '1 reference' : `${count} references`, command: '' }));
      continue;
    }

    const fm = FUNC_RE.exec(line);
    if (fm && selfType) {
      const parentType = scriptDb.get(selfType)?.extendsType;
      if (parentType && findFunctionInChain(parentType, fm[2].toLowerCase())) {
        const parentName = getInheritanceChain(parentType)[0]?.name ?? parentType;
        lenses.push(CodeLens.create(lr, { title: `overrides ${parentName}`, command: '' }));
      }
    }
  }

  return lenses;
});

// ── Format document ───────────────────────────────────────────────────────────

const KW_CASE: Record<string, string> = {
  scriptname:'ScriptName', extends:'extends', import:'import',
  function:'Function', endfunction:'EndFunction',
  event:'Event', endevent:'EndEvent',
  state:'State', endstate:'EndState',
  property:'Property', endproperty:'EndProperty',
  struct:'Struct', endstruct:'EndStruct',
  group:'Group', endgroup:'EndGroup',
  if:'If', elseif:'ElseIf', else:'Else', endif:'EndIf',
  while:'While', endwhile:'EndWhile',
  return:'Return', new:'new', as:'as', is:'is',
  none:'None', true:'True', false:'False',
  native:'native', global:'global', auto:'Auto', autoreadonly:'AutoReadOnly',
};

connection.onDocumentFormatting((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const INDENT    = '    ';
  const OPEN_KW   = new Set(['function','event','state','struct','group','if','while']);
  const CLOSE_KW  = new Set(['endfunction','endevent','endstate','endstruct','endgroup','endif','endwhile','endproperty']);
  const BOTH_KW   = new Set(['else','elseif']);
  const PROP_LINE = /^\s*(?:[\w\[\]]+\s+)?property\b/i;
  const PROP_AUTO = /\bauto(?:readonly)?\b/i;

  const lines   = doc.getText().split(/\r?\n/);
  const output: string[] = [];
  let depth = 0;

  for (const raw of lines) {
    const stripped  = raw.replace(/;.*$/, '').trim();
    const tokensLc  = stripped.toLowerCase().split(/\s+/).filter(Boolean);

    let kw = '';
    for (let t = 0; t < Math.min(tokensLc.length, 3); t++) {
      if (OPEN_KW.has(tokensLc[t]) || CLOSE_KW.has(tokensLc[t]) || BOTH_KW.has(tokensLc[t])) { kw = tokensLc[t]; break; }
    }

    if (CLOSE_KW.has(kw) || BOTH_KW.has(kw)) depth = Math.max(0, depth - 1);

    const isPropBlock = PROP_LINE.test(raw) && !PROP_AUTO.test(raw);
    const trimmed = raw.trim();
    const normalized = trimmed.replace(/\b([A-Za-z]+)\b/g, m => KW_CASE[m.toLowerCase()] ?? m);
    output.push(trimmed.length === 0 ? '' : INDENT.repeat(depth) + normalized);

    if (OPEN_KW.has(kw) || BOTH_KW.has(kw) || isPropBlock) depth++;
  }

  const original  = doc.getText();
  const formatted = output.join('\n') + (original.endsWith('\n') ? '\n' : '');
  if (formatted === original) return [];
  return [{ range: Range.create(0, 0, doc.lineCount, 0), newText: formatted }];
});

documents.listen(connection);
connection.listen();
