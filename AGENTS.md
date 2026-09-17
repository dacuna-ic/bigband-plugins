# Writing a plugin

A plugin is a directory under `~/.bigband/plugins/<id>/` that contributes panels,
background work, or both, and can expose RPC methods callable from the IPC socket
or `bigband rpc`. Global config assigns panel plugins to UI **wells** (WebView
containers); worker plugins mount automatically.

## 0. Set up your workspace

bigband discovers plugins from `~/.bigband/plugins/`. Install maintained plugins
from the canonical `dacuna-ic/bigband-plugins` repository without cloning it:

```sh
bigband plugins install status
```

Reinstalling prompts before replacing the existing plugin directory; pass
`--force` for a non-interactive replacement.

**Quick start:**

```sh
bigband plugins init
bigband plugins scaffold my-plugin
```

`init` creates or refreshes the shared files under `~/.bigband/plugins/`:
`package.json`, `tsconfig.json`, `surrealkit.toml`, `.gitignore`, `AGENTS.md`,
the `scripts/typegen.mjs` helper, and the generated `types/` declaration tree
(`types/*.d.ts` and `types/ui/*.d.ts`). Run it again after an update; it
overwrites only those generated/shared files. It never touches plugin
subdirectories.

`scaffold <id>` creates one plugin subdirectory. It refuses to overwrite an
existing plugin directory, so source edits remain safe.

```sh
cd ~/.bigband/plugins
npm install                  # optional — one install for every plugin in the root
# edit my-plugin/MyPlugin.tsx
# restart bigband once to register the new plugin (edits after that hot-reload)
```

**No build step required to run.** `.tsx` is transpiled at load time by
`deno_ast`; shared runtime dependencies are pulled from esm.sh through the
well's import map, while plugin-specific dependencies can use pinned esm.sh URLs
directly. `npm install` exists purely so your editor can resolve types.

The maintained `status` plugin is the full panel, view, worker, RPC, and live DB
example.

## 1. Scaffold

```
~/.bigband/plugins/<id>/
├── plugin.toml
└── <Entry>.tsx    # .js/.ts/.jsx/.tsx — transpiled on the fly, no build step
```

`plugin.toml`:

```toml
id = "myplugin"          # unique; matches the directory name
name = "My Plugin"       # display name

# Optional background module. It runs for module-level side effects and does
# not need a panel or a [wells] assignment.
worker = "Worker.ts"
[[panels]]
id = "main"              # unique within the plugin
entry = "MyPlugin.tsx"   # path relative to the plugin root
title = "My Plugin"      # optional; rendered as panel chrome header

# Optional — documentation only. `plugin.rpc.exec` calls whatever the JS
# side actually registered via `registerRPC`, regardless of what's here.
[[rpc]]
name = "do-thing"
description = "payload: {arg}"
```

Panels do not choose their own well. Enable and order panel plugins in
`~/.bigband/config.toml`:

```toml
[wells]
right = ["myplugin"] # also: left, top, bottom
```

Discovered panel plugins omitted from `[wells]` do not mount. A plugin with a
`worker` mounts automatically in the first standard well already used by a
panel (`left`, `right`, `top`, then `bottom`). If no panel well is used, it
mounts invisibly in `left`, the first defined well. Its entry module is loaded
but no component, panel title, or layout space is rendered; use module-level
code for subscriptions, RPC registration, and other background work.

Every entry configured for the same well shares one WebView / one V8 isolate —
so module-scope work (DB schema, `registerRPC`, event subscriptions) happens
once, not per instance.

## 2. Write the entry module

Panels render with React + JSX. Default-export the component. Each panel entry is
lazy-loaded inside its own `ErrorBoundary`, so top-level `await` (schema setup,
initial fetch, or a migration) runs before that panel renders without blocking
the rest of the well. A rejected module import and a render error both stay
isolated to that entry; the fallback includes the error details and a copy
button.
JSX is transpiled with React's automatic JSX runtime, so no React factory import is required.

```tsx
import { registerRPC } from 'bigband/host';

registerRPC('do-thing', ({ arg } = {}) => ({ ok: true, arg }));

export default function MyPlugin() {
  return <div>hello</div>;
}
```

Worker entries are loaded through the same isolated path but remain invisible;
use module-level code for subscriptions, RPC registration, and other background
work.

## 3. What you can import

Served by the wry custom protocol handler in `crates/bigband-core/src/plugin_well.rs`.
Runtime modules are authored in TypeScript and transpiled on request. Run
`npm run runtime-types` and `npm run runtime-css` from `webview` after changing
the shared runtime. `runtime-types` is also required before direct Rust builds;
the canonical `mise install` task and CI run it automatically.

`webview/components.json` is the shadcn project configuration. It selects the
official `base-nova` style and points the generator's `ui`/`utils` aliases at
`webview/runtime/ui` and `webview/runtime/utils`. Add future components from
the `webview` directory with the shadcn CLI, export them from
`webview/runtime/ui.ts`, then regenerate the declarations and CSS. The runtime
serves the whole directory automatically; no per-component Rust registration is
needed. A source checkout should rebuild bigband before running `bigband
plugins init`, because the generated declarations are embedded in the binary.

```sh
cd webview
npm exec -- shadcn add context-menu --yes
# export the component from runtime/ui.ts
npm run runtime-types
npm run runtime-css
```

- **`bigband/ui`** — official shadcn/ui `base-nova` components exposed through
  one barrel: `Button`, `Badge`, `Input`, `Textarea`, `Label`, `Card` and its
  subcomponents, `Separator`, `Alert`, `Skeleton`, and `ContextMenu` and its
  subcomponents. These are the actual shadcn registry sources, backed by the
  browser's React runtime.
- **`bigband/utils`** — shared plugin helpers: `cn` for composing class names and
  `toast(message, options?)` for displaying a native Bigband toast.
- **`bigband/host`** — `registerRPC(name, handler)`, `on(event, cb)`,
  `exec(instance, argv)`, `openFile(instance, path)`, `instances()`.
- **`bigband/db`** — an already-connected SurrealDB handle,
  `surrealDBAddress`, `surrealDBConnection`, and
  `useCollection(table, sql, opts?)`. The connection object includes
  ephemeral, database-scoped credentials for advanced integrations such as
  Surrealist.
- **`bigband/theme`** — reactive typed theme snapshot. Read chrome tokens such
  as `theme.accent` or `theme.background`, and code-surface domains through
  `theme.editor`, `theme.syntax`, and `theme.diff`; values are resolved color
  strings. `theme.background` remains the sidebar/panel background, while
  `theme.main_background` is the main editor background.
- Standard scalar theme tokens are exposed as CSS variables; nested roles are
  projected to scalar variables such as `--bb-editor-background`,
  `--bb-syntax-keyword`, and `--bb-diff-added-background`. The shadcn theme
  maps chrome variables to official names (`bg-background`, `text-foreground`,
  `border-border`, `bg-primary`, and so on). Prefer component variants over
  hardcoded light/dark colors.
- `react`, `react-dom`, `@preact/signals-react`, `@tanstack/react-query`,
  `@base-ui/react`, `class-variance-authority`, `cn`, `lucide-react`,
  `tw-animate-css`, `goober`, `surrealdb` — pinned in `package.json` and
  mapped in `webview/runtime/well.html`.

```tsx
import { Button, Card, CardContent, CardHeader, CardTitle } from 'bigband/ui';

export default function Panel() {
  return <Card>
    <CardHeader><CardTitle>Review</CardTitle></CardHeader>
    <CardContent><Button variant="outline">open</Button></CardContent>
  </Card>;
}
```

## 4. Persistence (`bigband/db`)

Use `migrate` for every plugin-owned schema change. Each version is recorded in
the shared `_bigband_migrations` table and run inside a transaction, so two
WebViews racing during a hot reload cannot apply the same migration at once.
Failed transactions leave no migration marker and can be retried on the next
load.

Keep migration versions immutable: do not edit a query after shipping it; add
the next version for a later change. Migration queries contain statements only
and must not include their own `BEGIN`/`COMMIT` block.

With bigband running and the plugin's migrations applied, generate TypeScript
interfaces from the live schema:

```sh
cd ~/.bigband/plugins
npm run typegen
```

The task gets the app's ephemeral database credentials from `bigband surrealdb
address` and invokes `surrealkit typegen` with database-level authentication.
`surrealkit.toml` writes `types/generated/index.ts`; the shared `.gitignore`
keeps that generated directory uncommitted. Install `surrealkit` separately and
keep it on `PATH`.

```tsx
import { Table } from 'surrealdb';
import { migrate, useCollection } from 'bigband/db';
import type { Note } from '../types/generated';

const NOTE = new Table('note');

await migrate('notes', [
  {
    version: 1,
    query: `
      DEFINE TABLE OVERWRITE note SCHEMAFULL;
      DEFINE FIELD OVERWRITE body ON note TYPE string;
      DEFINE FIELD OVERWRITE created_at ON note TYPE option<datetime>;
    `,
  },
  // Future schema changes are appended as version: 2, version: 3, ...
]);

const LIST = 'SELECT * FROM note ORDER BY created_at DESC';

export default function Notes() {
  const { rows, error } = useCollection<Note>(NOTE, LIST);
  if (error) return <div>{error}</div>;
  if (!rows) return null;              // null until first read lands
  return <ul>{rows.map((n) => <li key={String(n.id)}>{n.body}</li>)}</ul>;
}
```

The live subscription is a change **signal**, not the data — a
notification re-runs the query so `ORDER BY`/`WHERE`/`LIMIT` stay
authoritative. Fine for embedded, panel-sized tables; wrong for a hot
table with thousands of rows.

Define each `Table` at module scope so its identity is stable across
renders.
## 5. RPC (calls from outside)

Register JS handlers at module load. `registerRPC('name', ...)` on the
`myplugin`-scoped `bigband/host` binds the address to `myplugin.name`.

```ts
registerRPC('add', async ({ title } = {}) => {
  if (!title) throw new Error("myplugin.add: missing 'title'");
  // ... do the thing; return anything JSON-serializable, or throw.
});
```

### Instance removal lifecycle

Subscribe from a worker or panel with the typed `onLifecycleEvent` API:

```ts
import { onLifecycleEvent } from 'bigband/host';

onLifecycleEvent('instance.removed', async ({ instance }) => {
  await db.query('DELETE plugin_record WHERE instance = $instance', { instance });
});
```

`instance` is the project-qualified `"<project>/<instance>"` identity. The host
emits this event after the working copy and every associated terminal daemon
are gone. It awaits all subscribers with a timeout. Failures are logged with
the owning plugin id but cannot restore an already-removed working copy or
prevent other subscribers from running. Prefer a `worker` subscription when
cleanup must be available regardless of which panels the user enables.

Dynamic views can expose one independently addressable handler per opening.
Use the view's stable id as the optional registration target:

```ts
const view = viewContext();
registerRPC('refresh', refresh, view.id);
```

`plugin.rpc.list` includes the currently live `targets` for each method.
Select one with `--target` (or `params.target` over IPC):

```sh
bigband rpc exec myplugin.refresh --target <view-id> '{"mode":"compact"}'
```

Invoke from a shell:

```sh
bigband rpc list myplugin
bigband rpc exec myplugin.add --instance my-repo/main '{"title":"hi"}'
```

Or over the IPC socket:

```sh
echo '{"method":"plugin.rpc.exec","params":{"plugin":"myplugin","method":"add","payload":{"title":"hi"}}}' \
  | nc -U ~/.bigband/ipc.sock
```

Panels share one WebView per well, so untargeted RPC registration remains
instance-independent. If a handler's *behavior* needs the caller's instance,
pass `--instance` and read `payload.instance` off the payload — see the installed
`~/.bigband/plugins/todos` plugin for a worked example. Targeted registrations are for
dynamic views: each live view owns its handler and disappears from
`plugin.rpc.list` when its tab closes.

## 6. Reacting to selection / instance changes

- `selection` is a signal containing the complete current selection payload;
  `usePanel()` returns its value and re-runs the component when it changes.
- Include `instance` in TanStack query keys when a panel's data is
  instance-scoped, e.g. `['instance', instance, '<resource>', ...]`, so
  switching instances runs the right fetch. Nothing refetches automatically
  when the worktree mutates — subscribe with `useHostEvent('instance.changed',
  …)` and invalidate or refetch only the queries that should react (gitignored
  paths are filtered before the event fires; see
  `crates/bigband-core/src/instance_watcher.rs`).

## 7. Hot reload

`crates/bigband-core/src/plugin_watcher.rs` watches both plugin roots (bundled +
`~/.bigband/plugins/`) recursively and re-mounts the well whose files
changed — edit the panel and the WebView reloads, no restart.

Caveat: the plugin *set* (which `plugin.toml`s are loaded) is built once
at startup. Adding a brand-new plugin, or renaming its id, needs a full
bigband restart; editing the JS/TSX behind an existing panel is the
hot-reload common case.

## 8. Debugging

- Runtime errors surface in the WebView devtools (right-click the panel
  → *Inspect Element* if enabled by your platform build).
- Registration errors: check the app's stderr on launch — invalid
  `plugin.toml` entries are logged and skipped.
- If a panel silently disappears, it likely returned `null` on empty and
  the well applied `.bb-panel-empty` (see `well.html`).

## 9. TypeScript

`webview/tsconfig.json` covers every plugin. Run:

```sh
cd webview && npm run typecheck
```
