# Lua - Stand API

[English](README.md) · **Русский**

Расширение VS Code для Lua / Pluto скриптов [Stand](https://stand.sh). Даёт сниппеты Stand API и читает нативы
GTA V прямо из файлов нативов, которые скрипт подключает через `util.require_natives(...)`.

## Возможности

- **Сниппеты Stand API** для файлов `.lua` и `.pluto`.
- **Нативы GTA V из реального файла нативов**: автодополнение, hover, подсказка параметров (текущий аргумент
  подсвечивается) и переход к объявлению по F12 в `g.source.lua` / `init.source.lua`.
- Работает на весь проект: модуль, который сам не вызывает `require_natives`, всё равно получает нативы,
  если их подключает любой другой скрипт воркспейса.
- Файл нативов разбирается один раз и кэшируется по пути и времени изменения, поэтому автодополнение не тормозит.

## Нативы: как они определяются

Расширение сканирует воркспейс и следит за правками при вводе, ища вызовы `util.require_natives(...)`.
Вызовы в комментариях не учитываются.

| Вызов | Читаемый файл | Как писать нативы |
|---|---|---|
| `util.require_natives("3407a", "g")`, `"G"` или `"3407a.g"` | `g.source.lua` | `CREATE_PED(...)`: глобальные функции |
| `util.require_natives("3407a")` | `init.source.lua` | `PED.CREATE_PED(...)` |
| `local natives = util.require_natives("3407a")` | `init.source.lua` | ещё и `natives.PED.CREATE_PED(...)` |
| `util.require_natives(1681379138)` | `natives-1681379138/` или `natives-1681379138.lua` | `PED.CREATE_PED(...)` |
| `measure("...", util.require_natives, "3407a")` | как без обёртки | как без обёртки |

- Первый аргумент: папка версии. Второй задаёт режим (`"g"` / `"G"`, регистр не важен).
- Варианты `uno` / `g-uno` (`"2944a.uno"`, `"2944a.g-uno"`) поддерживаются. Функции в них те же, поэтому для
  подсказок берётся полный файл той же версии: в uno-файлах нет ни типов, ни имён параметров.

### Где ищется папка версии

По порядку:

1. Воркспейс: `**/natives-<версия>/`, `**/natives/<версия>/`, `**/<версия>/`, `**/natives-<версия>.lua`
2. Папки из настройки `standApi.natives.paths`
3. `%APPDATA%\Stand\Lua Scripts\lib\natives-<версия>\` и `...\lib\natives\<версия>\`

Внутри папки предпочитается `*.source.lua` (полные сигнатуры и комментарии); `g.*` читается только в режиме `"g"`,
`init.*` только без него.

> `g.lua` и `init.lua` из поставки Stand — скомпилированный байткод Luau, сигнатур в нём нет, поэтому читаются
> файлы `*.source.lua`. Испорченные загрузки (например, HTML «404 Not Found», сохранённый как `.lua`)
> пропускаются. Что найдено и откуда, пишется в **Output → Stand Natives**.

## Установка

Скачайте `.vsix` и установите:

```
code --install-extension lua-stand-api-0.0.7.vsix
```

или через **Extensions → … → Install from VSIX…** в VS Code. Чтобы собрать самостоятельно:

```
npm install
npx @vscode/vsce package
```

## Настройки

| Настройка | По умолчанию | Описание |
|---|---|---|
| `standApi.natives.paths` | `[]` | Дополнительные папки для поиска нативов. Поддерживаются `%APPDATA%`, `${env:NAME}` и `~`. Можно указать и саму папку версии. |
| `standApi.natives.hideStaticSnippets` | `true` | Скрывать встроенные сниппеты нативов, если в проекте есть `util.require_natives(...)`, чтобы подсказки не дублировались. |
| `luaStandApi.enableStandSnippets` | `true` | Сниппеты Stand API. |
| `luaStandApi.enableNativeSnippetsAsTableStyle` | `true` | Встроенные сниппеты нативов в виде `PED.CREATE_PED(...)`. |
| `luaStandApi.enableNativeSnippetsAsGlobalVar` | `false` | Встроенные сниппеты нативов в виде `CREATE_PED(...)`. |
| `luaStandApi.enableHelperSnippets` | `true` | Вспомогательные сниппеты. |

## Разработка

```
npm install
npm run compile
npm test
```

Тесты покрывают оба режима (`"g"` читает `g.*`, без флага читает `init.*`), определение вызовов, выбор файла,
парсер и провайдеры VS Code на данных из `test-fixtures/`. Кроме того, они разбирают все версии `natives-*` из
`%APPDATA%\Stand\Lua Scripts\lib` (другую папку можно задать переменной `STAND_NATIVES_LIB`); эта часть
пропускается, если Stand не установлен.
