import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { NativesManager } from './natives/manager';
import { registerNativeProviders } from './natives/providers';

// Активные провайдеры, чтобы их можно было выгрузить при изменении настроек
let activeDisposables: vscode.Disposable[] = [];

// Слова с точкой/двоеточием: PED.CREATE_PED, menu.my_root, player:method
const WORD_PATTERN = /[A-Za-z0-9_.:]+/;

// Нативы из util.require_natives(...): живут всё время работы расширения
let nativesManager: NativesManager | undefined;

export interface StandApiExports {
    natives: NativesManager;
}

export function activate(context: vscode.ExtensionContext): StandApiExports {
    const output = vscode.window.createOutputChannel('Stand Natives');
    nativesManager = new NativesManager(output);
    context.subscriptions.push(output, nativesManager, ...registerNativeProviders(nativesManager));

    updateSnippets(context);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('luaStandApi')) {
                updateSnippets(context);
            }
        }),
        { dispose: disposeProviders }
    );

    return { natives: nativesManager };
}

// Статические сниппеты нативов дублируют подсказки из реального файла нативов,
// поэтому, если в проекте есть util.require_natives(...), они скрываются
function nativeSnippetsHidden(document: vscode.TextDocument): boolean {
    const hide = vscode.workspace.getConfiguration('standApi.natives').get<boolean>('hideStaticSnippets', true);
    return hide && !!nativesManager?.hasAnyCalls(document);
}

function disposeProviders() {
    activeDisposables.forEach(d => d.dispose());
    activeDisposables = [];
}

function updateSnippets(context: vscode.ExtensionContext) {
    disposeProviders();

    const config = vscode.workspace.getConfiguration('luaStandApi');
    const enableStand = config.get<boolean>('enableStandSnippets', true);
    const enableNativeTable = config.get<boolean>('enableNativeSnippetsAsTableStyle', true);
    const enableNativeGlobal = config.get<boolean>('enableNativeSnippetsAsGlobalVar', false);
    const enableHelpSnippets = config.get<boolean>('enableHelperSnippets', true);

    if (enableStand) {
        registerSnippetFile(context, 'snippets/stand-snippets.code-snippets');
    }
    // Табличный стиль: PED.CREATE_PED(...)
    if (enableNativeTable) {
        registerSnippetFile(context, 'snippets/native-snippets.code-snippets', false, nativeSnippetsHidden);
    }
    // Глобальный стиль: CREATE_PED(...) — без префикса неймспейса
    if (enableNativeGlobal) {
        registerSnippetFile(context, 'snippets/native-snippets.code-snippets', true, nativeSnippetsHidden);
    }
    if (enableHelpSnippets) {
        registerSnippetFile(context, 'snippets/helper-snippets.code-snippets', false);
    }
}

// .code-snippets — это JSONC: в нём бывают // комментарии, /* */ и лишние запятые.
// Обычный JSON.parse на них падает, поэтому чистим текст, не трогая содержимое строк
// (в описаниях встречаются ссылки вида https://...).
function parseJsonc(text: string): any {
    let out = '';
    let i = 0;
    const n = text.length;
    let inString = false;

    while (i < n) {
        const ch = text[i];
        const next = text[i + 1];

        if (inString) {
            out += ch;
            if (ch === '\\') {
                out += next ?? '';
                i += 2;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            i++;
            continue;
        }

        if (ch === '"') {
            inString = true;
            out += ch;
            i++;
        } else if (ch === '/' && next === '/') {
            while (i < n && text[i] !== '\n') { i++; }
        } else if (ch === '/' && next === '*') {
            i += 2;
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { i++; }
            i += 2;
        } else {
            out += ch;
            i++;
        }
    }

    // Убираем запятые перед } и ] (вне строк)
    let result = '';
    inString = false;
    for (let j = 0; j < out.length; j++) {
        const c = out[j];
        if (inString) {
            result += c;
            if (c === '\\') { result += out[++j] ?? ''; }
            else if (c === '"') { inString = false; }
            continue;
        }
        if (c === '"') {
            inString = true;
            result += c;
        } else if (c === ',') {
            let k = j + 1;
            while (k < out.length && /\s/.test(out[k])) { k++; }
            if (out[k] === '}' || out[k] === ']') { continue; }
            result += c;
        } else {
            result += c;
        }
    }

    return JSON.parse(result);
}

// Превращает тело сниппета в читаемый текст: ${1:condition} -> condition, $0 -> ''
function snippetPreview(body: string): string {
    return body
        .replace(/\$\{\d+:([^}]*)\}/g, '$1')
        .replace(/\$\{\d+\}|\$\d+/g, '');
}

// Тело для вызова метода через двоеточие (префикс начинается с ":"):
// menu.list_select(${1:parent}, ${2:name}, ...) -> :list_select(${1:name}, ...)
// Первый аргумент (объект, на котором вызывают метод) убирается, а остальные
// точки табуляции сдвигаются на единицу, чтобы нумерация начиналась с 1.
function toMethodBody(body: string): string {
    const m = body.match(/^(?:[A-Za-z0-9_]+\.)?([A-Za-z0-9_]+)\(\s*(?:\$\{\d+(?::[^}]*)?\}|\$\d+|[^,)]*)\s*(,\s*)?/);
    if (!m) {
        return body;
    }
    const rest = body.slice(m[0].length);
    const shifted = rest
        .replace(/\$\{(\d+)(:|\})/g, (_s, n, tail) => `\${${Number(n) >= 2 ? Number(n) - 1 : n}${tail}`)
        .replace(/\$(\d+)/g, (_s, n) => `$${Number(n) >= 2 ? Number(n) - 1 : n}`);
    return `:${m[1]}(${shifted}`;
}

// Неймспейс нативов в верхнем регистре: PED., VEHICLE., BUILTIN. и т.д.
const NAMESPACE_PREFIX = /^[A-Z0-9_]+\./;

function registerSnippetFile(
    context: vscode.ExtensionContext,
    relativePath: string,
    stripNamespace = false,
    skip?: (document: vscode.TextDocument) => boolean
) {
    const filePath = path.join(context.extensionPath, relativePath);

    if (!fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`Файл сниппетов не найден: ${relativePath}`);
        return;
    }

    let snippetsData: Record<string, any>;
    try {
        snippetsData = parseJsonc(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        vscode.window.showErrorMessage(`Ошибка чтения файла сниппетов: ${relativePath} (${(error as Error).message})`);
        return;
    }

    const pluginName: string = context.extension.packageJSON.displayName ?? 'Lua - Stand API';

    // Строим список один раз, а не при каждом нажатии клавиши
    const entries: { prefix: string; key: string; body: string; doc: vscode.MarkdownString }[] = [];
    for (const key in snippetsData) {
        const snippet = snippetsData[key];
        // Пропускаем служебные поля вроде корневых "name" и "description" (это строки)
        if (!snippet || typeof snippet !== 'object' || snippet.prefix === undefined || snippet.body === undefined) {
            continue;
        }
        const prefixes: string[] = Array.isArray(snippet.prefix) ? snippet.prefix : [snippet.prefix];
        const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : String(snippet.body);

        for (const prefix of prefixes) {
            const finalPrefix = stripNamespace ? prefix.replace(NAMESPACE_PREFIX, '') : prefix;
            let finalBody = stripNamespace ? body.replace(NAMESPACE_PREFIX, '') : body;
            // Префикс ":list_select" — вызов метода: подменяем тело на вариант без первого аргумента
            if (finalPrefix.startsWith(':')) {
                finalBody = toMethodBody(finalBody);
            }

            // Документация строится один раз при загрузке: описание + код с подсветкой
            const doc = new vscode.MarkdownString();
            if (snippet.description) {
                doc.appendMarkdown(`${snippet.description}\n\n`);
            }
            doc.appendCodeblock(snippetPreview(finalBody), 'lua');

            entries.push({ prefix: finalPrefix, key, body: finalBody, doc });
        }
    }

    const provider = vscode.languages.registerCompletionItemProvider(
        [{ language: 'lua' }, { language: 'pluto' }],
        {
            provideCompletionItems(document, position) {
                if (skip?.(document)) {
                    return undefined;
                }
                // Заменяем всё уже набранное слово целиком (включая PED. / menu.),
                // иначе вставится дубль вроде PED.PED.CREATE_PED(...)
                const range = document.getWordRangeAtPosition(position, WORD_PATTERN);

                return entries.map(e => {
                    const item = new vscode.CompletionItem(e.prefix, vscode.CompletionItemKind.Snippet);
                    item.insertText = new vscode.SnippetString(e.body);
                    item.filterText = e.prefix;
                    // Как у других расширений: имя шаблона и название плагина в скобках
                    item.detail = `${e.key} (${pluginName})`;
                    item.documentation = e.doc;
                    if (range) {
                        // Для ":метод" заменяем только часть начиная с двоеточия,
                        // чтобы не стереть объект слева (root:list_select -> root + :list_select(...))
                        const colon = e.prefix.startsWith(':')
                            ? document.getText(range).lastIndexOf(':')
                            : -1;
                        item.range = colon >= 0
                            ? new vscode.Range(range.start.translate(0, colon), range.end)
                            : range;
                    }
                    return item;
                });
            }
        }
    );

    activeDisposables.push(provider);
}

export function deactivate() {
    disposeProviders();
}