const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * Recursively copy directory
 */
function copyDir(src, dest) {
	if (!fs.existsSync(dest)) {
		fs.mkdirSync(dest, { recursive: true });
	}

	const entries = fs.readdirSync(src, { withFileTypes: true });

	for (const entry of entries) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);

		if (entry.isDirectory()) {
			copyDir(srcPath, destPath);
		} else {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

/**
 * Copy KaTeX files to dist/web directory
 */
function copyKatex() {
	const srcDir = path.join(__dirname, 'node_modules', 'katex', 'dist');
	const destDir = path.join(__dirname, 'dist', 'web', 'katex');

	// Create destination directory
	if (!fs.existsSync(destDir)) {
		fs.mkdirSync(destDir, { recursive: true });
	}

	if (fs.existsSync(srcDir)) {
		copyDir(srcDir, destDir);
		console.log('[katex] Copied KaTeX dist bundle');
	} else {
		console.warn(`[katex] Warning: ${srcDir} not found`);
	}
}

async function main() {
	// Extension bundle (Node.js / VSCode)
	const extensionCtx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode', 'ws', 'http', 'https', 'net', 'path', 'fs', 'os', 'util'],
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	// Web client bundle (Browser / React)
	const webClientCtx = await esbuild.context({
		entryPoints: [
			'src/web/client/index.tsx'
		],
		bundle: true,
		format: 'esm',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/web/client.js',
		external: [],
		logLevel: 'silent',
		jsx: 'automatic',
		loader: {
			'.css': 'text',
		},
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	if (watch) {
		await Promise.all([extensionCtx.watch(), webClientCtx.watch()]);
	} else {
		await Promise.all([extensionCtx.rebuild(), webClientCtx.rebuild()]);
		await Promise.all([extensionCtx.dispose(), webClientCtx.dispose()]);
	}

	// Copy KaTeX after build
	copyKatex();
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
