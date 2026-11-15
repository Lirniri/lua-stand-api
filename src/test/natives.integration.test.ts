// Интеграционные тесты: VS Code открывает test-fixtures/workspace (см. .vscode-test.mjs),
// расширение само находит util.require_natives(...) и папку lib/natives-9999z.

import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { StandApiExports } from '../extension';

const WORKSPACE = path.resolve(__dirname, '../../test-fixtures/workspace');

async function activate(): Promise<StandApiExports> {
    const ext = vscode.extensions.getExtension<StandApiExports>('Lirniri.lua-stand-api')!;
    const api = await ext.activate();
    await api.natives.ready;
    return api;
}

async function open(name: string) {
    const doc = await vscode.workspace.openTextDocument(path.join(WORKSPACE, name));
    await vscode.window.showTextDocument(doc);
    return doc;
}

function positionOf(doc: vscode.TextDocument, needle: string, offset = 0): vscode.Position {
    const at = doc.getText().indexOf(needle);
    assert.ok(at >= 0, `нет "${needle}" в ${doc.fileName}`);
    return doc.positionAt(at + offset);
}

function labelOf(item: vscode.CompletionItem): string {
    return typeof item.label === 'string' ? item.label : item.label.label;
}

async function complete(doc: vscode.TextDocument, pos: vscode.Position) {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', doc.uri, pos, undefined, 200
    );
    return list.items;
}

async function definitionFile(doc: vscode.TextDocument, pos: vscode.Position): Promise<string> {
    const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider', doc.uri, pos
    );
    assert.ok(defs.length > 0, 'нет определения');
    const d = defs[0];
    const uri = 'targetUri' in d ? d.targetUri : d.uri;
    return path.basename(uri.fsPath);
}

function hoverText(hovers: vscode.Hover[]): string {
    return hovers.flatMap(h => h.contents).map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value).join('\n');
}

suite('Natives: интеграция', function () {
    this.timeout(60000);

    test('в воркспейсе найдены оба вызова', async () => {
        const api = await activate();
        const all = [...api.natives.allCalls().entries()].map(([uri, calls]) => [path.basename(vscode.Uri.parse(uri).fsPath), calls.map(c => `${c.version}:${c.mode}`)]);
        all.sort();
        assert.deepStrictEqual(all, [
            ['global_mode.pluto', ['9999z:g']],
            ['module_mode.lua', ['9999z:init']],
        ]);
        assert.strictEqual(path.basename((await api.natives.resolveFile('9999z', 'g'))!), 'g.source.lua');
        assert.strictEqual(path.basename((await api.natives.resolveFile('9999z', 'init'))!), 'init.source.lua');
    });

    suite('util.require_natives("9999z", "G") -> g.source.lua', () => {
        test('автодополнение глобальных функций', async () => {
            await activate();
            const doc = await open('global_mode.pluto');
            const items = await complete(doc, positionOf(doc, 'CREATE_PED(4', 'CREATE_'.length));
            const ped = items.find(i => labelOf(i) === 'CREATE_PED');
            assert.ok(ped, 'нет CREATE_PED');
            assert.strictEqual(ped.kind, vscode.CompletionItemKind.Function);
            assert.ok((ped.insertText as vscode.SnippetString).value.startsWith('CREATE_PED(${1:pedType}'));
            assert.ok(items.some(i => labelOf(i) === 'G_ONLY_NATIVE'));
        });

        test('hover: сигнатура, описание и ссылка на g.source.lua', async () => {
            const doc = await open('global_mode.pluto');
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider', doc.uri, positionOf(doc, 'CREATE_PED(4', 3)
            );
            const text = hoverText(hovers);
            assert.ok(text.includes('CREATE_PED(pedType: int, modelHash: Hash (int)'), text);
            assert.ok(text.includes('Ped (int)'));
            assert.ok(text.includes('ePedType'));
            assert.ok(text.includes('g.source.lua:'), text);
        });

        test('signature help: активный параметр', async () => {
            const doc = await open('global_mode.pluto');
            const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
                'vscode.executeSignatureHelpProvider', doc.uri, positionOf(doc, 'CREATE_PED(4, 0, ', 'CREATE_PED(4, 0, '.length)
            );
            assert.ok(help && help.signatures.length, 'нет подсказки параметров');
            assert.ok(help.signatures[0].label.startsWith('CREATE_PED('));
            assert.strictEqual(help.activeParameter, 2);
        });

        test('F12 -> g.source.lua', async () => {
            const doc = await open('global_mode.pluto');
            assert.strictEqual(await definitionFile(doc, positionOf(doc, 'DOES_ENTITY_EXIST', 2)), 'g.source.lua');
        });
    });

    suite('local natives = util.require_natives("9999z") -> init.source.lua', () => {
        test('natives. -> пространства имён, natives.PED. -> функции', async () => {
            await activate();
            const doc = await open('module_mode.lua');
            const ns = await complete(doc, positionOf(doc, 'natives.PED', 'natives.'.length));
            assert.deepStrictEqual(ns.filter(i => i.kind === vscode.CompletionItemKind.Module).map(labelOf).sort(), ['ENTITY', 'PED', 'SYSTEM']);

            const fns = await complete(doc, positionOf(doc, 'natives.PED.CREATE_PED', 'natives.PED.'.length));
            const names = fns.filter(i => i.kind === vscode.CompletionItemKind.Function).map(labelOf);
            assert.ok(names.includes('CREATE_PED'));
            assert.ok(names.includes('INIT_ONLY_NATIVE'));
            assert.ok(!names.includes('G_ONLY_NATIVE'));
        });

        test('глобальное пространство имён ENTITY.', async () => {
            const doc = await open('module_mode.lua');
            const fns = await complete(doc, positionOf(doc, 'ENTITY.SET', 'ENTITY.'.length));
            assert.ok(fns.some(i => labelOf(i) === 'SET_ENTITY_COORDS'));
        });

        test('hover на natives.PED.CREATE_PED и на PED', async () => {
            const doc = await open('module_mode.lua');
            const fn = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider', doc.uri, positionOf(doc, 'CREATE_PED(4', 2)
            ));
            assert.ok(fn.includes('natives.PED.CREATE_PED(pedType: int'), fn);
            assert.ok(fn.includes('init.source.lua:'), fn);

            const ns = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider', doc.uri, positionOf(doc, 'PED.CREATE_PED', 1)
            ));
            assert.ok(ns.includes('PED'), ns);
            assert.ok(ns.includes('нативов'), ns);
        });

        test('signature help на ENTITY.SET_ENTITY_COORDS', async () => {
            const doc = await open('module_mode.lua');
            const call = 'ENTITY.SET_ENTITY_COORDS(ped, 1.0, ';
            const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
                'vscode.executeSignatureHelpProvider', doc.uri, positionOf(doc, call, call.length)
            );
            assert.ok(help && help.signatures.length);
            assert.ok(help.signatures[0].label.startsWith('ENTITY.SET_ENTITY_COORDS('));
            assert.strictEqual(help.activeParameter, 2);
        });

        test('F12 -> init.source.lua', async () => {
            const doc = await open('module_mode.lua');
            assert.strictEqual(await definitionFile(doc, positionOf(doc, 'INIT_ONLY_NATIVE()', 2)), 'init.source.lua');
        });
    });

    test('изменение в редакторе: новый вызов отслеживается без сохранения', async () => {
        const api = await activate();
        const doc = await vscode.workspace.openTextDocument({ language: 'lua', content: '' });
        const editor = await vscode.window.showTextDocument(doc);
        await editor.edit(e => e.insert(new vscode.Position(0, 0), 'util.require_natives("9999z")\nPED.'));
        const items = await complete(doc, new vscode.Position(1, 4));
        assert.ok(items.some(i => labelOf(i) === 'CREATE_PED'));
        assert.ok(api.natives.hasAnyCalls(doc));
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });
});
