import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// Тестовый воркспейс с util.require_natives(...) в обоих режимах и папкой lib/natives-9999z
	workspaceFolder: './test-fixtures/workspace',
	launchArgs: ['--disable-extensions'],
	mocha: {
		ui: 'tdd',
		timeout: 60000,
	},
});
