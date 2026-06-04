# papyrus-lsp

Full-featured Language Server Protocol implementation for Bethesda's Papyrus scripting language. Works with Starfield, Skyrim, and Fallout 4 scripts.

## Requirements

- **Node.js** 18 or later
- **Mono** (Linux/macOS) or .NET (Windows) — for compiler-backed diagnostics
- A Papyrus compiler (`PapyrusCompiler.exe`) and flags file from the game's Creation Kit

## Installation

```bash
npm install -g papyrus-lsp
```

Or install from source:

```bash
git clone https://github.com/0xra0/Papyrus-Lsp
cd papyrus-lsp
npm install -g . --prefix ~/.local
```

After installation the `papyrus-lsp` binary is available in your PATH.

## Configuration

Drop a `.papyrus-lsp.json` file in your workspace root to override defaults:

```json
{
  "importDirs": [
    "/path/to/vanilla-scripts/Source",
    "/path/to/your-mod/Scripts/Source"
  ],
  "compilerPath": "/path/to/PapyrusCompiler.exe",
  "flagsFile": "/path/to/Starfield_Papyrus_Flags.flg"
}
```

All fields are optional. Omitted keys fall back to the baked-in defaults. The server re-reads the config on restart.

## Scripts database

The bundled `scripts-db.json` covers Starfield vanilla scripts. To rebuild it for your own installation, or to add a different game's scripts:

```bash
# Edit DIRS in scripts/build-db.js to point at your .psc source directories
npm run rebuild-db
```

The rebuild takes a few seconds and overwrites `scripts-db.json`.

## Claude Code setup

Add to your Claude Code LSP plugin config (`.lsp.json`):

```json
{
  "papyrus": {
    "command": "papyrus-lsp",
    "extensionToLanguage": { ".psc": "papyrus" }
  }
}
```

## Features

### Editing
- **Completions** — dot completions with full type inference, self-methods, cast expressions (`(akRef as Actor).`), struct fields, array element access (`myActors[0].`), context-aware after `extends`/`as`/`import`/`new`
- **Signature help** — parameter hints as you type, with inlay hints showing parameter names inline
- **Snippets** — `fn`, `fnr`, `ev`, `prop`, `state`
- **Format document** — normalizes keyword casing and indentation
- **Rename** — F2 renames script types across all files, or local variables within their function scope

### Navigation
- **Go-to-definition** — F12 on type names, variables, struct types (`Script:Struct`)
- **Find references** — Shift+F12 shows all `.psc` files that reference a type
- **Workspace symbols** — Ctrl+T fuzzy-searches all 4,755+ script names
- **Document symbols** — Ctrl+Shift+O outline of functions, events, properties, structs, custom events

### Diagnostics
- **Compiler-backed diagnostics** — full semantic checking via `PapyrusCompiler.exe -noasm`, run on every save (debounced 600ms)
- **Workspace-wide check** — run `papyrus.checkAllScripts` from the command palette to compile every `.psc` in the workspace
- **Code actions** — "Did you mean X?" suggestions and "Add import Y" quick-fixes

### Intelligence
- **Hover** — type info, doc comments, struct fields, self/parent, chained calls (`Game.GetPlayer().`)
- **Type hierarchy** — Shift+Alt+H shows parent/child type tree
- **Call hierarchy** — incoming and outgoing calls for any function
- **Semantic tokens** — proper syntax highlighting for types, functions, properties, parameters
- **Code lens** — reference counts above `ScriptName`, `overrides ParentType` above overridden functions
- **Folding** — collapses Function/Event/State/If/While/Struct blocks

### Workspace
- **Live indexing** — open/edited `.psc` files are indexed immediately; completions and hover work for your own scripts without rebuilding the DB
- **String event suggestions** — typing inside `RegisterForRemoteEvent(akRef, "` suggests known event names including `CustomEvent` declarations

## Commands

| Command | Description |
|---|---|
| `papyrus.checkAllScripts` | Run compiler diagnostics on every .psc in the workspace |

## Struct types

Struct member completions work automatically. If `ActorValue` defines `Struct ActorValueInfo`, typing `myInfo.` shows its fields. Qualified type names like `ActorValue:ActorValueInfo` are supported everywhere (hover, go-to-definition, completions).

## Line continuation

Papyrus `\` line continuations are handled in type inference and document indexing.

## License

MIT
