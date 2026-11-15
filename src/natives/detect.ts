// Поиск вызовов util.require_natives(...) в тексте скрипта. Без зависимостей от vscode.
//
// Поддерживаются:
//     util.require_natives("3407a")                 -> init.*, пространства имён ENTITY, PED...
//     util.require_natives('3407a', "G")            -> g.*, функции глобальные
//     util.require_natives("3407a.g")               -> то же, что и "g" вторым аргументом
//     util.require_natives(1681379138)              -> старые версии с числом
//     local natives = util.require_natives("3407a") -> ещё и natives.ENTITY...
//     measure("...", util.require_natives, "3407a") -> функция передана в обёртку (как в AnitaDarin)

import { NativesMode } from './parser';

export interface RequireCall {
    version: string;
    mode: NativesMode;
    /** Переменная, в которую записан результат (только для режима init) */
    variable?: string;
    /** Строка вызова (с нуля) */
    line: number;
}

const CALL = /util\s*\.\s*require_natives\s*(\(|,)\s*(?:(["'])([^"'\r\n]+)\2|(\d+))(?:\s*,\s*(["'])([^"'\r\n]*)\5)?/g;
const ASSIGNMENT = /(?:^|[^A-Za-z0-9_.])(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*=\s*$/;

export function findRequireCalls(text: string): RequireCall[] {
    const code = maskComments(text);
    const calls: RequireCall[] = [];

    for (const m of code.matchAll(CALL)) {
        let version = (m[3] ?? m[4]).trim();
        const flag = m[6];
        // "g" / "G" (и "g-uno") — глобальные функции, всё остальное — таблицы
        let mode: NativesMode = flag !== undefined && /^g(-uno)?$/i.test(flag.trim()) ? 'g' : 'init';

        // "3407a.g", "2944a.uno", "2944a.g-uno" — флейвор через точку. uno — те же нативы,
        // поэтому для подсказок читается полный файл той же версии
        const dotted = version.match(/^(.+)\.(g|uno|g-uno)$/i);
        if (dotted) {
            version = dotted[1];
            mode = dotted[2].toLowerCase().startsWith('g') ? 'g' : 'init';
        }

        const start = m.index!;
        const lineStart = code.lastIndexOf('\n', start - 1) + 1;
        const line = countLines(code, start);

        let variable: string | undefined;
        if (m[1] === '(' && mode === 'init') {
            const before = code.slice(lineStart, start);
            variable = before.match(ASSIGNMENT)?.[1];
        }

        calls.push({ version, mode, variable, line });
    }
    return calls;
}

function countLines(text: string, end: number): number {
    let n = 0;
    for (let i = text.indexOf('\n'); i >= 0 && i < end; i = text.indexOf('\n', i + 1)) {
        n++;
    }
    return n;
}

/**
 * Заменяет комментарии пробелами (переводы строк сохраняются), строки оставляет как есть.
 * Так закомментированный вызов не считается, а номера строк и позиции не сдвигаются.
 */
export function maskComments(text: string): string {
    const out = text.split('');
    const n = text.length;
    let i = 0;

    const blank = (from: number, to: number) => {
        for (let k = from; k < to && k < n; k++) {
            if (out[k] !== '\n' && out[k] !== '\r') {
                out[k] = ' ';
            }
        }
    };

    while (i < n) {
        const ch = text[i];

        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipQuoted(text, i);
            continue;
        }

        if (ch === '[') {
            const level = longBracketLevel(text, i);
            if (level >= 0) {
                i = skipLongBracket(text, i, level);
                continue;
            }
        }

        if (ch === '-' && text[i + 1] === '-') {
            const start = i;
            if (text[i + 2] === '[') {
                const level = longBracketLevel(text, i + 2);
                if (level >= 0) {
                    i = skipLongBracket(text, i + 2, level);
                    blank(start, i);
                    continue;
                }
            }
            while (i < n && text[i] !== '\n') {
                i++;
            }
            blank(start, i);
            continue;
        }
        i++;
    }
    return out.join('');
}

function skipQuoted(text: string, i: number): number {
    const quote = text[i];
    i++;
    while (i < text.length) {
        const c = text[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote) { return i + 1; }
        if (c === '\n' && quote !== '`') { return i; }
        i++;
    }
    return i;
}

/** "[[" -> 0, "[==[" -> 2, иначе -1 */
function longBracketLevel(text: string, i: number): number {
    if (text[i] !== '[') {
        return -1;
    }
    let k = i + 1;
    while (text[k] === '=') {
        k++;
    }
    return text[k] === '[' ? k - i - 1 : -1;
}

function skipLongBracket(text: string, i: number, level: number): number {
    const close = ']' + '='.repeat(level) + ']';
    const end = text.indexOf(close, i + level + 2);
    return end < 0 ? text.length : end + close.length;
}
