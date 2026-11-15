# Lua - Stand API

**English** · [Русский](README.ru.md)

VS Code extension for [Stand](https://stand.sh) Lua / Pluto scripts. It provides Stand API snippets and
reads GTA V natives straight from the natives files that your script loads with `util.require_natives(...)`.

## Features

- **Stand API snippets** for `.lua` and `.pluto` files.
- **GTA V natives from the real natives file**: completion, hover, signature help (current argument is
  highlighted) and Go to Definition (F12) that jumps to the declaration in `g.source.lua` / `init.source.lua`.
- Works across the whole project: a module that does not call `require_natives` itself still gets natives
  if any other script in the workspace does.
- Natives are indexed once per file and cached by path and modification time, so completion stays instant.

## Natives: how they are detected

The extension scans the workspace (and tracks edits as you type) for `util.require_natives(...)` calls.
Calls inside comments are ignored.

| Call | File read | How you write natives |
|---|---|---|
| `util.require_natives("3407a", "g")`, `"G"` or `"3407a.g"` | `g.source.lua` | `CREATE_PED(...)`: global functions |
| `util.require_natives("3407a")` | `init.source.lua` | `PED.CREATE_PED(...)` |
| `local natives = util.require_natives("3407a")` | `init.source.lua` | also `natives.PED.CREATE_PED(...)` |
| `util.require_natives(1681379138)` | `natives-1681379138/` or `natives-1681379138.lua` | `PED.CREATE_PED(...)` |
| `measure("...", util.require_natives, "3407a")` | as without the wrapper | as without the wrapper |

- The first argument is the version folder, the second one selects the mode (`"g"` / `"G"`, case-insensitive).
- `uno` / `g-uno` flavors (`"2944a.uno"`, `"2944a.g-uno"`) are supported. They declare the same functions, so
  the full file of the same version is used for hints: uno files have no types or parameter names.

### Where the version folder is searched

In this order:

1. The workspace: `**/natives-<version>/`, `**/natives/<version>/`, `**/<version>/`, `**/natives-<version>.lua`
2. Folders from the `standApi.natives.paths` setting
3. `%APPDATA%\Stand\Lua Scripts\lib\natives-<version>\` and `...\lib\natives\<version>\`

Inside the folder `*.source.lua` is preferred (full signatures and comments); `g.*` is used only in `"g"` mode and
`init.*` only without it.

> `g.lua` and `init.lua` shipped with Stand are compiled Luau bytecode and contain no signatures, so the
> extension reads the `*.source.lua` files. Broken downloads (for example an HTML "404 Not Found" saved as
> `.lua`) are skipped. What was found and where is logged in **Output → Stand Natives**.

## Installation

Download the `.vsix` and install it:

```
code --install-extension lua-stand-api-0.0.7.vsix
```

or use **Extensions → … → Install from VSIX…** in VS Code. To build it yourself:

```
npm install
npx @vscode/vsce package
```

## Extension settings

| Setting | Default | Description |
|---|---|---|
| `standApi.natives.paths` | `[]` | Extra folders to search for natives. Supports `%APPDATA%`, `${env:NAME}` and `~`. A version folder itself may also be listed. |
| `standApi.natives.hideStaticSnippets` | `true` | Hide the built-in native snippets when the project has `util.require_natives(...)`, so hints are not duplicated. |
| `luaStandApi.enableStandSnippets` | `true` | Stand API snippets. |
| `luaStandApi.enableNativeSnippetsAsTableStyle` | `true` | Built-in native snippets as `PED.CREATE_PED(...)`. |
| `luaStandApi.enableNativeSnippetsAsGlobalVar` | `false` | Built-in native snippets as `CREATE_PED(...)`. |
| `luaStandApi.enableHelperSnippets` | `true` | Helper snippets. |

## Development

```
npm install
npm run compile
npm test
```

Tests cover both modes (`"g"` reads `g.*`, no flag reads `init.*`), detection, file selection, the parser and
the VS Code providers against the fixtures in `test-fixtures/`. They also parse every `natives-*` version found in
`%APPDATA%\Stand\Lua Scripts\lib` (set `STAND_NATIVES_LIB` to use another folder); that part is skipped when
Stand is not installed.
