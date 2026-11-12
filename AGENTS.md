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
runtime_api = 2          # required by the workspace-aware runtime
requirements = []        # directory-safe; alternatively repository/project/managed_instance

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

A manifest without `runtime_api = 2` is rejected as upgrade-required. An
omitted `requirements` array keeps the legacy project-only scope; `[]` opts
into directory-safe folder/scratch contexts, while `repository`, `project`, and
`managed_instance` gate panels and workers before mounting. Requirements are
eligibility, not a sandbox. The maintained `status` and `ci` plugins are
deliberately project-scoped to preserve their existing instance/repository-keyed
data; they do not claim folder or scratch support.

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
  `exec(workspaceId, argv)`, `execStream(workspaceId, argv)`,
  `openFile(workspaceId, path)`, `openEditor(path, workspaceId?)`,
  `openView(plugin, view, workspaceId, args?, placement?)`,
  `workspaces()`, and `updateTitle(title?)`. Workspace IDs are opaque; never
  derive a root from one.
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
keeps that generated directory uncommitted. Keep a SurrealDB-3-compatible
`surrealkit` on `PATH`; `1.0.0-beta.7` is verified against Bigband's embedded
SurrealDB 3.2.4. SurrealKit `1.0.0-rc.1` requires SurrealDB 4 and cannot generate
types from this runtime.

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

### Workspace lifecycle and data scope

The maintained host does not dispatch a legacy `instance.removed` lifecycle
event, so do not build comment/record cleanup on it. Closing a workspace is
non-destructive: `workspace.closed` stops workspace-scoped subscriptions but
plugin data must remain. `workspace.discarded` is separate and follows a
confirmed scratch deletion. Core owns process and watcher teardown; plugin
callbacks are not responsible for making closure safe.

`selection.workspace` and `viewContext().workspace` contain the authoritative
descriptor: opaque `workspace_id`, immutable `root`, optional real `project`
and `repository`, capabilities, availability, and terminal identity. Use
`exec(workspace.workspace_id, argv)` for fixed-root execution; shell `cd` does
not retarget it. `selection.vcs` is nullable. A folder inside a repository keeps
its selected subdirectory as `root`, while `repository.root` identifies the
enclosing repository.

Key new workspace-scoped records and query caches by `workspace_id`, never by a
basename, path, terminal title, or invented `<project>/<instance>`. Existing
project-slug records require an explicit versioned migration; without one,
retain them as deliberately project-only. Renaming an event or storage field is
not a migration. The maintained `status` plugin keeps `diff_comment.instance`
keyed by the genuine project slug for exactly this reason. Other installed
plugins are external code; this repository does not migrate or rewrite them.

Dynamic views can still pass the view's stable id as an optional registration
target:

```ts
const view = viewContext();
registerRPC('refresh', refresh, view.id);
```

This build acknowledges targeted registrations but does not implement general
targeted dynamic-view RPC routing, so do not treat them as a delivery
guarantee. Registering the same untargeted method from multiple live surfaces
still has last-registration-wins semantics.

Invoke from a shell:

```sh
bigband rpc list myplugin
bigband rpc exec myplugin.add --workspace '<workspace-id>' '{"title":"hi"}'
bigband rpc exec myplugin.add --instance my-repo/main '{"title":"hi"}'
```

Or over the IPC socket:

```sh
echo '{"method":"plugin.rpc.exec","params":{"plugin":"myplugin","method":"add","payload":{"title":"hi"}}}' \
  | nc -U ~/.bigband/ipc.sock
```

Panels share one WebView per well, so untargeted RPC registration remains
workspace-independent. Pass `--workspace` (or `workspace_id` through
`bigband control plugin.rpc.exec`) when a handler needs an explicit target and
read `payload.workspace_id`. Genuine project workflows may pass `--instance` and
read `payload.instance`; standalone folder/scratch workspaces never invent a
project slug. A stale or closed explicit target must fail rather than fall back
to the current selection.

## 6. Reacting to workspace selection and changes

- `selection` is a signal containing the complete current selection payload;
  `usePanel()` returns its value and re-runs the component when it changes.
- Include `workspace.workspace_id` in TanStack query keys for workspace-scoped
  data, e.g. `['workspace', workspace.workspace_id, '<resource>', ...]`.
  Subscribe with `useHostEvent('workspace.changed', callback)` and compare the
  payload's `workspace_id` before invalidating. Ignore rules remain authoritative.
- `selection.changed` carries the descriptor snapshot plus truthful optional
  project fields. `agent.status.changed` includes `workspace_id`; project and
  instance names are present only for real project associations. Bootstrap from
  the descriptor snapshot, not a cached last filesystem event.

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
