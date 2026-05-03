/**
 * Smoke test for the OpenComputer × Flue connector.
 *
 * Provisions a real OpenComputer sandbox, wraps it with the connector, and
 * exercises every SandboxApi method through Flue's SessionEnv. Kills the
 * sandbox on success or failure.
 *
 * Run:
 *   OPENCOMPUTER_API_KEY=... npm run smoke
 */
import { Sandbox } from '@opencomputer/sdk';
import { opencomputer } from '../src/opencomputer.js';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
	const t0 = Date.now();
	try {
		await fn();
		const ms = Date.now() - t0;
		console.log(`${PASS} ${name} ${DIM}(${ms}ms)${RESET}`);
		passed++;
	} catch (err) {
		const ms = Date.now() - t0;
		console.log(`${FAIL} ${name} ${DIM}(${ms}ms)${RESET}`);
		console.log(`  ${(err as Error).message}`);
		failed++;
	}
}

function eq<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

async function main() {
	if (!process.env.OPENCOMPUTER_API_KEY) {
		console.error('OPENCOMPUTER_API_KEY is not set');
		process.exit(1);
	}

	console.log('→ Creating sandbox (template: base)...');
	const sandbox = await Sandbox.create({
		template: 'base',
		timeout: 120, // auto-hibernate after 2 min if we crash
	});
	console.log(`  sandboxId=${sandbox.sandboxId}`);

	try {
		// Wrap with the connector. cwd defaults to /tmp because we're not relying on a
		// template-defined workdir for this smoke test.
		const factory = opencomputer(sandbox, { cwd: '/tmp' });
		const env = await factory.createSessionEnv({ id: 'smoke', cwd: '/tmp' });

		const dir = `/tmp/flue-smoke-${Date.now()}`;
		const file = `${dir}/hello.txt`;
		const nested = `${dir}/a/b/c`;
		const nestedFile = `${nested}/deep.txt`;

		await check('mkdir (recursive) creates nested path', async () => {
			await env.mkdir(nested, { recursive: true });
			eq(await env.exists(nested), true, 'nested exists');
		});

		await check('writeFile + readFile round-trip', async () => {
			await env.writeFile(file, 'hello, opencomputer');
			const content = await env.readFile(file);
			eq(content, 'hello, opencomputer', 'readFile content');
		});

		await check('writeFile (binary) + readFileBuffer', async () => {
			const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
			await env.writeFile(`${dir}/bin.dat`, bytes);
			const back = await env.readFileBuffer(`${dir}/bin.dat`);
			eq(back.length, 4, 'byte length');
			eq(back[0], 0xde, 'byte[0]');
			eq(back[3], 0xef, 'byte[3]');
		});

		await check('exists returns true for file, false for missing', async () => {
			eq(await env.exists(file), true, 'file exists');
			eq(await env.exists(`${dir}/missing.txt`), false, 'missing file');
		});

		await check('stat returns isFile for files', async () => {
			const s = await env.stat(file);
			eq(s.isFile, true, 'isFile');
			eq(s.isDirectory, false, 'isDirectory');
			if (s.size <= 0) throw new Error(`stat.size expected > 0, got ${s.size}`);
			if (!(s.mtime instanceof Date)) throw new Error('stat.mtime not a Date');
		});

		await check('stat returns isDirectory for directories', async () => {
			const s = await env.stat(dir);
			eq(s.isDirectory, true, 'isDirectory');
			eq(s.isFile, false, 'isFile');
		});

		await check('readdir lists entries', async () => {
			const entries = await env.readdir(dir);
			if (!entries.includes('hello.txt')) {
				throw new Error(`expected hello.txt in entries, got ${JSON.stringify(entries)}`);
			}
		});

		await check('exec runs command and captures stdout', async () => {
			const r = await env.exec('echo hello-from-exec');
			eq(r.exitCode, 0, 'exitCode');
			if (!r.stdout.includes('hello-from-exec')) {
				throw new Error(`expected 'hello-from-exec' in stdout, got ${JSON.stringify(r.stdout)}`);
			}
		});

		await check('exec respects cwd', async () => {
			const r = await env.exec('pwd', { cwd: dir });
			eq(r.exitCode, 0, 'exitCode');
			if (!r.stdout.includes(dir)) {
				throw new Error(`expected cwd ${dir} in pwd output, got ${JSON.stringify(r.stdout)}`);
			}
		});

		await check('exec respects env vars', async () => {
			const r = await env.exec('echo "$FLUE_SMOKE_VAR"', { env: { FLUE_SMOKE_VAR: 'opencomputer' } });
			eq(r.exitCode, 0, 'exitCode');
			if (!r.stdout.includes('opencomputer')) {
				throw new Error(`expected env var to propagate, got ${JSON.stringify(r.stdout)}`);
			}
		});

		await check('exec returns non-zero exit on failure', async () => {
			const r = await env.exec('exit 7');
			// OpenComputer's /exec/run endpoint sometimes omits exitCode on non-zero
			// exits; the connector coerces undefined → -1. Either way, must be non-zero.
			if (r.exitCode === 0) {
				throw new Error(`expected non-zero exit, got 0 (stdout=${JSON.stringify(r.stdout)})`);
			}
		});

		await check('writeFile creates parent dir if missing', async () => {
			await env.writeFile(nestedFile, 'deep content');
			eq(await env.readFile(nestedFile), 'deep content', 'deep file content');
		});

		await check('rm (recursive) removes directory tree', async () => {
			await env.rm(dir, { recursive: true, force: true });
			eq(await env.exists(dir), false, 'dir removed');
		});

		console.log('');
		console.log(`${passed} passed, ${failed} failed`);
	} finally {
		console.log('→ Killing sandbox...');
		try {
			await sandbox.kill();
			console.log('  done');
		} catch (err) {
			console.error('  failed to kill sandbox:', (err as Error).message);
		}
	}

	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
