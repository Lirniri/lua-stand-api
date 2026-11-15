# Lua - Stand API README

## Features

* Stand API & GTA V Natives support for VS Code
* Нативы прямо из файлов Stand по вызову `util.require_natives(...)` (`.lua` и `.pluto`):
  автодополнение, hover, подсказка параметров и переход к объявлению (F12)

## Нативы из `util.require_natives`

Расширение сканирует воркспейс и находит вызовы (в комментариях не учитываются):

| Вызов | Файл | Как писать нативы |
|---|---|---|
| `util.require_natives("3407a", "g")` / `"G"` / `"3407a.g"` | `g.source.lua` | `CREATE_PED(...)` — глобальные функции |
| `util.require_natives("3407a")` | `init.source.lua` | `PED.CREATE_PED(...)` |
| `local natives = util.require_natives("3407a")` | `init.source.lua` | ещё и `natives.PED.CREATE_PED(...)` |
| `util.require_natives(1681379138)` | `natives-1681379138/` или `natives-1681379138.lua` | `PED.CREATE_PED(...)` |
| `measure("...", util.require_natives, "3407a")` | вызов через обёртку | как без обёртки |

Флейворы `uno` / `g-uno` поддерживаются: функции у них те же, поэтому подсказки берутся из полного
`init.source.lua` / `g.source.lua` той же версии (в uno-файлах нет типов и имён параметров).

Нативы видны во всём проекте: модуль, который сам не вызывает `require_natives`, тоже получает подсказки.

Где ищется папка версии (по порядку):

1. В воркспейсе: `**/natives-<версия>/`, `**/natives/<версия>/`, `**/<версия>/`, `**/natives-<версия>.lua`
2. В папках из настройки `standApi.natives.paths`
3. `%APPDATA%\Stand\Lua Scripts\lib\natives-<версия>\` и `...\lib\natives\<версия>\`

`g.lua` и `init.lua` из поставки Stand — скомпилированный байткод, сигнатур в нём нет, поэтому
читается `*.source.lua`. Разобранный файл кэшируется в памяти по пути и времени изменения.
Что найдено и откуда — в панели Output → «Stand Natives».

## Extension Settings

* `luaStandApi.enableStandSnippets`: Enable autocompletion and suggestions for Stand API
* `luaStandApi.enableNativeSnippetsAsTableStyle`: Enable autocompletion and suggestions for native game functions
* `luaStandApi.enableNativeSnippetsAsGlobalVar`: Enable autocompletion and suggestions for native game functions
* `standApi.natives.paths`: дополнительные папки для поиска нативов
* `standApi.natives.hideStaticSnippets`: скрывать встроенные сниппеты нативов, если в проекте есть `util.require_natives` (по умолчанию включено)

## Known Issues

* None

## Release Notes

### 0.0.7

* Нативы из `util.require_natives(...)`: автодополнение, hover, подсказка параметров, F12
