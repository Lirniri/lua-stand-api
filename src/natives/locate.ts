// Поиск папки версии нативов и выбор файла внутри неё, плюс кэш разобранных индексов.
// Без зависимостей от vscode (поиск по воркспейсу делает manager.ts и передаёт сюда папки).

import * as fs from 'fs';
import * as path from 'path';
import { isBinaryLua, NativeIndex, NativesMode, parseNatives } from './parser';

/** Версия попадает в glob и пути, поэтому пускаем только безопасные символы */
export function isSafeVersion(version: string): boolean {
    return /^[A-Za-z0-9_-]+$/.test(version);
}

/**
 * Файлы в порядке приоритета: .source.lua содержит полные сигнатуры и комментарии.
 * uno-файлы (те же функции, но без типов и имён параметров) — только запасной вариант.
 */
export function fileNamesFor(mode: NativesMode): string[] {
    return mode === 'g'
        ? ['g.source.lua', 'g.lua', 'g-uno.source.lua', 'g-uno.lua']
        : ['init.source.lua', 'init.lua', 'uno.source.lua', 'uno.lua'];
}

/** Однофайловые нативы старых версий: natives-<v>.lua; для "<v>-uno" сначала полная версия */
export function legacyFileNames(version: string): string[] {
    const base = version.replace(/-uno$/i, '');
    const names = [`natives-${base}.source.lua`, `natives-${version}.source.lua`, `natives-${base}.lua`, `natives-${version}.lua`];
    return [...new Set(names)];
}

export interface PickResult {
    file?: string;
    /** Файлы, которые нашлись, но оказались байткодом */
    skippedBinary: string[];
}

export function pickNativesFile(dir: string, mode: NativesMode): PickResult {
    const skippedBinary: string[] = [];
    for (const name of fileNamesFor(mode)) {
        const file = path.join(dir, name);
        if (!isFile(file)) {
            continue;
        }
        if (readHeadIsBinary(file)) {
            skippedBinary.push(file);
            continue;
        }
        return { file, skippedBinary };
    }
    return { skippedBinary };
}

/** Папки, в которых может лежать версия, относительно корня поиска */
export function versionDirsUnder(root: string, version: string): string[] {
    const dirs = [
        path.join(root, `natives-${version}`),
        path.join(root, 'natives', version),
        path.join(root, version),
    ];
    // Корень может сам указывать на папку версии
    const base = path.basename(root);
    if (base === version || base === `natives-${version}`) {
        dirs.unshift(root);
    }
    return dirs;
}

/** %APPDATA%\Stand\Lua Scripts\lib */
export function standLibDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const appData = env.APPDATA;
    return appData ? path.join(appData, 'Stand', 'Lua Scripts', 'lib') : undefined;
}

export interface ResolveResult extends PickResult {
    searched: string[];
}

/**
 * Перебирает папки по порядку: сначала явные папки версии (из воркспейса),
 * затем корни из настроек и стандартная папка Stand.
 */
export function resolveNativesFile(version: string, mode: NativesMode, versionDirs: string[], roots: string[]): ResolveResult {
    const searched: string[] = [];
    const skippedBinary: string[] = [];
    const seen = new Set<string>();
    const all = [...versionDirs, ...roots.flatMap(r => versionDirsUnder(r, version))];

    for (const dir of all) {
        const key = path.resolve(dir).toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        searched.push(dir);
        if (!isDir(dir)) {
            continue;
        }
        const picked = pickNativesFile(dir, mode);
        skippedBinary.push(...picked.skippedBinary);
        if (picked.file) {
            return { file: picked.file, skippedBinary, searched };
        }
    }

    // Старые версии Stand: один файл lib/natives-<версия>.lua без папки
    for (const root of roots) {
        for (const name of legacyFileNames(version)) {
            const file = path.join(root, name);
            searched.push(file);
            if (!isFile(file)) {
                continue;
            }
            if (readHeadIsBinary(file)) {
                skippedBinary.push(file);
                continue;
            }
            return { file, skippedBinary, searched };
        }
    }
    return { skippedBinary, searched };
}

// ---- Кэш индексов: ключ — путь + mtime ----

interface CacheEntry {
    mtimeMs: number;
    size: number;
    index: Promise<NativeIndex>;
}

export class NativesIndexCache {
    private entries = new Map<string, CacheEntry>();

    /** Сколько раз файл реально разбирался (для тестов и логов) */
    parseCount = 0;

    async get(file: string, mode: NativesMode): Promise<NativeIndex> {
        const stat = await fs.promises.stat(file);
        const key = `${mode}|${path.resolve(file).toLowerCase()}`;
        const cached = this.entries.get(key);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return cached.index;
        }
        const index = fs.promises.readFile(file, 'utf8').then(text => {
            this.parseCount++;
            return parseNatives(text, file, mode);
        });
        this.entries.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, index });
        index.catch(() => this.entries.delete(key));
        return index;
    }

    clear() {
        this.entries.clear();
    }
}

function isFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readHeadIsBinary(file: string): boolean {
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return isBinaryLua(buf.subarray(0, n));
    } catch {
        return true;
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}
