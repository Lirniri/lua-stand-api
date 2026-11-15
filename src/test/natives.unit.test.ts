import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { findRequireCalls } from '../natives/detect';
import { legacyFileNames, NativesIndexCache, pickNativesFile, resolveNativesFile, versionDirsUnder } from '../natives/locate';
import { isBinaryLua, parseNatives, signatureLabel, snippetBody } from '../natives/parser';
import { callContext, chainAt, completionContext, NativesScope, resolveChain } from '../natives/symbols';

const FIXTURES = path.resolve(__dirname, '../../test-fixtures');
const NATIVES_DIR = path.join(FIXTURES, 'workspace', 'lib', 'natives-9999z');
const LIB = path.join(FIXTURES, 'workspace', 'lib');

suite('Natives: детект util.require_natives', () => {
    test('режим g: "g" / "G", одинарные и двойные кавычки, пробелы', () => {
        const calls = findRequireCalls([
            'util.require_natives("3407a", "g")',
            "util.require_natives( '3407a' ,  'G' )",
            'util . require_natives("3407a","g")',
        ].join('\n'));
        assert.deepStrictEqual(calls.map(c => [c.version, c.mode, c.line]), [
            ['3407a', 'g', 0], ['3407a', 'g', 1], ['3407a', 'g', 2],
        ]);
        assert.ok(calls.every(c => c.variable === undefined));
    });

    test('режим init и присваивание в переменную', () => {
        const calls = findRequireCalls([
            'util.require_natives("3407a")',
            'local natives = util.require_natives("3407a")',
            'Atdar.natives = util.require_natives(\'3095a\')',
        ].join('\n'));
        assert.deepStrictEqual(calls.map(c => [c.version, c.mode, c.variable]), [
            ['3407a', 'init', undefined],
            ['3407a', 'init', 'natives'],
            ['3095a', 'init', 'Atdar.natives'],
        ]);
    });

    test('переменная не берётся в режиме g', () => {
        const [call] = findRequireCalls('local n = util.require_natives("3407a", "G")');
        assert.strictEqual(call.mode, 'g');
        assert.strictEqual(call.variable, undefined);
    });

    test('"3407a.g", число и вызов через обёртку (как в AnitaDarin)', () => {
        const calls = findRequireCalls([
            'util.require_natives("3407a.g")',
            'util.require_natives(1681379138)',
            'Atdar.loader.measure("natives-3407a (util.require_natives)", util.require_natives, "3407a")',
            'measure(util.require_natives, "3407a", "g")',
        ].join('\n'));
        assert.deepStrictEqual(calls.map(c => [c.version, c.mode]), [
            ['3407a', 'g'], ['1681379138', 'init'], ['3407a', 'init'], ['3407a', 'g'],
        ]);
    });

    test('uno-флейворы: "2944a.uno", "2944a.g-uno", второй аргумент "g-uno", "1660775568-uno"', () => {
        const calls = findRequireCalls([
            'util.require_natives("2944a.uno")',
            'util.require_natives("2944a.g-uno")',
            'util.require_natives("2944a", "G-uno")',
            'util.require_natives("1660775568-uno")',
        ].join('\n'));
        assert.deepStrictEqual(calls.map(c => [c.version, c.mode]), [
            ['2944a', 'init'], ['2944a', 'g'], ['2944a', 'g'], ['1660775568-uno', 'init'],
        ]);
    });

    test('вызовы в комментариях не считаются', () => {
        const calls = findRequireCalls([
            '-- util.require_natives("1111")',
            '--[[ util.require_natives("2222", "g") ]]',
            '--[==[',
            'util.require_natives("3333")',
            ']==]',
            'util.require_natives("4444") -- util.require_natives("5555")',
        ].join('\n'));
        assert.deepStrictEqual(calls.map(c => [c.version, c.line]), [['4444', 5]]);
    });
});

suite('Natives: выбор файла', () => {
    test('g -> g.source.lua, init -> init.source.lua', () => {
        assert.strictEqual(path.basename(pickNativesFile(NATIVES_DIR, 'g').file!), 'g.source.lua');
        assert.strictEqual(path.basename(pickNativesFile(NATIVES_DIR, 'init').file!), 'init.source.lua');
    });

    test('текстовый g.lua берётся, бинарный init.lua пропускается', () => {
        const dir = path.join(FIXTURES, 'plain', 'natives-1111b');
        const g = pickNativesFile(dir, 'g');
        assert.strictEqual(path.basename(g.file!), 'g.lua');
        const init = pickNativesFile(dir, 'init');
        assert.strictEqual(init.file, undefined);
        assert.deepStrictEqual(init.skippedBinary.map(f => path.basename(f)), ['init.lua']);
    });

    test('папки поиска: natives-<v>, natives/<v>, <v>, и сама папка версии', () => {
        const dirs = versionDirsUnder(path.join('C:', 'lib'), '3407a');
        assert.deepStrictEqual(dirs.map(d => path.relative(path.join('C:', 'lib'), d)), [
            'natives-3407a', path.join('natives', '3407a'), '3407a',
        ]);
        assert.strictEqual(versionDirsUnder(NATIVES_DIR, '9999z')[0], NATIVES_DIR);
    });

    test('resolveNativesFile: корень lib из настроек', () => {
        const g = resolveNativesFile('9999z', 'g', [], [LIB]);
        assert.strictEqual(path.basename(g.file!), 'g.source.lua');
        const init = resolveNativesFile('9999z', 'init', [], [LIB]);
        assert.strictEqual(path.basename(init.file!), 'init.source.lua');
        assert.strictEqual(resolveNativesFile('0000x', 'g', [], [LIB]).file, undefined);
    });

    test('однофайловые старые версии: natives-<v>-uno -> сначала полный natives-<v>.source.lua', () => {
        assert.deepStrictEqual(legacyFileNames('1660775568-uno'), [
            'natives-1660775568.source.lua', 'natives-1660775568-uno.source.lua', 'natives-1660775568.lua', 'natives-1660775568-uno.lua',
        ]);
    });

    test('uno: тип возврата выводится из native_invoker.uno_*', () => {
        const idx = parseNatives('PED={\n\t["CREATE_PED"]=function(...)return native_invoker.uno_int(0xD49F9B0955C367DE,...)end,\n}', 'x', 'init');
        const fn = idx.qualified.get('PED.CREATE_PED')!;
        assert.strictEqual(fn.returnType, 'int');
        assert.deepStrictEqual(fn.params, [{ name: '...', type: 'any' }]);
    });

    test('isBinaryLua', () => {
        assert.ok(isBinaryLua(fs.readFileSync(path.join(NATIVES_DIR, 'g.lua'))));
        assert.ok(!isBinaryLua(fs.readFileSync(path.join(NATIVES_DIR, 'g.source.lua'))));
    });
});

suite('Natives: парсер', () => {
    const gFile = path.join(NATIVES_DIR, 'g.source.lua');
    const initFile = path.join(NATIVES_DIR, 'init.source.lua');
    const g = parseNatives(fs.readFileSync(gFile, 'utf8'), gFile, 'g');
    const init = parseNatives(fs.readFileSync(initFile, 'utf8'), initFile, 'init');

    test('g.source.lua: пространства имён из комментариев, функции глобальные', () => {
        assert.deepStrictEqual([...g.namespaces.keys()], ['SYSTEM', 'ENTITY', 'PED']);
        assert.ok(g.byName.has('CREATE_PED'));
        assert.ok(g.byName.has('G_ONLY_NATIVE'));
        assert.ok(!g.byName.has('INIT_ONLY_NATIVE'));
        assert.strictEqual(g.byName.get('CREATE_PED')!.namespace, 'PED');
    });

    test('init.source.lua: таблицы NS={...}, ключи ["NAME"] и тело без return', () => {
        assert.deepStrictEqual([...init.namespaces.keys()], ['SYSTEM', 'ENTITY', 'PED']);
        assert.ok(init.qualified.has('PED.INIT_ONLY_NATIVE'));
        const bone = init.qualified.get('PED.GET_PED_BONE_COORDS')!;
        assert.deepStrictEqual(bone.params.map(p => [p.name, p.type]), [
            ['ped', 'Ped (int)'], ['boneId', 'int'], ['offsetX', 'Any* (pointer)'],
        ]);
        assert.strictEqual(bone.returnType, 'Vector3 (vector3)');
    });

    test('сигнатура, комментарий, строка, хэш', () => {
        const fn = init.qualified.get('PED.CREATE_PED')!;
        assert.strictEqual(fn.returnType, 'Ped (int)');
        assert.strictEqual(fn.params.length, 8);
        assert.strictEqual(fn.comment, 'https://alloc8or.re/gta5/doc/enums/ePedType.txt');
        assert.strictEqual(fn.hash, '0xD49F9B0955C367DE');
        assert.strictEqual(fs.readFileSync(initFile, 'utf8').split(/\r?\n/)[fn.line].trim().startsWith('CREATE_PED='), true);
        assert.strictEqual(signatureLabel(init.qualified.get('SYSTEM.WAIT')!, 'SYSTEM.').label, 'SYSTEM.WAIT(ms: int): void');
        assert.strictEqual(snippetBody(init.qualified.get('SYSTEM.WAIT')!), 'WAIT(${1:ms})');
    });

    test('кэш по пути + mtime: повторный разбор не выполняется', async () => {
        const cache = new NativesIndexCache();
        const a = await cache.get(gFile, 'g');
        const b = await cache.get(gFile, 'g');
        assert.strictEqual(a, b);
        assert.strictEqual(cache.parseCount, 1);
    });

    suite('разрешение символов', () => {
        const gScope: NativesScope = { g, aliases: new Set() };
        const initScope: NativesScope = { init, aliases: new Set(['natives']) };

        test('g: CREATE_PED -> функция из g.source.lua', () => {
            const r = resolveChain(gScope, ['CREATE_PED']);
            assert.strictEqual(r?.kind, 'function');
            assert.strictEqual(r.index.file, gFile);
        });

        test('init: PED.CREATE_PED и natives.PED.CREATE_PED -> init.source.lua', () => {
            for (const chain of [['PED', 'CREATE_PED'], ['natives', 'PED', 'CREATE_PED']]) {
                const r = resolveChain(initScope, chain);
                assert.strictEqual(r?.kind, 'function', chain.join('.'));
                assert.strictEqual(r.index.file, initFile);
            }
            assert.strictEqual(resolveChain(initScope, ['natives', 'PED'])?.kind, 'namespace');
            assert.strictEqual(resolveChain(initScope, ['CREATE_PED']), undefined);
            assert.strictEqual(resolveChain(initScope, ['other', 'PED', 'CREATE_PED']), undefined);
        });
    });
});

suite('Natives: текст под курсором', () => {
    test('completionContext', () => {
        assert.deepStrictEqual(completionContext('local p = PED.CRE'), { chain: ['PED'], partial: 'CRE' });
        assert.deepStrictEqual(completionContext('natives.PED.'), { chain: ['natives', 'PED'], partial: '' });
        assert.deepStrictEqual(completionContext('  CREATE_'), { chain: [], partial: 'CREATE_' });
        assert.strictEqual(completionContext('x = "PED.'), undefined);
        assert.strictEqual(completionContext('-- PED.'), undefined);
        assert.strictEqual(completionContext('obj:PED.'), undefined);
    });

    test('chainAt', () => {
        const line = 'local p = natives.PED.CREATE_PED(1)';
        const at = chainAt(line, line.indexOf('CREATE') + 2)!;
        assert.deepStrictEqual(at.segments, ['natives', 'PED', 'CREATE_PED']);
        assert.strictEqual(at.index, 2);
        assert.strictEqual(chainAt(line, line.indexOf('PED') + 1)!.index, 1);
    });

    test('callContext: номер аргумента, вложенные вызовы и строки', () => {
        assert.deepStrictEqual(callContext('PED.CREATE_PED(1, 2, ', 21), { segments: ['PED', 'CREATE_PED'], argument: 2 });
        const nested = 'CREATE_PED(4, GET_HASH("a,b"), {1, 2}, ';
        assert.deepStrictEqual(callContext(nested, nested.length), { segments: ['CREATE_PED'], argument: 3 });
        const inner = 'CREATE_PED(4, WAIT(';
        assert.deepStrictEqual(callContext(inner, inner.length), { segments: ['WAIT'], argument: 0 });
        const inString = 'CREATE_PED("a, ';
        assert.strictEqual(callContext(inString, inString.length), undefined);
        assert.strictEqual(callContext('f() -- CREATE_PED(', 18), undefined);
    });
});
