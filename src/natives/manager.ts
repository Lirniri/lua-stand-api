// Следит за вызовами util.require_natives(...) во всём воркспейсе и отдаёт нативы для документа.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findRequireCalls, RequireCall } from './detect';
import { isSafeVersion, legacyFileNames, NativesIndexCache, resolveNativesFile, standLibDir } from './locate';
import { NativeIndex, NativesMode } from './parser';
import { NativesScope } from './symbols';

const SCRIPT_GLOB = '**/*.{lua,pluto}';
const EXCLUDE_GLOB = '**/{node_modules,.git,.vscode-test,out}/**';
/** Сами файлы нативов (1-2 МБ) не сканируем на вызовы */
const MAX_SCAN_SIZE = 512 * 1024;
const NATIVES_FILE = /^(g|init|g-uno|uno)(\.source)?\.lua$/i;

export class NativesManager implements vscode.Disposable {
    private calls = new Map<string, RequireCall[]>();
    private docCalls = new Map<string, { version: number; calls: RequireCall[] }>();
    private resolved = new Map<string, Promise<string | undefined>>();
    private warned = new Set<string>();
    private disposables: vscode.Disposable[] = [];
    private debounce = new Map<string, NodeJS.Timeout>();
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly cache = new NativesIndexCache();
    readonly ready: Promise<void>;
    readonly onDidChange = this.emitter.event;

    constructor(private readonly output: vscode.OutputChannel) {
        this.ready = this.scanWorkspace();

        const scripts = vscode.workspace.createFileSystemWatcher(SCRIPT_GLOB);
        const nativeFiles = vscode.workspace.createFileSystemWatcher('**/{g,init}{,.source}.lua');
        this.disposables.push(
            scripts, nativeFiles, this.emitter,
            scripts.onDidCreate(uri => this.scanFile(uri)),
            scripts.onDidChange(uri => this.scanFile(uri)),
            scripts.onDidDelete(uri => this.setCalls(uri, [])),
            nativeFiles.onDidCreate(() => this.resolved.clear()),
            nativeFiles.onDidDelete(() => this.resolved.clear()),
            vscode.workspace.onDidChangeTextDocument(e => this.scheduleDocument(e.document)),
            vscode.workspace.onDidSaveTextDocument(doc => this.updateFromDocument(doc)),
            vscode.workspace.onDidOpenTextDocument(doc => this.updateFromDocument(doc)),
            vscode.workspace.onDidChangeWorkspaceFolders(() => { this.resolved.clear(); void this.scanWorkspace(); }),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('standApi.natives')) {
                    this.resolved.clear();
                    this.warned.clear();
                    this.emitter.fire();
                }
            }),
        );
    }

    dispose() {
        this.debounce.forEach(t => clearTimeout(t));
        this.disposables.forEach(d => d.dispose());
    }

    /** Есть ли в проекте хоть один вызов require_natives */
    hasAnyCalls(document?: vscode.TextDocument): boolean {
        if (document && this.callsForDocument(document).length) {
            return true;
        }
        for (const list of this.calls.values()) {
            if (list.length) {
                return true;
            }
        }
        return false;
    }

    allCalls(): Map<string, RequireCall[]> {
        return this.calls;
    }

    /** Нативы, доступные документу: его собственные вызовы в приоритете, затем — остальные в проекте */
    async scopeFor(document: vscode.TextDocument): Promise<NativesScope> {
        await this.ready;
        const own = this.callsForDocument(document);
        const others: RequireCall[] = [];
        for (const [uri, list] of this.calls) {
            if (uri !== document.uri.toString()) {
                others.push(...list);
            }
        }
        const ordered = [...own, ...others];

        const scope: NativesScope = { aliases: new Set() };
        for (const c of own) {
            if (c.variable) {
                scope.aliases.add(c.variable);
            }
        }

        const first = (mode: NativesMode) => ordered.filter(c => c.mode === mode);
        scope.g = await this.firstIndex(first('g'));
        scope.init = await this.firstIndex(first('init'));
        return scope;
    }

    private async firstIndex(calls: RequireCall[]): Promise<NativeIndex | undefined> {
        const tried = new Set<string>();
        for (const c of calls) {
            const key = `${c.version}|${c.mode}`;
            if (tried.has(key)) {
                continue;
            }
            tried.add(key);
            const file = await this.resolveFile(c.version, c.mode);
            if (file) {
                try {
                    const index = await this.cache.get(file, c.mode);
                    if (index.functionCount > 0) {
                        return index;
                    }
                    // Например, HTML «404 Not Found» вместо файла нативов после неудачной загрузки
                    this.output.appendLine(`В ${file} не найдено ни одного натива — файл пропущен.`);
                } catch (e) {
                    this.output.appendLine(`Ошибка чтения ${file}: ${(e as Error).message}`);
                }
            }
        }
        return undefined;
    }

    resolveFile(version: string, mode: NativesMode): Promise<string | undefined> {
        const key = `${version}|${mode}`;
        let p = this.resolved.get(key);
        if (!p) {
            p = this.doResolve(version, mode);
            this.resolved.set(key, p);
        }
        return p;
    }

    private async doResolve(version: string, mode: NativesMode): Promise<string | undefined> {
        if (!isSafeVersion(version)) {
            return undefined;
        }
        // 1. Воркспейс: **/natives-<v>/, **/natives/<v>/, **/<v>/
        const dirs = new Set<string>();
        const patterns = [`**/natives-${version}/{g,init}*.lua`, `**/${version}/{g,init}*.lua`];
        for (const pattern of patterns) {
            const found = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, 50);
            for (const uri of found) {
                dirs.add(path.dirname(uri.fsPath));
            }
        }
        // Ближе к корню — раньше
        const workspaceDirs = [...dirs].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
        // Однофайловые нативы старых версий: **/natives-<v>.lua
        const legacyRoots = (await vscode.workspace.findFiles(`**/{${legacyFileNames(version).join(',')}}`, EXCLUDE_GLOB, 10))
            .map(uri => path.dirname(uri.fsPath));

        // 2. Пути из настроек, 3. %APPDATA%\Stand\Lua Scripts\lib
        const config = vscode.workspace.getConfiguration('standApi.natives');
        const roots = [...legacyRoots, ...(config.get<string[]>('paths') ?? []).map(p => expandPath(p))];
        const lib = standLibDir();
        if (lib) {
            roots.push(lib);
        }

        const result = resolveNativesFile(version, mode, workspaceDirs, roots);
        for (const bin of result.skippedBinary) {
            this.output.appendLine(`Пропущен ${bin}: это скомпилированный байткод, сигнатур в нём нет.`);
        }
        if (result.file) {
            this.output.appendLine(`Нативы ${version} (${mode}): ${result.file}`);
            return result.file;
        }

        const key = `${version}|${mode}`;
        this.output.appendLine(`Нативы ${version} (${mode}) не найдены. Искали в:\n  ${result.searched.join('\n  ')}`);
        if (!this.warned.has(key)) {
            this.warned.add(key);
            const files = mode === 'g' ? 'g.source.lua / g.lua' : 'init.source.lua / init.lua';
            void vscode.window.showWarningMessage(
                `Stand: не найдены нативы "${version}" (${files}). Укажите папку в настройке standApi.natives.paths.`,
                'Открыть настройки', 'Показать лог'
            ).then(choice => {
                if (choice === 'Открыть настройки') {
                    void vscode.commands.executeCommand('workbench.action.openSettings', 'standApi.natives.paths');
                } else if (choice === 'Показать лог') {
                    this.output.show(true);
                }
            });
        }
        return undefined;
    }

    // ---- Отслеживание вызовов ----

    private callsForDocument(document: vscode.TextDocument): RequireCall[] {
        const key = document.uri.toString();
        const cached = this.docCalls.get(key);
        if (cached && cached.version === document.version) {
            return cached.calls;
        }
        const calls = isScript(document.uri) || isScriptLanguage(document) ? findRequireCalls(document.getText()) : [];
        this.docCalls.set(key, { version: document.version, calls });
        return calls;
    }

    private scheduleDocument(document: vscode.TextDocument) {
        if (!isScript(document.uri) && !isScriptLanguage(document)) {
            return;
        }
        const key = document.uri.toString();
        clearTimeout(this.debounce.get(key));
        this.debounce.set(key, setTimeout(() => {
            this.debounce.delete(key);
            this.updateFromDocument(document);
        }, 300));
    }

    private updateFromDocument(document: vscode.TextDocument) {
        if (document.uri.scheme !== 'file' || (!isScript(document.uri) && !isScriptLanguage(document))) {
            return;
        }
        if (NATIVES_FILE.test(path.basename(document.uri.fsPath))) {
            return;
        }
        this.setCalls(document.uri, this.callsForDocument(document));
    }

    private setCalls(uri: vscode.Uri, calls: RequireCall[]) {
        const key = uri.toString();
        const before = JSON.stringify(this.calls.get(key) ?? []);
        if (calls.length) {
            this.calls.set(key, calls);
        } else {
            this.calls.delete(key);
        }
        if (JSON.stringify(calls) !== before) {
            this.emitter.fire();
        }
    }

    private async scanFile(uri: vscode.Uri) {
        if (NATIVES_FILE.test(path.basename(uri.fsPath))) {
            return;
        }
        // Открытый документ важнее файла на диске
        const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        if (open) {
            this.updateFromDocument(open);
            return;
        }
        try {
            const stat = await fs.promises.stat(uri.fsPath);
            if (stat.size > MAX_SCAN_SIZE) {
                return;
            }
            const text = await fs.promises.readFile(uri.fsPath, 'utf8');
            this.setCalls(uri, findRequireCalls(text));
        } catch {
            this.setCalls(uri, []);
        }
    }

    private async scanWorkspace() {
        const started = Date.now();
        const files = await vscode.workspace.findFiles(SCRIPT_GLOB, EXCLUDE_GLOB);
        const batch = 32;
        for (let i = 0; i < files.length; i += batch) {
            await Promise.all(files.slice(i, i + batch).map(uri => this.scanFile(uri)));
        }
        let total = 0;
        this.calls.forEach(l => total += l.length);
        this.output.appendLine(`Просканировано файлов: ${files.length}, вызовов util.require_natives: ${total} (${Date.now() - started} мс)`);
    }
}

function isScript(uri: vscode.Uri): boolean {
    return /\.(lua|pluto)$/i.test(uri.fsPath);
}

function isScriptLanguage(document: vscode.TextDocument): boolean {
    return document.languageId === 'lua' || document.languageId === 'pluto';
}

/** Раскрывает %APPDATA%, ${env:APPDATA} и ~ в путях из настроек */
function expandPath(p: string): string {
    let out = p
        .replace(/%([^%]+)%/g, (s, name) => process.env[name] ?? s)
        .replace(/\$\{env:([^}]+)\}/g, (s, name) => process.env[name] ?? s);
    if (out.startsWith('~')) {
        out = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', out.slice(1));
    }
    if (!path.isAbsolute(out) && vscode.workspace.workspaceFolders?.length) {
        out = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, out);
    }
    return out;
}
