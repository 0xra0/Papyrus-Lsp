# papyrus-lsp

Full-featured Language Server Protocol implementation for Bethesda's Papyrus scripting language. Works with Starfield, Skyrim, and Fallout 4 scripts.

## Requirements

- **Node.js** 18 or later
- **Mono** — only on Linux/macOS, and only for compiler-backed diagnostics. On Windows the compiler runs natively. Without it you still get the full native diagnostic suite.

No Creation Kit, game install, or editor extension is needed. The vanilla script sources, `PapyrusCompiler.exe`, and the flags file are all fetched into the repo by `npm run fetch-vanilla`.

## Installation

Not yet published to npm — install from source:

```bash
git clone https://github.com/0xra0/Papyrus-Lsp
cd Papyrus-Lsp
npm install -g . --prefix ~/.local   # builds, and puts papyrus-lsp on your PATH
npm run fetch-vanilla                # vanilla .psc sources + PapyrusCompiler.exe
npm run rebuild-db                   # optional — cache the type index
```

After installation the `papyrus-lsp` binary is available in your PATH.

The server locates its bundled compiler and vanilla sources relative to its own install directory. `npm install -g .` links this clone, so fetching into the clone is enough. If you instead install a **packed** copy, note that `_vanilla-sf-scripts/` is excluded from the `files` whitelist and won't be present: run `fetch-vanilla` from inside the install directory, or point `compilerPath` and `importDirs` at copies you already have.

## Configuration

The server works with no configuration. Each setting is resolved independently — first hit wins:

1. `.papyrus-lsp.json`, searched from the workspace root **upward**
2. `PAPYRUS_LSP_*` environment variables
3. The layout under `gameRoot`, if one is given
4. The copies bundled with this install

A configured path that doesn't exist is reported and skipped, falling through to the next source rather than silently disabling the feature that needed it.

```json
{
  "importDirs": ["./scripts/source", "/path/to/another-mod/Scripts/Source"],
  "compilerPath": "/path/to/PapyrusCompiler.exe",
  "flagsFile": "/path/to/Starfield_Papyrus_Flags.flg",
  "gameRoot": "~/.steam/steam/steamapps/common/Starfield"
}
```

All fields are optional. Relative paths resolve against the config file's own directory, and `~` expands to your home directory. The workspace root, the bundled `mod-extenders/`, and (unless another import dir already supplies `ScriptObject.psc`) the bundled vanilla sources are always appended to `importDirs`.

| Environment variable | Overrides |
|---|---|
| `PAPYRUS_LSP_IMPORTS` | `importDirs` (`PATH`-style separated list) |
| `PAPYRUS_LSP_COMPILER` | `compilerPath` |
| `PAPYRUS_LSP_FLAGS` | `flagsFile` |
| `PAPYRUS_LSP_GAME_ROOT` | `gameRoot` |
| `PAPYRUS_LSP_MONO` | path to the `mono` binary |

## Scripts database

`scripts-db.json` is a **cache, not a requirement**. If it's absent or corrupt the server indexes the sources in `importDirs` directly at startup (~250ms for 5,000 scripts) and logs how to cache it. Rebuild it with:

```bash
npm run rebuild-db                        # bundled vanilla + mod-extenders
npm run rebuild-db -- /path/a /path/b     # explicit source dirs
PAPYRUS_LSP_IMPORTS=/path/a:/path/b npm run rebuild-db
```

The server watches the file and hot-reloads it when it changes, so a rebuild takes effect without a restart. Scripts in your workspace are layered on top of the cache at startup, so your own types resolve without rebuilding.

## Troubleshooting

The server logs what it resolved at startup. Check your editor's LSP log for:

```
[papyrus-lsp] import dirs: /path/to/vanilla/Source, /your/workspace, ...
[papyrus-lsp] compiler diagnostics enabled — /path/to/PapyrusCompiler.exe (mono /usr/bin/mono)
```

If you instead see `compiler diagnostics unavailable (...)`, the message names what's missing. Only the native suite runs in that mode: you'll still get parser, structural, and access errors on every keystroke, but **not** full type and event checking — so a bad cast or an unknown event name will go unreported. Set the missing path via `.papyrus-lsp.json` or the matching `PAPYRUS_LSP_*` variable.

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
- **Workspace symbols** — Ctrl+T fuzzy-searches all 5,000+ script names
- **Document symbols** — Ctrl+Shift+O outline of functions, events, properties, structs, custom events

### Diagnostics
Live, two-tier diagnostics modeled on clangd: fast checks appear as you type, the compiler refines them in the background.

- **Instant native suite** — parser errors, missing returns, type mismatches, structural/access checks, unused imports and locals; published on **every keystroke** with no compiler required
- **Compiler-backed diagnostics** — full semantic checking via `PapyrusCompiler.exe -noasm`, run in the background (debounced 600ms) and again on save; compiler results supersede native ones on the same line
- **Live-editing guarantees** — every `publishDiagnostics` carries the document version; a late compiler result never overwrites a newer edit (stale-guarding); an in-flight compiler run is cancelled when you edit again, so runs never pile up
- **Pull diagnostics (LSP 3.17)** — advertises `diagnosticProvider` and answers `textDocument/diagnostic` and `workspace/diagnostic`, in addition to pushing via `publishDiagnostics` (the same both-ways model clangd uses). This is what lets editors and headless clients like Claude Code report "Found N new diagnostic issues in M files" after an edit. Push and pull share a per-version cache so an edit never runs the compiler twice, and pull-capable clients are asked to refresh dependents when a file's errors change.
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
