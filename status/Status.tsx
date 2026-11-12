import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, FileText, GitCompare, RotateCcw } from 'lucide-react';
import { exec, openEditor, openFile, openView } from 'bigband/host';
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

const GIT_CONFLICT_CODES: Record<string, true> = {
  DD: true,
  AU: true,
  UD: true,
  UA: true,
  DU: true,
  AA: true,
  UU: true,
};

function parseGitStatus(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((raw) => {
      const code = raw.slice(0, 2);
      const rawPath = raw.slice(3);
      const rename = rawPath.match(/^(.*) -> (.*)$/);
      const status = ['??', 'A', 'D', 'R', 'M'].find(c => code.includes(c))?.[0] ?? code.trim()[0] ?? '?';
      const conflicted = GIT_CONFLICT_CODES[code] === true;
      return rename
        ? { status, conflicted, originalPath: rename[1], path: rename[2] }
        : { status, conflicted, path: rawPath };
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

function parseJjConflicts(stdout) {
  return new Set(
    stdout
      .split('\n')
      .map((raw) => raw.match(/^(.*?)\s+\d+-sided conflict(?:\s+.*)?$/))
      .filter((match) => match !== null)
      .map((match) => match[1]),
  );
}

function parseJjSummary(stdout, conflictStdout = '') {
  const conflicts = parseJjConflicts(conflictStdout);
  const entries = stdout
    .split('\n')
    .map((raw) => raw.match(/^([MADRC])\s+(.+)$/))
    .filter((match) => match !== null)
    .map((match) => {
      const parsedPath = parseJjPath(match[2]);
      return { status: match[1], ...parsedPath, conflicted: conflicts.has(parsedPath.path) };
    });
  const seen = new Set(entries.map((entry) => entry.path));
  for (const path of conflicts) {
    if (!seen.has(path)) entries.push({ status: 'M', path, conflicted: true });
  }
  return entries;
}

function parseStatus(vcs, stdout, conflictStdout = '') {
  return vcs === 'jj' ? parseJjSummary(stdout, conflictStdout) : parseGitStatus(stdout);
}

function parseDiffStat(stdout) {
  const summary = stdout.trim().split('\n').at(-1) ?? '';
  const additions = Number(summary.match(/(\d+) insertion(?:s)?\(\+\)/)?.[1] ?? 0);
  const deletions = Number(summary.match(/(\d+) deletion(?:s)?\(-\)/)?.[1] ?? 0);
  return { additions, deletions };
}

const STATUS_COLOR = {
  M: 'var(--bb-warning)',
  A: 'var(--bb-success)',
  D: 'var(--bb-danger)',
  R: 'var(--bb-accent)',
  C: 'var(--bb-accent)',
  '!': 'var(--bb-danger)',
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

function joinWorkspacePath(root, relativePath) {
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(relativePath)) return relativePath;
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${relativePath.replace(/^[/\\]+/, '')}`;
}

export default function Status() {
  const { workspace, instance, updateTitle } = usePanel();
  const workspaceId = workspace?.workspace_id ?? '';
  const workspaceRoot = workspace?.root ?? '';
  const instanceSlug = instance ?? '';
  const vcs = workspace?.repository?.backend;
  const supported = !!workspaceId
    && workspace?.capabilities.project === true
    && !!workspace.project
    && workspace?.capabilities.repository === true
    && !!workspace.repository
    && !!instanceSlug
    && (vcs === 'git' || vcs === 'jj');
  const [actionError, setActionError] = useState(null);

  const statusQ = useQuery({
    queryKey: ['workspace', workspaceId, 'status', vcs],
    queryFn: async () => {
      if (!supported) throw new Error('Status requires a genuine project workspace with a repository');

      const [statusResult, statResult, conflictsResult] = await Promise.all([
        exec(workspaceId, statusCommand(vcs)),
        exec(workspaceId, vcs === 'jj' ? ['jj', 'diff', '--stat'] : ['git', 'diff', 'HEAD', '--stat']),
        vcs === 'jj' ? exec(workspaceId, ['jj', 'resolve', '--list']) : null,
      ]);
      if (statusResult.exit !== 0) throw new Error(statusResult.stderr.trim() || `status exited ${statusResult.exit}`);
      if (statResult.exit !== 0) throw new Error(statResult.stderr.trim() || `diff stat exited ${statResult.exit}`);
      // `jj resolve --list` exits 2 when the revision has no conflicts.
      if (
        conflictsResult &&
        conflictsResult.exit !== 0 &&
        !(conflictsResult.exit === 2 && conflictsResult.stderr.trim().endsWith('No conflicts found at this revision'))
      ) {
        throw new Error(conflictsResult.stderr.trim() || `conflict list exited ${conflictsResult.exit}`);
      }
      return {
        entries: parseStatus(vcs, statusResult.stdout, conflictsResult?.stdout ?? ''),
        ...parseDiffStat(statResult.stdout),
      };
    },
    enabled: supported,
  });
  const { data: status = { entries: [], additions: 0, deletions: 0 }, isLoading, error, refetch } = statusQ;
  const { entries, additions, deletions } = status;

  useEffect(() => {
    if (!supported || isLoading || error) {
      updateTitle(null);
      return;
    }
    updateTitle(
      <>
        Status - <span style={{ color: 'var(--bb-success)' }}>+{additions}</span>{' '}
        <span style={{ color: 'var(--bb-danger)' }}>-{deletions}</span>
      </>,
    );
  }, [additions, deletions, error, isLoading, supported, updateTitle]);

  const openInEditor = async (entry) => {
    setActionError(null);
    try {
      await openEditor(entry.path, workspaceId);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useHostEvent<{ workspace_id?: string }>('workspace.changed', (event) => {
    if (event?.workspace_id !== workspaceId) return;
    void statusQ.refetch();
  }, { debounce: 750 });

  const open = async (entry, diff = false) => {
    setActionError(null);
    try {
      if (diff) {
        const { stdout, stderr, exit } = await exec(workspaceId, diffCommand(vcs, entry));
        if (exit !== 0 && !(vcs === 'git' && entry.status === '?' && exit === 1)) {
          throw new Error(stderr.trim() || `diff exited ${exit}`);
        }
        await openFile(workspaceId, entry.path, stdout);
      } else if (entry.status !== 'D') {
        await openFile(workspaceId, entry.path, undefined);
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const copyPath = async (entry, absolute) => {
    setActionError(null);
    try {
      const path = absolute ? joinWorkspacePath(workspaceRoot, entry.path) : entry.path;
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(path);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const discard = async (entry) => {
    setActionError(null);
    try {
      const { stderr, exit } = await exec(workspaceId, discardCommand(vcs, entry));
      if (exit !== 0) {
        setActionError(stderr.trim() || `discard exited ${exit}`);
        return;
      }
      await refetch();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (!workspace) {
    return <div style={styles.wrap}><div style={styles.empty}>(select a project workspace)</div></div>;
  }
  if (!supported) {
    return <div style={styles.wrap}><div style={styles.empty}>Status requires a genuine project workspace with a detected repository.</div></div>;
  }

  const n = entries.length;
  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <span style={styles.summary}>{isLoading ? 'loading…' : (n === 1 ? '1 change' : `${n} changes`)}</span>
        <Button variant="outline" size="sm" onClick={() => openView('status', 'diff', workspaceId, { vcs })}>open diff</Button>
      </div>
      {error && <div style={styles.err}>{error.message}</div>}
      {actionError && <div style={styles.err}>{actionError}</div>}
      {!error && !isLoading && n === 0 && <div style={styles.empty}>working tree clean</div>}
      {entries.map((e) => (
        <ContextMenu key={e.path}>
          <ContextMenuTrigger style={styles.row} title={e.conflicted ? `Conflicted: ${e.path}` : e.path}>
            <span
              aria-label={e.conflicted ? 'Conflicted file' : `Status ${e.status}`}
              style={{ ...styles.status, color: STATUS_COLOR[e.conflicted ? '!' : e.status] || 'var(--bb-muted)' }}
            >{e.conflicted ? '!' : e.status}</span>
            <button
              type="button"
              style={e.conflicted ? { ...styles.pathButton, color: STATUS_COLOR['!'] } : styles.pathButton}
              title={vcs === 'jj' && e.conflicted ? `Open conflict file ${e.path}; hold Cmd to open in editor` : `Open diff for ${e.path}; hold Cmd to open in editor`}
              aria-label={vcs === 'jj' && e.conflicted ? `Open conflicted file ${e.path}` : `Open diff for ${e.path}`}
              onClick={(event) => {
                if (event.metaKey) void openInEditor(e);
                else if (vcs === 'jj' && e.conflicted) void open(e);
                else void open(e, true);
              }}
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
            <ContextMenuItem disabled={vcs === 'jj' && e.conflicted} onClick={() => void open(e, true)}>
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
