// Разбор файлов нативов Stand (g.source.lua / init.source.lua) в индекс.
// Модуль не зависит от vscode, чтобы его можно было тестировать отдельно.
//
// Формат init.source.lua:
//     SYSTEM={
//         -- описание
//         WAIT=--[[void]] function(--[[int]] ms)return native_invoker.unified_void(ms, 0x4EDE34FBADD967A6, "i")end,
//     }
// Формат g.source.lua — те же строки, но без таблиц: функции глобальные,
// а пространство имён указано комментарием в начале строки:
//     -- SYSTEM
//         WAIT=--[[void]] function(--[[int]] ms)return ...end

export type NativesMode = 'g' | 'init';

export interface NativeParam {
    name: string;
    type: string;
}

export interface NativeFunction {
    name: string;
    namespace: string;
    returnType: string;
    params: NativeParam[];
    comment: string;
    /** Номер строки объявления (с нуля) */
    line: number;
    /** Колонка, с которой начинается имя */
    column: number;
    hash?: string;
}

export interface NativeIndex {
    file: string;
    mode: NativesMode;
    /** Пространство имён -> функции в порядке объявления */
    namespaces: Map<string, NativeFunction[]>;
    /** Строка, где начинается пространство имён */
    namespaceLines: Map<string, number>;
    /** "NS.NAME" -> функция */
    qualified: Map<string, NativeFunction>;
    /** "NAME" -> функция (для g-режима, где функции глобальные) */
    byName: Map<string, NativeFunction>;
    functionCount: number;
}

const INIT_NAMESPACE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*$/;
const G_NAMESPACE = /^--\s*([A-Z_][A-Z0-9_]*)\s*$/;
// NAME=... или ["NAME"]=... (так записаны старые версии, например 3095a)
const FUNCTION_START = /^(\s*)(?:\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]|([A-Za-z_][A-Za-z0-9_]*))\s*=\s*(?:--\[\[(.*?)\]\]\s*)?function\s*\(/;
const COMMENT = /^\s+--\s?(.*)$/;
const PARAM = /(?:--\[\[(.*?)\]\]\s*)?([A-Za-z_][A-Za-z0-9_]*|\.\.\.)/g;
// 0x4EDE34FBADD967A6 (новые версии) или end_call("4EDE34FBADD967A6") (старые, без 0x)
const HASH = /0x[0-9A-Fa-f]{8,16}|end_call\("([0-9A-Fa-f]{8,16})"\)/;
const INVOKER_TYPE = /native_invoker\.(?:uno|unified)_([A-Za-z0-9]+)\s*\(/;

export function parseNatives(text: string, file: string, mode: NativesMode): NativeIndex {
    const index: NativeIndex = {
        file,
        mode,
        namespaces: new Map(),
        namespaceLines: new Map(),
        qualified: new Map(),
        byName: new Map(),
        functionCount: 0,
    };

    const lines = text.split(/\r?\n/);
    let namespace = '';
    let comment: string[] = [];

    const enterNamespace = (name: string, line: number) => {
        namespace = name;
        comment = [];
        if (!index.namespaces.has(name)) {
            index.namespaces.set(name, []);
            index.namespaceLines.set(name, line);
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const ns = line.match(INIT_NAMESPACE) ?? line.match(G_NAMESPACE);
        if (ns) {
            enterNamespace(ns[1], i);
            continue;
        }

        const fn = line.match(FUNCTION_START);
        if (fn) {
            if (!namespace) {
                enterNamespace('_G', i);
            }
            const name = fn[2] ?? fn[3];
            const native: NativeFunction = {
                name,
                namespace,
                // uno-версии без типов: тип берём из native_invoker.uno_int / unified_int
                returnType: (fn[4] ?? line.match(INVOKER_TYPE)?.[1] ?? 'any').trim(),
                params: parseParams(line.slice(fn[0].length)),
                comment: comment.join('\n').trim(),
                line: i,
                column: line.indexOf(name, fn[1].length),
                hash: hashOf(line),
            };
            index.namespaces.get(namespace)!.push(native);
            index.qualified.set(`${namespace}.${native.name}`, native);
            if (!index.byName.has(native.name)) {
                index.byName.set(native.name, native);
            }
            index.functionCount++;
            comment = [];
            continue;
        }

        const c = line.match(COMMENT);
        if (c) {
            comment.push(c[1]);
            continue;
        }

        if (/^\s*\}\s*,?\s*$/.test(line)) {
            comment = [];
        }
    }

    return index;
}

function hashOf(line: string): string | undefined {
    const m = line.match(HASH);
    return m ? (m[1] ? `0x${m[1].toUpperCase()}` : m[0]) : undefined;
}

// Список параметров: до первой ")" вне комментариев --[[ ]] (типы вроде "Any* (pointer)"
// сами содержат скобки). Тело бывает разным: ")return native_invoker..." или ")native_invoker.begin_call()..."
function parseParams(rest: string): NativeParam[] {
    let end = rest.length;
    let inType = false;
    for (let i = 0; i < rest.length; i++) {
        if (!inType && rest.startsWith('--[[', i)) { inType = true; i += 3; continue; }
        if (inType && rest.startsWith(']]', i)) { inType = false; i += 1; continue; }
        if (!inType && rest[i] === ')') { end = i; break; }
    }
    const list = rest.slice(0, end);
    const params: NativeParam[] = [];
    for (const m of list.matchAll(PARAM)) {
        params.push({ name: m[2], type: (m[1] ?? 'any').trim() });
    }
    return params;
}

/** Скомпилированный байткод Luau (g.lua / init.lua в поставке Stand) — сигнатур в нём нет */
export function isBinaryLua(head: Uint8Array): boolean {
    if (head.length >= 4 && head[0] === 0x4c && head[1] === 0x75 && head[2] === 0x61 && head[3] === 0x55) {
        return true; // "LuaU"
    }
    if (head.length >= 4 && head[0] === 0x1b && head[1] === 0x4c) {
        return true; // "\x1bLua" — обычный байткод Lua
    }
    const n = Math.min(head.length, 4096);
    for (let i = 0; i < n; i++) {
        if (head[i] === 0) {
            return true;
        }
    }
    return false;
}

// ---- Представление для подсказок ----

export function paramLabel(p: NativeParam): string {
    return p.type && p.type !== 'any' ? `${p.name}: ${p.type}` : p.name;
}

/** "PED.CREATE_PED(pedType: int, ...): Ped (int)" и смещения параметров в этой строке */
export function signatureLabel(fn: NativeFunction, prefix: string): { label: string; offsets: [number, number][] } {
    let label = `${prefix}${fn.name}(`;
    const offsets: [number, number][] = [];
    fn.params.forEach((p, i) => {
        if (i > 0) {
            label += ', ';
        }
        const text = paramLabel(p);
        offsets.push([label.length, label.length + text.length]);
        label += text;
    });
    label += `): ${fn.returnType}`;
    return { label, offsets };
}

export function snippetBody(fn: NativeFunction): string {
    const args = fn.params.map((p, i) => `\${${i + 1}:${p.name.replace(/[$}\\]/g, '\\$&')}}`).join(', ');
    return `${fn.name}(${args})`;
}
