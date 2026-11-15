// Что стоит под курсором и к какому нативу это относится. Без зависимостей от vscode.

import { NativeFunction, NativeIndex } from './parser';

/** Нативы, доступные документу */
export interface NativesScope {
    /** util.require_natives(v, "g") — функции глобальные: CREATE_PED(...) */
    g?: NativeIndex;
    /** util.require_natives(v) — таблицы: PED.CREATE_PED(...) */
    init?: NativeIndex;
    /** Переменные, куда записан результат require_natives: natives.PED.CREATE_PED(...) */
    aliases: Set<string>;
}

export type ResolvedSymbol =
    | { kind: 'namespace'; namespace: string; index: NativeIndex; prefix: string }
    | { kind: 'function'; fn: NativeFunction; index: NativeIndex; prefix: string };

/**
 * segments — цепочка через точку (natives.PED.CREATE_PED), upto — индекс сегмента под курсором.
 * prefix — то, как функцию пишут в коде перед именем ("PED.", "natives.PED." или "").
 */
export function resolveChain(scope: NativesScope, segments: string[], upto = segments.length - 1): ResolvedSymbol | undefined {
    let segs = segments.slice(0, upto + 1);
    let aliasPrefix = '';
    if (segs.length > 1 && scope.aliases.has(segs[0]) && (scope.init || scope.g)) {
        aliasPrefix = segs[0] + '.';
        segs = segs.slice(1);
    }

    if (segs.length === 1) {
        const name = segs[0];
        if (!aliasPrefix && scope.g?.byName.has(name)) {
            return { kind: 'function', fn: scope.g.byName.get(name)!, index: scope.g, prefix: '' };
        }
        const nsIndex = namespaceIndex(scope, name, !!aliasPrefix);
        if (nsIndex) {
            return { kind: 'namespace', namespace: name, index: nsIndex, prefix: aliasPrefix };
        }
        return undefined;
    }

    if (segs.length === 2) {
        const [ns, name] = segs;
        const nsIndex = namespaceIndex(scope, ns, !!aliasPrefix);
        const fn = nsIndex?.qualified.get(`${ns}.${name}`);
        if (nsIndex && fn) {
            return { kind: 'function', fn, index: nsIndex, prefix: `${aliasPrefix}${ns}.` };
        }
    }
    return undefined;
}

/**
 * Индекс, в котором есть пространство имён. Для обычного NS.FUNC предпочитаем init (там NS — таблица),
 * но если подключён только g — тоже находим, чтобы hover/F12 работали и в таком коде.
 */
function namespaceIndex(scope: NativesScope, ns: string, viaAlias: boolean): NativeIndex | undefined {
    if (scope.init?.namespaces.has(ns)) {
        return scope.init;
    }
    if (scope.g?.namespaces.has(ns) && (viaAlias || !scope.init)) {
        return scope.g;
    }
    return undefined;
}

// ---- Разбор текста ----

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/;

/** Курсор внутри строки или комментария (в пределах одной строки текста) */
export function inStringOrComment(linePrefix: string): boolean {
    let quote = '';
    for (let i = 0; i < linePrefix.length; i++) {
        const c = linePrefix[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) { quote = ''; }
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '-' && linePrefix[i + 1] === '-') { return true; }
    }
    return quote !== '';
}

export interface CompletionContext {
    /** Уже набранные сегменты до последней точки */
    chain: string[];
    /** Набираемое слово после последней точки */
    partial: string;
}

export function completionContext(linePrefix: string): CompletionContext | undefined {
    if (inStringOrComment(linePrefix)) {
        return undefined;
    }
    const m = linePrefix.match(/((?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)*)([A-Za-z_0-9]*)$/);
    if (!m) {
        return undefined;
    }
    const before = linePrefix[m.index! - 1];
    // obj:method / obj["x"].y — не наш случай
    if (before === ':' || before === '.' || before === ']' || before === ')') {
        return undefined;
    }
    const chain = m[1].split('.').map(s => s.trim()).filter(Boolean);
    return { chain, partial: m[2] };
}

export interface ChainAt {
    segments: string[];
    /** Сегмент, на котором стоит курсор */
    index: number;
    /** Колонки начала/конца этого сегмента */
    start: number;
    end: number;
}

/** Цепочка идентификаторов через точку, которая покрывает колонку */
export function chainAt(lineText: string, column: number): ChainAt | undefined {
    const re = /[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*/g;
    for (const m of lineText.matchAll(re)) {
        const start = m.index!;
        const end = start + m[0].length;
        if (column < start || column > end) {
            continue;
        }
        const before = lineText[start - 1];
        if (before === ':' || before === '.' || inStringOrComment(lineText.slice(0, start))) {
            return undefined;
        }
        const segments: string[] = [];
        let found = -1;
        let segStart = 0;
        let segEnd = 0;
        for (const s of m[0].matchAll(new RegExp(IDENT.source, 'g'))) {
            const a = start + s.index!;
            const b = a + s[0].length;
            if (found < 0 && column >= a && column <= b) {
                found = segments.length;
                segStart = a;
                segEnd = b;
            }
            segments.push(s[0]);
        }
        if (found < 0) {
            return undefined;
        }
        return { segments, index: found, start: segStart, end: segEnd };
    }
    return undefined;
}

export interface CallContext {
    /** Цепочка перед "(" */
    segments: string[];
    /** Номер текущего аргумента (с нуля) */
    argument: number;
}

/**
 * Находит незакрытую "(" перед offset. Идёт по тексту вперёд, пропуская строки и комментарии,
 * и держит стек скобок; text — фрагмент, который начинается с начала строки.
 */
export function callContext(text: string, offset: number): CallContext | undefined {
    const stack: { pos: number; commas: number; bracket: string }[] = [];
    const n = Math.min(offset, text.length);
    let i = 0;
    while (i < n) {
        const c = text[i];
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i++;
            while (i < n && text[i] !== quote && !(text[i] === '\n' && quote !== '`')) {
                if (text[i] === '\\') { i++; }
                i++;
            }
            i++;
            continue;
        }
        if (c === '-' && text[i + 1] === '-') {
            const long = text.slice(i + 2).match(/^\[(=*)\[/);
            if (long) {
                const close = ']' + long[1] + ']';
                const end = text.indexOf(close, i + 2 + long[0].length);
                i = end < 0 || end + close.length > n ? n + 1 : end + close.length;
            } else {
                while (i < n && text[i] !== '\n') { i++; }
                if (i >= n) {
                    return undefined; // курсор внутри комментария
                }
            }
            continue;
        }
        if (c === '[' && /^\[=*\[/.test(text.slice(i, i + 20))) {
            const long = text.slice(i).match(/^\[(=*)\[/)!;
            const close = ']' + long[1] + ']';
            const end = text.indexOf(close, i + long[0].length);
            i = end < 0 || end + close.length > n ? n + 1 : end + close.length;
            continue;
        }
        if (c === '(' || c === '{' || c === '[') {
            stack.push({ pos: i, commas: 0, bracket: c });
        } else if (c === ')' || c === '}' || c === ']') {
            stack.pop();
        } else if (c === ',' && stack.length) {
            stack[stack.length - 1].commas++;
        }
        i++;
    }
    if (i > n) {
        return undefined; // курсор внутри строки/комментария
    }

    const top = stack[stack.length - 1];
    if (!top || top.bracket !== '(') {
        return undefined;
    }
    const before = text.slice(Math.max(0, top.pos - 300), top.pos);
    const m = before.match(/([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*$/);
    if (!m) {
        return undefined;
    }
    const prev = before[m.index! - 1];
    if (prev === ':' || prev === '.') {
        return undefined;
    }
    return { segments: m[1].split('.').map(s => s.trim()), argument: top.commas };
}
