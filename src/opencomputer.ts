/**
 * OpenComputer connector for Flue.
 *
 * Wraps an already-initialized OpenComputer sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the sandbox using the OpenComputer
 * SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { Sandbox } from '@opencomputer/sdk';
 * import { opencomputer } from '@flue/connectors/opencomputer';
 *
 * const sandbox = await Sandbox.create({ template: 'base' });
 * const agent = await init({ sandbox: opencomputer(sandbox) });
 * const session = await agent.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';
import type { Sandbox as OpenComputerSandbox } from '@opencomputer/sdk';

// ─── Options ────────────────────────────────────────────────────────────────

export interface OpenComputerConnectorOptions {
	/**
	 * Default working directory for commands inside the sandbox.
	 * Defaults to `/workspace`, which matches OpenComputer's template convention.
	 * Override if your template sets a different `workdir`.
	 */
	cwd?: string;

	/**
	 * Cleanup behavior when the session is destroyed.
	 *
	 * - `false` (default): No cleanup — user manages the sandbox lifecycle.
	 * - `true`: Calls `sandbox.kill()` on session destroy.
	 * - `"hibernate"`: Calls `sandbox.hibernate()` so the sandbox can be woken later.
	 * - Function: Calls the provided function on session destroy.
	 */
	cleanup?: boolean | 'hibernate' | (() => Promise<void>);
}

// ─── OpenComputerSandboxApi ─────────────────────────────────────────────────

/**
 * Implements SandboxApi by wrapping OpenComputer's TypeScript SDK.
 */
class OpenComputerSandboxApi implements SandboxApi {
	constructor(private sandbox: OpenComputerSandbox) {}

	async readFile(path: string): Promise<string> {
		return this.sandbox.files.read(path);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return this.sandbox.files.readBytes(path);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.sandbox.files.write(path, content);
	}

	async stat(path: string): Promise<FileStat> {
		// OpenComputer's filesystem API has no native stat — synthesize via `stat(1)`.
		// Format: <type>|<size>|<mtime-epoch>
		const result = await this.sandbox.exec.run(
			`stat -c '%F|%s|%Y' ${shellEscape(path)}`,
		);
		if (result.exitCode !== 0) {
			throw new Error(`stat failed for ${path}: ${result.stderr.trim()}`);
		}
		const [type, sizeStr, mtimeStr] = result.stdout.trim().split('|');
		const isDirectory = type === 'directory';
		const isSymbolicLink = type === 'symbolic link';
		return {
			isFile: !isDirectory && !isSymbolicLink,
			isDirectory,
			isSymbolicLink,
			size: Number(sizeStr) || 0,
			mtime: new Date(Number(mtimeStr) * 1000),
		};
	}

	async readdir(path: string): Promise<string[]> {
		const entries = await this.sandbox.files.list(path);
		return entries.map((e) => e.name);
	}

	async exists(path: string): Promise<boolean> {
		return this.sandbox.files.exists(path);
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		if (options?.recursive) {
			// `files.makeDir` is non-recursive — fall back to `mkdir -p`.
			const result = await this.sandbox.exec.run(`mkdir -p ${shellEscape(path)}`);
			if (result.exitCode !== 0) {
				throw new Error(`mkdir -p failed for ${path}: ${result.stderr.trim()}`);
			}
			return;
		}
		await this.sandbox.files.makeDir(path);
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		if (options?.recursive || options?.force) {
			const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
			const result = await this.sandbox.exec.run(`rm -${flags} ${shellEscape(path)}`);
			if (result.exitCode !== 0 && !options?.force) {
				throw new Error(`rm failed for ${path}: ${result.stderr.trim()}`);
			}
			return;
		}
		await this.sandbox.files.remove(path);
	}

	async exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return this.sandbox.exec.run(command, {
			cwd: options?.cwd,
			env: options?.env,
			timeout: options?.timeout,
		});
	}
}

// ─── Connector ──────────────────────────────────────────────────────────────

/**
 * Create a Flue sandbox factory from an initialized OpenComputer sandbox.
 *
 * The user creates the sandbox using the OpenComputer SDK directly, then
 * passes it here. Flue wraps it into a SessionEnv for agent use.
 *
 * @param sandbox - An initialized OpenComputer Sandbox instance.
 * @param options - Connector options (cwd, cleanup behavior).
 */
export function opencomputer(
	sandbox: OpenComputerSandbox,
	options?: OpenComputerConnectorOptions,
): SandboxFactory {
	return {
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			const sandboxCwd = cwd ?? options?.cwd ?? '/workspace';
			const api = new OpenComputerSandboxApi(sandbox);

			let cleanupFn: (() => Promise<void>) | undefined;
			if (options?.cleanup === true) {
				cleanupFn = async () => {
					try {
						await sandbox.kill();
					} catch (err) {
						console.error('[flue:opencomputer] Failed to kill sandbox:', err);
					}
				};
			} else if (options?.cleanup === 'hibernate') {
				cleanupFn = async () => {
					try {
						await sandbox.hibernate();
					} catch (err) {
						console.error('[flue:opencomputer] Failed to hibernate sandbox:', err);
					}
				};
			} else if (typeof options?.cleanup === 'function') {
				cleanupFn = options.cleanup;
			}

			return createSandboxSessionEnv(api, sandboxCwd, cleanupFn);
		},
	};
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function shellEscape(arg: string): string {
	return `'${arg.replace(/'/g, "'\\''")}'`;
}
