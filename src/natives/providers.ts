// Автодополнение, Hover, SignatureHelp и Go to Definition для нативов из util.require_natives(...)

import * as vscode from 'vscode';
import * as path from 'path';
import { NativesManager } from './manager';
import { NativeFunction, NativeIndex, paramLabel, signatureLabel, snippetBody } from './parser';
import { callContext, chainAt, completionContext, NativesScope, resolveChain } from './symbols';

export const SELECTOR: vscode.DocumentSelector = [
    { language: 'lua' },
    { language: 'pluto' },
    { pattern: '**/*.pluto' },
    { pattern: '**/*.lua' },
];

export function registerNativeProviders(manager: NativesManager): vscode.Disposable[] {
    return [
        vscode.languages.registerCompletionItemProvider(SELECTOR, new NativeCompletionProvider(manager), '.'),
        vscode.languages.registerHoverProvider(SELECTOR, new NativeHoverProvider(manager)),
        vscode.languages.registerSignatureHelpProvider(SELECTOR, new NativeSignatureProvider(manager), {
            triggerCharacters: ['(', ','],
            retriggerCharacters: [','],
        }),
        vscode.languages.registerDefinitionProvider(SELECTOR, new NativeDefinitionProvider(manager)),
    ];
}

function isEmpty(scope: NativesScope): boolean {
    return !scope.g && !scope.init;
}

// ---- Документация ----

function fileLink(index: NativeIndex, line: number): string {
    const uri = vscode.Uri.file(index.file).with({ fragment: `L${line + 1}` });
    return `[${path.basename(index.file)}:${line + 1}](${uri.toString()})`;
}

export function functionMarkdown(fn: NativeFunction, index: NativeIndex, prefix: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendCodeblock(signatureLabel(fn, prefix).label, 'lua');
    if (fn.comment) {
        md.appendCodeblock(fn.comment, 'text');
    }
    if (fn.params.length) {
        md.appendMarkdown('**Параметры:**\n\n');
        for (const p of fn.params) {
            md.appendMarkdown(`- \`${p.name}\`: \`${p.type}\`\n`);
        }
        md.appendMarkdown('\n');
    }
    md.appendMarkdown(`**Возвращает:** \`${fn.returnType}\`\n\n`);
    const where = index.mode === 'g' ? `${fn.namespace} · глобальная` : fn.namespace;
    md.appendMarkdown(`${where}${fn.hash ? ` · \`${fn.hash}\`` : ''} · ${fileLink(index, fn.line)}`);
    return md;
}

function namespaceMarkdown(ns: string, index: NativeIndex): vscode.MarkdownString {
    const fns = index.namespaces.get(ns) ?? [];
    const md = new vscode.MarkdownString();
    md.appendCodeblock(`${ns} -- ${fns.length} нативов`, 'lua');
    md.appendMarkdown(`Пространство имён нативов GTA V · ${fileLink(index, index.namespaceLines.get(ns) ?? 0)}`);
    return md;
}

// ---- Completion ----

const itemFn = new WeakMap<vscode.CompletionItem, { fn: NativeFunction; index: NativeIndex; prefix: string }>();

class NativeCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly manager: NativesManager) {}

    async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
        const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
        const ctx = completionContext(linePrefix);
        if (!ctx) {
            return undefined;
        }
        const scope = await this.manager.scopeFor(document);
        if (isEmpty(scope)) {
            return undefined;
        }
        const range = new vscode.Range(position.translate(0, -ctx.partial.length), position);
        const items: vscode.CompletionItem[] = [];

        let chain = ctx.chain;
        let aliasPrefix = '';
        if (chain.length && scope.aliases.has(chain[0])) {
            aliasPrefix = chain[0] + '.';
            chain = chain.slice(1);
            if (chain.length === 0) {
                // natives. -> пространства имён
                const index = scope.init ?? scope.g!;
                items.push(...namespaceItems(index, range));
                return items;
            }
        }

        if (chain.length === 0) {
            if (!ctx.partial) {
                return undefined;
            }
            if (scope.init) {
                items.push(...namespaceItems(scope.init, range));
            }
            if (scope.g) {
                for (const fns of scope.g.namespaces.values()) {
                    for (const fn of fns) {
                        items.push(functionItem(fn, scope.g, '', range, true));
                    }
                }
            }
            return items;
        }

        if (chain.length === 1) {
            const resolved = resolveChain(scope, aliasPrefix ? [aliasPrefix.slice(0, -1), chain[0]] : [chain[0]]);
            if (resolved?.kind !== 'namespace') {
                return undefined;
            }
            for (const fn of resolved.index.namespaces.get(resolved.namespace) ?? []) {
                items.push(functionItem(fn, resolved.index, resolved.prefix + resolved.namespace + '.', range, false));
            }
            return items;
        }
        return undefined;
    }

    resolveCompletionItem(item: vscode.CompletionItem) {
        const data = itemFn.get(item);
        if (data) {
            item.documentation = functionMarkdown(data.fn, data.index, data.prefix);
        }
        return item;
    }
}

function namespaceItems(index: NativeIndex, range: vscode.Range): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    for (const [ns, fns] of index.namespaces) {
        if (ns === '_G') {
            continue;
        }
        const item = new vscode.CompletionItem(
            { label: ns, description: `${fns.length} нативов` },
            vscode.CompletionItemKind.Module
        );
        item.range = range;
        item.detail = `Нативы GTA V (${path.basename(index.file)})`;
        item.documentation = namespaceMarkdown(ns, index);
        item.command = { command: 'editor.action.triggerSuggest', title: '' };
        item.insertText = ns + '.';
        items.push(item);
    }
    return items;
}

function functionItem(fn: NativeFunction, index: NativeIndex, prefix: string, range: vscode.Range, showNamespace: boolean) {
    const params = fn.params.map(paramLabel).join(', ');
    const item = new vscode.CompletionItem(
        {
            label: fn.name,
            detail: `(${params})`,
            description: showNamespace ? `${fn.returnType} · ${fn.namespace}` : fn.returnType,
        },
        vscode.CompletionItemKind.Function
    );
    item.range = range;
    item.filterText = fn.name;
    item.detail = `${prefix}${fn.name}(${params}): ${fn.returnType}`;
    item.insertText = new vscode.SnippetString(snippetBody(fn));
    item.command = { command: 'editor.action.triggerParameterHints', title: '' };
    itemFn.set(item, { fn, index, prefix });
    return item;
}

// ---- Hover ----

class NativeHoverProvider implements vscode.HoverProvider {
    constructor(private readonly manager: NativesManager) {}

    async provideHover(document: vscode.TextDocument, position: vscode.Position) {
        const line = document.lineAt(position.line).text;
        const at = chainAt(line, position.character);
        if (!at) {
            return undefined;
        }
        const scope = await this.manager.scopeFor(document);
        const resolved = resolveChain(scope, at.segments, at.index);
        if (!resolved) {
            return undefined;
        }
        const range = new vscode.Range(position.line, at.start, position.line, at.end);
        const md = resolved.kind === 'function'
            ? functionMarkdown(resolved.fn, resolved.index, resolved.prefix)
            : namespaceMarkdown(resolved.namespace, resolved.index);
        return new vscode.Hover(md, range);
    }
}

// ---- Signature help ----

class NativeSignatureProvider implements vscode.SignatureHelpProvider {
    constructor(private readonly manager: NativesManager) {}

    async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position) {
        // Фрагмент до курсора с начала строки, не длиннее ~60 строк
        const startLine = Math.max(0, position.line - 60);
        const text = document.getText(new vscode.Range(startLine, 0, position.line, position.character));
        const call = callContext(text, text.length);
        if (!call) {
            return undefined;
        }
        const scope = await this.manager.scopeFor(document);
        const resolved = resolveChain(scope, call.segments);
        if (resolved?.kind !== 'function') {
            return undefined;
        }
        const { fn, index, prefix } = resolved;
        const { label, offsets } = signatureLabel(fn, prefix);
        const info = new vscode.SignatureInformation(label, functionMarkdown(fn, index, prefix));
        info.parameters = fn.params.map((p, i) => new vscode.ParameterInformation(offsets[i], `${p.type}`));

        const help = new vscode.SignatureHelp();
        help.signatures = [info];
        help.activeSignature = 0;
        help.activeParameter = Math.min(call.argument, Math.max(0, fn.params.length - 1));
        return help;
    }
}

// ---- Definition ----

class NativeDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly manager: NativesManager) {}

    async provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
        const at = chainAt(document.lineAt(position.line).text, position.character);
        if (!at) {
            return undefined;
        }
        const scope = await this.manager.scopeFor(document);
        const resolved = resolveChain(scope, at.segments, at.index);
        if (!resolved) {
            return undefined;
        }
        const uri = vscode.Uri.file(resolved.index.file);
        if (resolved.kind === 'function') {
            const fn = resolved.fn;
            return new vscode.Location(uri, new vscode.Range(fn.line, fn.column, fn.line, fn.column + fn.name.length));
        }
        return new vscode.Location(uri, new vscode.Position(resolved.index.namespaceLines.get(resolved.namespace) ?? 0, 0));
    }
}
