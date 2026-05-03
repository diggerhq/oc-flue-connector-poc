# OpenComputer connector for Flue

A sandbox connector that lets [Flue](https://github.com/withastro/flue) agents run inside [OpenComputer](https://opencomputer.dev) cloud sandboxes — secure, persistent VMs purpose-built for AI agents.

You create the sandbox with the OpenComputer SDK, then pass it to Flue. Flue handles the agent loop; OpenComputer handles isolation, persistence, and the filesystem.

> **Status:** proposal — intended to land in `withastro/flue` as `@flue/connectors/opencomputer`.

## Why OpenComputer

Flue's built-in virtual sandbox is fast and cheap, but agents that need to install packages, run long workloads, persist state across sessions, or expose preview URLs need a real VM. OpenComputer adds:

- **Persistent VMs** — agents can hibernate and wake on demand; no cold start tax per turn.
- **Checkpoints + patches** — fork a VM at any point, replay deterministic env builds.
- **Preview URLs** — expose any port over signed HTTPS for the agent's web output.
- **Secrets store** — encrypted env vars with egress allowlists.
- **Declarative images** — TypeScript-defined images that build to cached checkpoints.

## Install

```bash
npm install @flue/connectors @opencomputer/sdk
```

`@opencomputer/sdk` is a peer dependency, so you bring your own version.

## Configure

Set credentials via env vars (the OpenComputer SDK reads these by default):

| Variable                | Default                            |
| ----------------------- | ---------------------------------- |
| `OPENCOMPUTER_API_KEY`  | _(required)_                       |
| `OPENCOMPUTER_API_URL`  | `https://app.opencomputer.dev`     |

Or pass them explicitly to `Sandbox.create({ apiKey, apiUrl })`.

## Quickstart

```ts
// .flue/agents/research.ts
import { Sandbox } from '@opencomputer/sdk';
import { opencomputer } from '@flue/connectors/opencomputer';
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  // 1. Provision a sandbox with the OpenComputer SDK.
  const sandbox = await Sandbox.create({
    template: 'base',
    timeout: 300,        // auto-hibernate after 5 min idle (0 = persistent)
    envs: { NODE_ENV: 'production' },
  });

  // 2. Adapt it for Flue.
  const agent = await init({
    sandbox: opencomputer(sandbox, { cleanup: 'hibernate' }),
    model: 'anthropic/claude-sonnet-4-6',
  });

  const session = await agent.session();

  return await session.prompt(
    `Clone ${payload.repo}, run the test suite, and summarize what's failing.`,
    {
      result: v.object({
        passing: v.number(),
        failing: v.number(),
        summary: v.string(),
      }),
    },
  );
}
```

## API

### `opencomputer(sandbox, options?)`

Wraps an `@opencomputer/sdk` `Sandbox` into a Flue `SandboxFactory`.

#### `sandbox`

An already-initialized OpenComputer `Sandbox` instance. Use any `Sandbox.create(...)`, `Sandbox.connect(id, ...)`, or `Sandbox.createFromCheckpoint(id, ...)` factory.

#### `options.cwd`

Default working directory for commands inside the sandbox. Defaults to `/workspace` to match OpenComputer's template convention. Override if your template sets a different `workdir`.

#### `options.cleanup`

What to do with the sandbox when the Flue session is destroyed:

| Value            | Behavior                                                     |
| ---------------- | ------------------------------------------------------------ |
| `false` _(default)_ | No cleanup — caller manages the sandbox lifecycle.        |
| `true`           | Calls `sandbox.kill()`. Sandbox is destroyed.                |
| `'hibernate'`    | Calls `sandbox.hibernate()`. Sandbox can be `wake()`'d later. |
| `() => Promise<void>` | Custom cleanup hook.                                  |

`'hibernate'` is the recommended value for agents that may resume — OpenComputer hibernation preserves the full filesystem and memory state at near-zero cost while idle.

## Mapping: Flue `SandboxApi` → OpenComputer SDK

| Flue method           | OpenComputer call                              | Notes |
| --------------------- | ---------------------------------------------- | ----- |
| `readFile(p)`         | `sandbox.files.read(p)`                        | UTF-8 string. |
| `readFileBuffer(p)`   | `sandbox.files.readBytes(p)`                   | Returns `Uint8Array`. |
| `writeFile(p, c)`     | `sandbox.files.write(p, c)`                    | Accepts string or `Uint8Array`. |
| `stat(p)`             | `sandbox.exec.run('stat -c …')`                | OpenComputer has no native stat call; we shell out. |
| `readdir(p)`          | `sandbox.files.list(p)`                        | Returns names only. |
| `exists(p)`           | `sandbox.files.exists(p)`                      | |
| `mkdir(p, {recursive})` | `sandbox.files.makeDir(p)` / `mkdir -p`      | Recursive falls back to `mkdir -p` since the SDK call is single-level. |
| `rm(p, {recursive,force})` | `sandbox.files.remove(p)` / `rm -rf`      | Recursive/force flags fall back to `rm` since the SDK call removes one entry. |
| `exec(cmd, opts)`     | `sandbox.exec.run(cmd, opts)`                  | Direct passthrough — `cwd`, `env`, `timeout` all supported. |

## Patterns

### Recipe 1 — Disposable sandbox per request

Lowest-effort: provision on each request, kill on session end.

```ts
const sandbox = await Sandbox.create({ template: 'base', timeout: 60 });
const agent = await init({ sandbox: opencomputer(sandbox, { cleanup: true }) });
```

### Recipe 2 — Long-lived hibernated session

Persist state across user turns by hibernating between sessions.

```ts
const sandboxId = await sessionStore.get(payload.sessionId);
const sandbox = sandboxId
  ? await Sandbox.connect(sandboxId).then(async (s) => { await s.wake(); return s; })
  : await Sandbox.create({ template: 'base', timeout: 300 });

await sessionStore.set(payload.sessionId, sandbox.sandboxId);

const agent = await init({
  sandbox: opencomputer(sandbox, { cleanup: 'hibernate' }),
});
```

### Recipe 3 — Fork a checkpointed dev environment

Build the env once as a checkpoint, then fork a fresh sandbox per agent run. Each run starts in milliseconds with `node_modules`, the database seed, and the codebase already in place.

```ts
const sandbox = await Sandbox.createFromCheckpoint(process.env.DEV_ENV_CHECKPOINT_ID!, {
  timeout: 120,
});
const agent = await init({ sandbox: opencomputer(sandbox, { cleanup: true }) });
```

### Recipe 4 — Expose a preview URL the agent can show the user

```ts
const sandbox = await Sandbox.create({ template: 'base' });
const preview = await sandbox.createPreviewURL({ port: 3000 });

const agent = await init({ sandbox: opencomputer(sandbox, { cleanup: 'hibernate' }) });
const session = await agent.session();

await session.prompt(
  `Build a Vite app in /workspace and run it on port 3000.
   When it's serving, the user can visit: https://${preview.hostname}`,
);
```

## Caveats

- `stat()` shells out to `stat(1)` — minor latency on filesystems with thousands of stats per turn. If this matters, request a native stat endpoint upstream.
- `mkdir({ recursive: true })` and `rm({ recursive: true })` likewise shell out, since the SDK methods are single-level.
- `cwd` defaults to `/workspace`. If your template's `WORKDIR` is different (e.g. `/app`), pass `{ cwd: '/app' }` to the connector.

## Contributing

This connector is intended to live in `withastro/flue` under `packages/connectors/src/opencomputer.ts`. To propose it upstream, the diff is:

1. Add `src/opencomputer.ts` (this file's sibling).
2. Add an `./opencomputer` export to `packages/connectors/package.json`.
3. Add `@opencomputer/sdk` as an optional peer dependency.

## License

Apache-2.0 (matches `@flue/connectors`).
