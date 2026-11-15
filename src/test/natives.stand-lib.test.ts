// Проверка парсера на всех версиях нативов, установленных в Stand (%APPDATA%\Stand\Lua Scripts\lib).
// Если Stand не установлен — тесты пропускаются. Путь можно переопределить: STAND_NATIVES_LIB=<папка>.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { resolveNativesFile, standLibDir } from '../natives/locate';
import { isBinaryLua, parseNatives } from '../natives/parser';

const LIB = process.env.STAND_NATIVES_LIB ?? standLibDir();

/** Все текстовые файлы нативов: natives-<v>/*.lua и однофайловые natives-<v>.lua */
function nativeFiles(lib: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(lib, { withFileTypes: true })) {
        if (!entry.name.startsWith('natives')) {
            continue;
        }
        const full = path.join(lib, entry.name);
        if (entry.isDirectory()) {
            for (const f of fs.readdirSync(full)) {
                if (f.endsWith('.lua')) {
                    files.push(path.join(full, f));
                }
            }
        } else if (entry.name.endsWith('.lua')) {
            files.push(full);
        }
    }
    return files.filter(f => {
        const head = fs.readFileSync(f).subarray(0, 4096);
        // Пропускаем байткод и битые загрузки (HTML «404 Not Found» вместо файла)
        return !isBinaryLua(head) && !/^\s*<(!DOCTYPE|html)/i.test(head.toString('utf8'));
    });
}

/** Строки, похожие на объявление натива: что-то = function( вне комментария */
function declarationLines(text: string): number {
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*--/.test(line)) {
            continue;
        }
        if (/=\s*(?:--\[\[.*?\]\]\s*)?function\s*\(/.test(line)) {
            n++;
        }
    }
    return n;
}

suite('Natives: все версии из Stand lib', () => {
    const files = LIB && fs.existsSync(LIB) ? nativeFiles(LIB) : [];

    test('найдены файлы нативов', function () {
        if (!files.length) {
            this.skip();
        }
    });

    for (const file of files) {
        const name = path.relative(LIB!, file);
        test(name, () => {
            const text = fs.readFileSync(file, 'utf8');
            const mode = /^g(\b|-|\.)/.test(path.basename(file)) ? 'g' : 'init';
            const index = parseNatives(text, file, mode);
            const expected = declarationLines(text);

            assert.ok(index.functionCount > 0, 'не найдено ни одной функции');
            assert.strictEqual(index.functionCount, expected, 'часть объявлений не распознана');
            assert.ok(index.namespaces.size > 1 || !index.namespaces.has('_G'), 'не распознаны пространства имён');

            const fns = [...index.qualified.values()];
            const untyped = fns.filter(f => f.returnType === 'any').length;
            assert.ok(untyped < index.functionCount / 10, `без типа возврата: ${untyped}`);
            const create = index.qualified.get('PED.CREATE_PED');
            assert.ok(create, 'нет PED.CREATE_PED');
            if (!/uno/.test(path.basename(file))) {
                assert.strictEqual(create.hash, '0xD49F9B0955C367DE', 'хэш натива не найден');
            }
            if (/uno/.test(path.basename(file))) {
                // uno: "function(...)" — ни типов, ни имён параметров в файле нет
                assert.deepStrictEqual(create.params.map(p => p.name), ['...']);
            } else {
                assert.strictEqual(create.params.length, 8);
                assert.ok(fns.every(f => f.params.every(p => p.type !== 'any')), 'параметры без типа');
            }
            for (const fn of fns) {
                assert.ok(fn.column >= 0, `${fn.namespace}.${fn.name}: колонка не найдена`);
            }
        });
    }

    // Каждая версия находится в обоих режимах, и выбирается файл с сигнатурами (не uno)
    const versions = LIB && fs.existsSync(LIB)
        ? [...new Set(fs.readdirSync(LIB).map(n => n.match(/^natives-([A-Za-z0-9_-]+?)(?:\.source)?\.lua$/)?.[1] ?? n.match(/^natives-([A-Za-z0-9_-]+)$/)?.[1]).filter((v): v is string => !!v))]
        : [];
    for (const version of versions) {
        for (const mode of ['g', 'init'] as const) {
            const legacy = !fs.existsSync(path.join(LIB!, `natives-${version}`));
            if (legacy && mode === 'g') {
                continue; // у однофайловых версий g-режима не было
            }
            test(`resolve ${version} (${mode})`, () => {
                const r = resolveNativesFile(version, mode, [], [LIB!]);
                assert.ok(r.file, `не найден файл, искали: ${r.searched.join(', ')}`);
                const base = path.basename(r.file);
                assert.ok(base.endsWith('.source.lua'), base);
                // и для "<v>-uno" берётся полный файл с сигнатурами
                assert.ok(!/uno\.source\.lua$/.test(base), base);
                if (!legacy) {
                    assert.strictEqual(base, mode === 'g' ? 'g.source.lua' : 'init.source.lua');
                }
            });
        }
    }
});
