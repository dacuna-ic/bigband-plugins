import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, FileText, GitCompare, RotateCcw } from 'lucide-react';
import { control, exec, openEditor, openFile, openView } from 'bigband/host';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from 'bigband/ui';
import { useHostEvent, usePanel } from 'bigband/panel';

function statusCommand(vcs) {
  return vcs === 'jj'
    ? ['jj', 'diff', '--summary']
    : ['git', 'status', '--porcelain'];
}

function diffCommand(vcs, entry) {
  if (vcs === 'jj') {
    return ['jj', 'diff', '--git', '--color=never', '--', entry.path];
  }
  const options = ['--src-prefix=a/', '--dst-prefix=b/'];
  return entry.status === '?'
    ? ['git', 'diff', '--no-index', ...options, '--', '/dev/null', entry.path]
    : ['git', 'diff', 'HEAD', '--no-ext-diff', ...options, '--', entry.path];
}

function discardCommand(vcs, entry) {
  const paths = entry.originalPath ? [entry.originalPath, entry.path] : [entry.path];
  if (vcs === 'jj') return ['jj', 'restore', '--', ...paths];
  if (entry.status === '?') return ['git', 'clean', '-fd', '--', entry.path];
  if (entry.status === 'A') return ['git', 'rm', '-f', '--', entry.path];
  return ['git', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths];
}

function parseGitStatus(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((raw) => {
      const code = raw.slice(0, 2);
      const rawPath = raw.slice(3);
      const rename = rawPath.match(/^(.*) -> (.*)$/);
      const status = ['??', 'A', 'D', 'R', 'M'].find(c => code.includes(c))?.[0] ?? code.trim()[0] ?? '?';
      return rename
        ? { status, originalPath: rename[1], path: rename[2] }
        : { status, path: rawPath };
    });
}

const JJ_RENAME_RE = /^(.*)\{([^{}]*) => ([^{}]*)\}(.*)$/;
function parseJjPath(path) {
  const match = path.match(JJ_RENAME_RE);
  if (!match) return { path };
  return {
    originalPath: `${match[1]}${match[2]}${match[4]}`,
    path: `${match[1]}${match[3]}${match[4]}`,
  };
}

function parseJjSummary(stdout) {
  return stdout
    .split('\n')
    .map((raw) => raw.match(/^([MADRC])\s+(.+)$/))
    .filter((m) => m !== null)
    .map((m) => ({ status: m[1], ...parseJjPath(m[2]) }));
}

function parseStatus(vcs, stdout) {
  return vcs === 'jj' ? parseJjSummary(stdout) : parseGitStatus(stdout);
}

const STATUS_COLOR = {
  M: 'var(--bb-warning)',
  A: 'var(--bb-success)',
  D: 'var(--bb-danger)',
  R: 'var(--bb-accent)',
  C: 'var(--bb-accent)',
  '?': 'var(--bb-muted)',
};

const styles: Record<string, CSSProperties> = {
  wrap: {
    padding: '8px 10px', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif',
    color: 'var(--bb-foreground)', background: 'var(--bb-background)',
    fontSize: 'clamp(9px, calc(var(--bb-ui-font-size, 15px) * 0.73), 18px)'
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' },
  summary: { color: 'var(--bb-muted)' },
  row: {
    display: 'grid', gridTemplateColumns: '12px minmax(0, 1fr)', columnGap: '6px',
    alignItems: 'center', minWidth: 0, position: 'relative', fontFamily: 'ui-monospace,monospace',
    borderRadius: '3px', padding: '0 2px'
  },
  status: { width: '12px', textAlign: 'center' },
  pathButton: {
    minWidth: 0, width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    padding: 0, border: 'none', background: 'transparent', color: 'var(--bb-foreground)',
    textAlign: 'left', font: 'inherit', cursor: 'pointer'
  },
  err: { color: 'var(--bb-danger)', fontSize: '0.9em' },
  empty: { color: 'var(--bb-muted)', fontStyle: 'italic' },
};

function joinInstancePath(root, relativePath) {
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(relativePath)) return relativePath;
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${relativePath.replace(/^[/\\]+/, '')}`;
}

async function findInstancePath(instance) {
  const response = await control('project.list');
  for (const project of response?.projects ?? []) {
    const match = project.instances?.find((candidate) => `${project.name}/${candidate.name}` === instance);
    if (match?.path) return match.path;
  }
  throw new Error(`could not resolve instance path for ${instance}`);
}

export default function Status() {
  const { instance, vcs } = usePanel();
  const [actionError, setActionError] = useState(null);

  const statusQ = useQuery({
    queryKey: ['instance', instance, 'status', vcs],
    queryFn: async () => {
      const { stdout, stderr, exit } = await exec(instance, statusCommand(vcs));
      if (exit !== 0) throw new Error(stderr.trim() || `status exited ${exit}`);
      return parseStatus(vcs, stdout);
    },
    enabled: !!instance,
  });
  const { data: entries = [], isLoading, error, refetch } = statusQ;

  const openInEditor = async (entry) => {
    setActionError(null);
    try {
      await openEditor(entry.path);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useHostEvent('instance.changed', () => {
    void statusQ.refetch();
  }, { debounce: 750 });

  const open = async (entry, diff = false) => {
    setActionError(null);
    try {
      if (diff) {
        const { stdout, stderr, exit } = await exec(instance, diffCommand(vcs, entry));
        if (exit !== 0 && !(vcs === 'git' && entry.status === '?' && exit === 1)) {
          throw new Error(stderr.trim() || `diff exited ${exit}`);
        }
        await openFile(instance, entry.path, stdout);
      } else if (entry.status !== 'D') {
        await openFile(instance, entry.path, undefined);
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const copyPath = async (entry, absolute) => {
    setActionError(null);
    try {
      const path = absolute
        ? joinInstancePath(await findInstancePath(instance), entry.path)
        : entry.path;
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(path);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const discard = async (entry) => {
    setActionError(null);
    try {
      const { stderr, exit } = await exec(instance, discardCommand(vcs, entry));
      if (exit !== 0) {
        setActionError(stderr.trim() || `discard exited ${exit}`);
        return;
      }
      await refetch();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  if (!instance) {
    return <div style={styles.wrap}><div style={styles.empty}>(no instance selected)</div></div>;
  }

  const n = entries.length;
  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <span style={styles.summary}>{isLoading ? 'loading…' : (n === 1 ? '1 change' : `${n} changes`)}</span>
        <Button variant="outline" size="sm" onClick={() => openView('status', 'diff', instance, { vcs })}>open diff</Button>
      </div>
      {error && <div style={styles.err}>{error.message}</div>}
      {actionError && <div style={styles.err}>{actionError}</div>}
      {!error && !isLoading && n === 0 && <div style={styles.empty}>working tree clean</div>}
      {entries.map((e) => (
        <ContextMenu key={e.path}>
          <ContextMenuTrigger style={styles.row} title={e.path}>
            <span style={{ ...styles.status, color: STATUS_COLOR[e.status] || 'var(--bb-muted)' }}>{e.status}</span>
            <button
              type="button"
              style={styles.pathButton}
              title={`Open diff for ${e.path}; hold Cmd to open in editor`}
              aria-label={`Open diff for ${e.path}`}
              onClick={(event) => void (event.metaKey ? openInEditor(e) : open(e, true))}
            >{e.path}</button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => void copyPath(e, false)}>
              <Copy size={14} />
              Copy relative path
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void copyPath(e, true)}>
              <Copy size={14} />
              Copy path
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => void open(e, true)}>
              <GitCompare size={14} />
              View diff
            </ContextMenuItem>
            <ContextMenuItem disabled={e.status === 'D'} onClick={() => void open(e)}>
              <FileText size={14} />
              View
            </ContextMenuItem>
            <ContextMenuItem disabled={e.status === 'D'} onClick={() => void openInEditor(e)}>
              <ExternalLink size={14} />
              Open in editor
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={() => void discard(e)}>
              <RotateCcw size={14} />
              Discard
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}
