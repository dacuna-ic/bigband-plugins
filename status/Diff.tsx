// esm.sh's unbundled entry drops Pierre's side-effect-only element registration.
import 'https://esm.sh/@pierre/diffs@1.4.2/dist/components/web-components.js?external=react,react-dom&bundle=false';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  CodeViewItem,
  DiffLineAnnotation,
  parsePatchFiles as ParsePatchFiles,
  registerCustomTheme as RegisterCustomTheme,
} from '@pierre/diffs';
import type { CodeView as CodeViewComponent, CodeViewHandle } from '@pierre/diffs/react';
// @ts-expect-error TypeScript does not resolve browser-native HTTPS imports.
import * as PierreDiffs from 'https://esm.sh/@pierre/diffs@1.4.2?external=react,react-dom&bundle=false';
// @ts-expect-error TypeScript does not resolve browser-native HTTPS imports.
import * as PierreDiffsReact from 'https://esm.sh/@pierre/diffs@1.4.2/react?external=react,react-dom&bundle=false';
import { ChevronDown, ChevronRight, Columns2, ExternalLink, Pilcrow, SquareChartGantt, WrapText } from 'lucide-react';
import { Table } from 'surrealdb';
import { db, useCollection } from 'bigband/db';
import { exec, openEditor, registerRPC, viewContext } from 'bigband/host';
import { useHostEvent } from 'bigband/panel';
import { nearestBookmark } from 'bigband/vcs';
import { theme as initialTheme, useTheme, type ThemeTokens } from 'bigband/theme';
import { CommentForm, CommentThread } from './DiffComments.tsx';

const { parsePatchFiles, registerCustomTheme } = PierreDiffs as unknown as {
  parsePatchFiles: typeof ParsePatchFiles;
  registerCustomTheme: typeof RegisterCustomTheme;
};
const { CodeView } = PierreDiffsReact as unknown as { CodeView: typeof CodeViewComponent };

function diffThemeName(theme: ThemeTokens): string {
  const domains = [
    theme.mode, theme.background, theme.main_background, theme.foreground,
    theme.muted, theme.hover, theme.accent, theme.danger, theme.success,
    theme.warning, ...Object.values(theme.editor), ...Object.values(theme.syntax),
    ...Object.values(theme.diff),
  ];
  let hash = 2166136261;
  for (const value of domains) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `bigband-${theme.mode}-${(hash >>> 0).toString(16)}`;
}

const registeredDiffThemes = new Set<string>();

function registerBigbandDiffTheme(theme: ThemeTokens): string {
  const name = diffThemeName(theme);
  if (registeredDiffThemes.has(name)) return name;
  registerCustomTheme(name, async () => ({
    name,
    displayName: `Bigband ${theme.mode}`,
    type: theme.mode,
    colors: {
      'editor.background': theme.editor.background,
      'editor.foreground': theme.editor.foreground,
      'editorGutter.background': theme.editor.gutter_background,
      'editorLineNumber.foreground': theme.editor.line_number,
      'editorLineNumber.activeForeground': theme.editor.line_number_active,
      'editor.lineHighlightBackground': theme.editor.active_line_background,
      'editor.selectionBackground': theme.editor.selection_background,
      'gitDecoration.addedResourceForeground': theme.diff.added,
      'gitDecoration.deletedResourceForeground': theme.diff.removed,
      'gitDecoration.modifiedResourceForeground': theme.diff.modified,
      'terminal.ansiGreen': theme.diff.added,
      'terminal.ansiRed': theme.diff.removed,
      'terminal.ansiYellow': theme.diff.modified,
      'editorError.foreground': theme.syntax.invalid,
    },
    tokenColors: [
      { settings: { foreground: theme.editor.foreground } },
      { scope: ['variable', 'variable.other.constant'], settings: { foreground: theme.syntax.variable } },
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: theme.syntax.comment } },
      { scope: ['string', 'string.quoted', 'string.template'], settings: { foreground: theme.syntax.string } },
      { scope: ['constant.numeric'], settings: { foreground: theme.syntax.number } },
      { scope: ['constant', 'constant.language'], settings: { foreground: theme.syntax.constant } },
      { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier'], settings: { foreground: theme.syntax.keyword } },
      { scope: ['entity.name.function', 'support.function', 'variable.function'], settings: { foreground: theme.syntax.function } },
      { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.name.tag'], settings: { foreground: theme.syntax.type } },
      { scope: ['variable.parameter'], settings: { foreground: theme.syntax.parameter } },
      { scope: ['keyword.operator', 'keyword.operator.arithmetic', 'keyword.operator.logical'], settings: { foreground: theme.syntax.operator } },
      { scope: ['punctuation', 'punctuation.separator', 'punctuation.terminator'], settings: { foreground: theme.syntax.punctuation } },
      { scope: ['markup.inserted'], settings: { foreground: theme.diff.added } },
      { scope: ['markup.deleted'], settings: { foreground: theme.diff.removed } },
      { scope: ['invalid', 'invalid.illegal'], settings: { foreground: theme.syntax.invalid } },
      { scope: ['markup.changed'], settings: { foreground: theme.diff.modified } },
    ],
  }));
  registeredDiffThemes.add(name);
  return name;
}

const INITIAL_DIFF_THEME = registerBigbandDiffTheme(initialTheme);

// Rust has already blended line backgrounds. Pierre treats its background
// overrides as tint targets; avoid blending them a second time. Selection and
// hover use independent mix variables and keep their normal behavior.
const DIFF_BACKGROUND_CSS = `
  [data-column-number] {
    --diffs-bg: var(--diffs-bg-context-gutter-override);
  }
  [data-line-type="change-addition"], [data-line-type="change-deletion"] {
    --mix-light: 0%;
    --mix-dark: 0%;
  }
`;

interface DiffArguments {
  vcs?: 'git' | 'jj';
  command?: string[];
}

type DiffSide = 'additions' | 'deletions';

interface CommentAnchor {
  path: string;
  startSide: DiffSide;
  startLine: number;
  side: DiffSide;
  line: number;
}


interface LocalComment {
  id: unknown;
  path: string;
  start_side?: DiffSide;
  start_line?: number;
  side: DiffSide;
  line_number: number;
  body: string;
  created_at?: string;
  resolved_at?: string;
  thread_id?: unknown;
}

interface ThreadReply {
  id: string;
  body: string;
  author: string;
  createdAt?: string;
  url?: string;
}

interface GitHubComment extends CommentAnchor {
  id: number;
  body: string;
  author: string;
  url?: string;
  createdAt?: string;
  replies: ThreadReply[];
  threadId?: string;
  resolved: boolean;
}

interface SavedCommentAnnotation {
  source: 'local' | 'github';
  id: string;
  anchor: CommentAnchor;
  body: string;
  author: string;
  createdAt?: string;
  url?: string;
  replies: ThreadReply[];
  onReply: (body: string) => Promise<boolean>;
  onResolve?: () => Promise<void>;
}

interface ComposerAnnotation {
  source: 'composer';
  anchor: CommentAnchor;
  canPublish: boolean;
  onSave: (body: string) => Promise<void>;
  onPublish: (body: string) => Promise<void>;
  onCancel: () => void;
}

type CommentAnnotation = SavedCommentAnnotation | ComposerAnnotation;

function commentLocation(anchor: CommentAnchor): string {
  if (anchor.startSide !== anchor.side) {
    return `${anchor.path}:${anchor.startSide} ${anchor.startLine}–${anchor.side} ${anchor.line}`;
  }
  return anchor.startLine === anchor.line
    ? `${anchor.path}:${anchor.line}`
    : `${anchor.path}:${anchor.startLine}–${anchor.line}`;
}


interface GitHubReview {
  ownerRepo: string;
  number: number;
  commitId: string;
}

const DIFF_COMMENT = new Table('diff_comment');

const styles: Record<string, CSSProperties> = {
  wrap: {
    display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0,
    background: 'var(--bb-background)', color: 'var(--bb-foreground)',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    fontSize: 'clamp(9px, calc(var(--bb-ui-font-size, 15px) * 0.73), 18px)',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 10, minHeight: 34, padding: '0 10px',
    borderBottom: '1px solid var(--bb-border)', background: 'var(--bb-background)',
  },
  title: { fontSize: '1.1em', fontWeight: 700 },
  detail: { flex: 1, minWidth: 0, fontSize: '0.85em', color: 'var(--bb-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  review: { fontSize: '0.85em', color: 'var(--bb-muted)', whiteSpace: 'nowrap' },
  button: {
    border: '1px solid var(--bb-border)', borderRadius: 4, padding: '3px 7px', cursor: 'pointer',
    color: 'var(--bb-foreground)', background: 'var(--bb-secondary)', fontSize: '0.85em',
  },
  iconButton: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 3,
  },
  viewer: { flex: '1 1 auto', minHeight: 0, overflow: 'hidden' },
  slotToggle: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'center',
    width: 18, height: 18, padding: 0, border: 0, borderRadius: 3,
    cursor: 'pointer', color: 'var(--diffs-fg)',
  },
  editorButton: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 20, height: 20, padding: 0, border: '1px solid var(--bb-border)',
    borderRadius: 3, cursor: 'pointer', color: 'var(--diffs-fg)',
    background: 'transparent',
  },

  message: { padding: 16, fontSize: '1em', color: 'var(--bb-muted)' },
  error: { padding: 8, fontSize: '0.9em', color: 'var(--bb-danger)', borderBottom: '1px solid var(--bb-border)' },
};
function generatedFilesFromAttributes(stdout: string): Set<string> {
  const generated = new Set<string>();
  const fields = stdout.split('\0');
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [path, attribute, value] = fields.slice(index, index + 3);
    if (attribute === 'linguist-generated' && (value === 'set' || value === 'true')) generated.add(path);
  }
  return generated;
}



function annotationVersion(annotations: DiffLineAnnotation<CommentAnnotation>[], collapsed: boolean): number {
  let hash = 2166136261 ^ (collapsed ? 1 : 0);
  for (const annotation of annotations) {
    const metadata = annotation.metadata;
    const identity = metadata.source === 'composer'
      ? `${metadata.source}:${metadata.anchor.startSide}:${metadata.anchor.startLine}:${annotation.side}:${annotation.lineNumber}`
      : `${metadata.source}:${metadata.id}:${metadata.replies.map((reply) => reply.id).join(',')}:${annotation.side}:${annotation.lineNumber}`;
    for (let index = 0; index < identity.length; index += 1) {
      hash ^= identity.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}



function diffCommand({ command, vcs }: DiffArguments, ignoreWhitespace: boolean) {
  const args = command ?? (vcs === 'jj'
    ? ['jj', 'diff', '--git', '--color=never']
    : ['git', 'diff', 'HEAD', '--no-ext-diff', '--binary']);
  if (!Array.isArray(args) || args.length === 0 || args.some((part) => typeof part !== 'string')) {
    throw new Error("status diff: 'command' must be a non-empty string array");
  }
  if (args[0] === 'jj' && args[1] === 'diff') {
    if (!ignoreWhitespace) return args;
    const separator = args.indexOf('--');
    const insertAt = separator === -1 ? args.length : separator;
    return [...args.slice(0, insertAt), '--ignore-all-space', ...args.slice(insertAt)];
  }
  if (args[0] !== 'git' || args[1] !== 'diff') {
    if (ignoreWhitespace) throw new Error('status diff: hiding whitespace requires a git or jj diff command');
    return args;
  }
  const separator = args.indexOf('--');
  const insertAt = separator === -1 ? args.length : separator;
  const outputOptions = ['--src-prefix=a/', '--dst-prefix=b/'];
  if (ignoreWhitespace) outputOptions.push('--ignore-all-space');
  return [...args.slice(0, insertAt), ...outputOptions, ...args.slice(insertAt)];
}

function parseJson<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function findGitHubReview(instance: string, vcs?: 'git' | 'jj'): Promise<GitHubReview | null> {
  const ref = vcs === 'jj' ? await nearestBookmark(instance) : null;
  const prArgs = ['gh', 'pr', 'view'];
  if (ref) prArgs.push(ref);
  prArgs.push('--json', 'number,headRefOid');
  const [prResult, repoResult] = await Promise.all([
    exec(instance, prArgs),
    exec(instance, ['gh', 'repo', 'view', '--json', 'nameWithOwner']),
  ]);
  if (prResult.exit !== 0 || repoResult.exit !== 0) return null;
  const pr = parseJson<{ number: number; headRefOid: string }>(prResult.stdout, 'gh pr view');
  const repo = parseJson<{ nameWithOwner: string }>(repoResult.stdout, 'gh repo view');
  if (!pr.number || !pr.headRefOid || !repo.nameWithOwner) return null;
  return { ownerRepo: repo.nameWithOwner, number: pr.number, commitId: pr.headRefOid };
}

async function loadGitHubThreadStates(instance: string, review: GitHubReview) {
  const separator = review.ownerRepo.indexOf('/');
  if (separator < 1) throw new Error(`Invalid GitHub repository: ${review.ownerRepo}`);
  const owner = review.ownerRepo.slice(0, separator);
  const name = review.ownerRepo.slice(separator + 1);
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            nodes { id isResolved comments(first: 100) { nodes { databaseId } } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const states = new Map<number, { id: string; resolved: boolean }>();
  let cursor: string | null = null;
  do {
    const args = [
      'gh', 'api', 'graphql', '-f', `query=${query}`,
      '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${review.number}`,
    ];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const result = await exec(instance, args);
    if (result.exit !== 0) throw new Error(result.stderr || 'Failed to load GitHub review threads');
    const response = parseJson<{
      data?: { repository?: { pullRequest?: { reviewThreads?: {
        nodes?: Array<{ id: string; isResolved: boolean; comments?: { nodes?: Array<{ databaseId?: number }> } }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      } } } };
      errors?: Array<{ message?: string }>;
    }>(result.stdout, 'GitHub review threads');
    if (response.errors?.length) throw new Error(response.errors.map((error) => error.message).filter(Boolean).join('; '));
    const connection = response.data?.repository?.pullRequest?.reviewThreads;
    for (const thread of connection?.nodes ?? []) {
      for (const comment of thread.comments?.nodes ?? []) {
        if (comment.databaseId) states.set(comment.databaseId, { id: thread.id, resolved: thread.isResolved });
      }
    }
    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor ?? null : null;
  } while (cursor);
  return states;
}

async function loadGitHubComments(instance: string, review: GitHubReview): Promise<GitHubComment[]> {
  const [result, threadStates] = await Promise.all([
    exec(instance, [
      'gh', 'api', '--method', 'GET',
      `repos/${review.ownerRepo}/pulls/${review.number}/comments`,
      '-F', 'per_page=100',
    ]),
    loadGitHubThreadStates(instance, review),
  ]);
  if (result.exit !== 0) throw new Error(result.stderr || 'Failed to load GitHub comments');
  const rows = parseJson<Array<{
    id: number; body: string; path: string; line: number | null; original_line: number | null;
    start_line: number | null; original_start_line: number | null;
    side: 'LEFT' | 'RIGHT' | null; start_side: 'LEFT' | 'RIGHT' | null;
    in_reply_to_id?: number; user?: { login?: string }; html_url?: string; created_at?: string;
  }>>(result.stdout, 'GitHub comments');
  return rows.filter((row) => !row.in_reply_to_id).flatMap((row) => {
    const line = row.line ?? row.original_line;
    if (!row.path || !line || !row.side) return [];
    const side = row.side === 'LEFT' ? 'deletions' as const : 'additions' as const;
    const startSide = row.start_side ? (row.start_side === 'LEFT' ? 'deletions' as const : 'additions' as const) : side;
    const thread = threadStates.get(row.id);
    return [{
      id: row.id,
      body: row.body,
      path: row.path,
      startLine: row.start_line ?? row.original_start_line ?? line,
      startSide,
      line,
      side,
      author: row.user?.login ?? 'GitHub',
      url: row.html_url,
      createdAt: row.created_at,
      replies: rows.filter((reply) => reply.in_reply_to_id === row.id).map((reply) => ({
        id: String(reply.id),
        body: reply.body,
        author: reply.user?.login ?? 'GitHub',
        createdAt: reply.created_at,
        url: reply.html_url,
      })),
      threadId: thread?.id,
      resolved: thread?.resolved ?? false,
    }];
  });
}

async function postGitHubComment(
  instance: string,
  review: GitHubReview,
  anchor: CommentAnchor,
  body: string,
): Promise<void> {
  const args = [
    'gh', 'api', '--method', 'POST',
    `repos/${review.ownerRepo}/pulls/${review.number}/comments`,
    '-f', `body=${body}`,
    '-f', `commit_id=${review.commitId}`,
    '-f', `path=${anchor.path}`,
    '-F', `line=${anchor.line}`,
    '-f', `side=${anchor.side === 'deletions' ? 'LEFT' : 'RIGHT'}`,
  ];
  if (anchor.startLine !== anchor.line || anchor.startSide !== anchor.side) {
    args.push(
      '-F', `start_line=${anchor.startLine}`,
      '-f', `start_side=${anchor.startSide === 'deletions' ? 'LEFT' : 'RIGHT'}`,
    );
  }
  const result = await exec(instance, args);
  if (result.exit !== 0) throw new Error(result.stderr || 'GitHub rejected the review comment');
}

async function postGitHubReply(
  instance: string,
  review: GitHubReview,
  commentId: number,
  body: string,
): Promise<void> {
  const result = await exec(instance, [
    'gh', 'api', '--method', 'POST',
    `repos/${review.ownerRepo}/pulls/${review.number}/comments/${commentId}/replies`,
    '-f', `body=${body}`,
  ]);
  if (result.exit !== 0) throw new Error(result.stderr || 'GitHub rejected the review reply');
}

async function resolveGitHubThread(instance: string, threadId: string): Promise<void> {
  const query = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
    }
  `;
  const result = await exec(instance, [
    'gh', 'api', 'graphql', '-f', `query=${query}`, '-f', `threadId=${threadId}`,
  ]);
  if (result.exit !== 0) throw new Error(result.stderr || 'GitHub rejected the thread resolution');
  const response = parseJson<{ errors?: Array<{ message?: string }> }>(result.stdout, 'GitHub thread resolution');
  if (response.errors?.length) throw new Error(response.errors.map((error) => error.message).filter(Boolean).join('; '));
}

function CommentAnnotationView({ annotation, onDelete }: {
  annotation: DiffLineAnnotation<CommentAnnotation>;
  onDelete: (id: string) => void;
}) {
  const metadata = annotation.metadata;
  if (metadata.source === 'composer') {
    return (
      <CommentForm
        location={commentLocation(metadata.anchor)}
        canPublish={metadata.canPublish}
        onSave={metadata.onSave}
        onPublish={metadata.onPublish}
        onCancel={metadata.onCancel}
      />
    );
  }
  return (
    <CommentThread
      author={metadata.author}
      body={metadata.body}
      createdAt={metadata.createdAt}
      location={commentLocation(metadata.anchor)}
      source={metadata.source}
      url={metadata.url}
      replies={metadata.replies}
      onReply={metadata.onReply}
      onResolve={metadata.onResolve}
      onDelete={metadata.source === 'local' ? () => onDelete(metadata.id) : undefined}
    />
  );
}

export default function Diff() {
  const codeViewRef = useRef<CodeViewHandle<CommentAnnotation>>(null);
  const bigbandTheme = useTheme();
  const [diffTheme, setDiffTheme] = useState(INITIAL_DIFF_THEME);
  useEffect(() => {
    const nextTheme = diffThemeName(bigbandTheme);
    if (nextTheme === diffTheme) return;
    registerBigbandDiffTheme(bigbandTheme);
    setDiffTheme(nextTheme);
  }, [bigbandTheme, diffTheme]);
  const context = viewContext<DiffArguments>();
  const [arguments_, setArguments] = useState<DiffArguments>(() => context?.arguments ?? {});
  const [anchor, setAnchor] = useState<CommentAnchor | null>(null);
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState<GitHubReview | null | undefined>(undefined);
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>('unified');
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const [githubComments, setGitHubComments] = useState<GitHubComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const instance = context?.instance.slug ?? '';

  async function openInEditor(path: string) {
    if (!context) return;
    setError(null);
    try {
      await openEditor(path, instance);
    } catch (reason: unknown) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  }
  const diffQuery = useQuery({
    queryKey: ['instance', instance, 'diff', arguments_.vcs, arguments_.command?.join('\u0000') ?? '', ignoreWhitespace],
    enabled: !!context,
    queryFn: async () => {
      if (!context) throw new Error('Missing view context');
      const { stdout, stderr, exit } = await exec(context.instance.slug, diffCommand(arguments_, ignoreWhitespace));
      if (exit !== 0) throw new Error(stderr || `diff exited with status ${exit}`);
      return stdout;
    },
    placeholderData: (previous) => previous,
  });
  const patch = diffQuery.data ?? null;
  const diffError = diffQuery.error
    ? String(diffQuery.error instanceof Error ? diffQuery.error.message : diffQuery.error)
    : null;
  const { rows: localComments, error: commentsError } = useCollection<LocalComment>(
    DIFF_COMMENT,
    'SELECT * FROM diff_comment WHERE instance = $instance ORDER BY created_at ASC',
    { vars: { instance } },
  );
  const visibleError = error ?? commentsError ?? diffError;
  useHostEvent('instance.changed', (event) => {
    if (event?.instance !== instance) return;
    setError(null);
    void diffQuery.refetch();
  }, { debounce: 750 });

  useEffect(() => {
    setCollapsedFiles({});
  }, [instance, arguments_.vcs, arguments_.command?.join('\u0000')]);

  useEffect(() => {
    if (!context) return;
    registerRPC('refresh_diff', ({ command, vcs }: DiffArguments = {}) => {
      setError(null);
      setArguments({ command, vcs: vcs ?? context.arguments.vcs });
      return { ok: true };
    }, context.id);
  }, [context?.id]);

  async function refreshGitHub() {
    if (!context) return;
    setError(null);
    try {
      const found = await findGitHubReview(context.instance.slug, arguments_.vcs);
      setReview(found);
      setGitHubComments(found ? await loadGitHubComments(context.instance.slug, found) : []);
    } catch (reason: unknown) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  }

  useEffect(() => {
    if (patch === null) return;
    void refreshGitHub();
  }, [context?.id, arguments_.vcs, patch === null]);

  function closeComposer() {
    setAnchor(null);
    codeViewRef.current?.clearSelectedLines();
  }

  async function saveLocal(body: string) {
    if (!anchor || !context || !body) return;
    setSaving(true);
    setError(null);
    try {
      await db.query(
        'CREATE diff_comment SET instance = $instance, path = $path, start_side = $startSide, start_line = $startLine, side = $side, line_number = $line, body = $body',
        {
          instance: context.instance.slug,
          path: anchor.path,
          startSide: anchor.startSide,
          startLine: anchor.startLine,
          side: anchor.side,
          line: anchor.line,
          body,
        },
      );
      closeComposer();
    } catch (reason: unknown) {
      const message = String(reason instanceof Error ? reason.message : reason);
      console.error(
        `[status] local diff comment save failed: ${message} (instance=${instance}, path=${anchor.path}, side=${anchor.side}, line=${anchor.line})`,
      );
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  async function publishGitHub(body: string) {
    if (!anchor || !context || !review || !body) return;
    setSaving(true);
    setError(null);
    try {
      await postGitHubComment(context.instance.slug, review, anchor, body);
      closeComposer();
      await refreshGitHub();
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setSaving(false);
    }
  }

  async function replyLocal(comment: LocalComment, body: string): Promise<boolean> {
    if (!context || !body) return false;
    const id = String(comment.id);
    setSaving(true);
    setError(null);
    try {
      await db.query(
        `CREATE diff_comment SET
          instance = $instance, thread_id = type::record($id), path = $path,
          start_side = $startSide, start_line = $startLine, side = $side,
          line_number = $line, body = $body`,
        {
          instance: context.instance.slug,
          id,
          path: comment.path,
          startSide: comment.start_side ?? comment.side,
          startLine: comment.start_line ?? comment.line_number,
          side: comment.side,
          line: comment.line_number,
          body,
        },
      );
      return true;
    } catch (reason: unknown) {
      setError(String(reason instanceof Error ? reason.message : reason));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function resolveLocal(id: string): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await db.query('UPDATE type::record($id) SET resolved_at = time::now()', { id });
    } catch (reason: unknown) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  }

  async function replyGitHubComment(id: number, body: string): Promise<boolean> {
    if (!context || !review || !body) return false;
    setSaving(true);
    setError(null);
    try {
      await postGitHubReply(context.instance.slug, review, id, body);
      await refreshGitHub();
      return true;
    } catch (reason: unknown) {
      setError(String(reason instanceof Error ? reason.message : reason));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function resolveGitHubComment(threadId: string): Promise<void> {
    if (!context) return;
    setSaving(true);
    setError(null);
    try {
      await resolveGitHubThread(context.instance.slug, threadId);
      await refreshGitHub();
    } catch (reason: unknown) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  }

  async function deleteLocal(id: string) {
    try {
      await db.query(
        'DELETE diff_comment WHERE thread_id = type::record($id); DELETE type::record($id);',
        { id },
      );
    } catch (reason: unknown) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  }

  const parsedFiles = useMemo(
    () => patch ? parsePatchFiles(patch, context?.id, true).flatMap((parsed) => parsed.files) : [],
    [patch, context?.id],
  );
  const generatedFilePaths = useMemo(() => parsedFiles.map((fileDiff) => fileDiff.name), [parsedFiles]);
  const generatedFilesQuery = useQuery({
    queryKey: ['instance', instance, 'generated-files', arguments_.vcs, generatedFilePaths],
    enabled: !!context && generatedFilePaths.length > 0,
    queryFn: async () => {
      const result = await exec(instance, ['git', 'check-attr', '-z', 'linguist-generated', '--', ...generatedFilePaths]);
      return result.exit === 0 ? generatedFilesFromAttributes(result.stdout) : new Set<string>();
    },
  });
  const generatedFiles = generatedFilesQuery.data;

  const items = useMemo(() => {
    if (parsedFiles.length === 0) return [];
    const local = localComments ?? [];
    const annotationsFor = (path: string): DiffLineAnnotation<CommentAnnotation>[] => [
      ...local.filter((comment) => comment.path === path && !comment.thread_id && !comment.resolved_at).map((comment) => {
        const commentId = String(comment.id);
        const commentAnchor: CommentAnchor = {
          path,
          startSide: comment.start_side ?? comment.side,
          startLine: comment.start_line ?? comment.line_number,
          side: comment.side,
          line: comment.line_number,
        };
        return {
          side: comment.side,
          lineNumber: comment.line_number,
          metadata: {
            source: 'local' as const,
            id: commentId,
            anchor: commentAnchor,
            body: comment.body,
            author: 'You',
            createdAt: comment.created_at,
            replies: local
              .filter((reply) => String(reply.thread_id) === commentId)
              .map((reply) => ({
                id: String(reply.id),
                body: reply.body,
                author: 'You',
                createdAt: reply.created_at,
              })),
            onReply: (body: string) => replyLocal(comment, body),
            onResolve: () => resolveLocal(commentId),
          },
        };
      }),
      ...githubComments.filter((comment) => comment.path === path && !comment.resolved).map((comment) => ({
        side: comment.side,
        lineNumber: comment.line,
        metadata: {
          source: 'github' as const,
          id: String(comment.id),
          anchor: comment,
          body: comment.body,
          author: comment.author,
          createdAt: comment.createdAt,
          url: comment.url,
          replies: comment.replies,
          onReply: (body: string) => replyGitHubComment(comment.id, body),
          onResolve: comment.threadId ? () => resolveGitHubComment(comment.threadId!) : undefined,
        },
      })),
      ...(anchor?.path === path ? [{
        side: anchor.side,
        lineNumber: anchor.line,
        metadata: {
          source: 'composer' as const,
          anchor,
          canPublish: review !== null && review !== undefined,
          onSave: saveLocal,
          onPublish: publishGitHub,
          onCancel: closeComposer,
        },
      }] : []),
    ];
    return parsedFiles.map((fileDiff, index) => {
      const annotations = annotationsFor(fileDiff.name);
      const collapsed = Object.prototype.hasOwnProperty.call(collapsedFiles, fileDiff.name)
        ? collapsedFiles[fileDiff.name]
        : generatedFiles?.has(fileDiff.name) ?? false;
      return {
        id: `${index}:${fileDiff.name}`,
        type: 'diff' as const,
        fileDiff,
        annotations,
        version: annotationVersion(annotations, collapsed),
        collapsed,
      };
    });
  }, [parsedFiles, localComments, githubComments, anchor, review, generatedFiles, collapsedFiles]);



  const detail = arguments_.command?.join(' ') ?? context?.instance.path ?? 'No instance';
  const reviewLabel = review === undefined
    ? 'Checking GitHub…'
    : review
      ? `${review.ownerRepo} #${review.number}`
      : 'No GitHub PR';

  function toggleFile(item: CodeViewItem<CommentAnnotation>) {
    if (item.type !== 'diff') return;
    setCollapsedFiles((current) => ({
      ...current,
      [item.fileDiff.name]: !item.collapsed,
    }));
  }

  return (
    <main style={styles.wrap}>
      <header style={styles.header}>
        <span style={styles.title}>Working copy diff</span>
        <span style={styles.detail} title={detail}>{detail}</span>
        <span style={styles.review}>{reviewLabel}</span>
        <button
          type="button"
          style={{
            ...styles.button,
            ...styles.iconButton,
            color: diffStyle === 'split' ? 'var(--bb-accent)' : 'var(--bb-muted)',
          }}
          aria-pressed={diffStyle === 'split'}
          aria-label={diffStyle === 'split' ? 'Switch to unified view' : 'Switch to side-by-side view'}
          title={diffStyle === 'split' ? 'Switch to unified view' : 'Switch to side-by-side view'}
          onClick={() => setDiffStyle((current) => current === 'unified' ? 'split' : 'unified')}
        >
          {diffStyle === 'split'
            ? <Columns2 size={13} strokeWidth={2} />
            : <SquareChartGantt size={13} strokeWidth={2} />}
        </button>
        <button
          type="button"
          style={{
            ...styles.button,
            ...styles.iconButton,
            color: ignoreWhitespace ? 'var(--bb-accent)' : 'var(--bb-muted)',
          }}
          aria-pressed={ignoreWhitespace}
          aria-label={ignoreWhitespace ? 'Show whitespace changes' : 'Hide whitespace changes'}
          title={ignoreWhitespace ? 'Show whitespace changes' : 'Hide whitespace changes'}
          onClick={() => setIgnoreWhitespace((current) => !current)}
        >
          <Pilcrow size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          style={{
            ...styles.button,
            ...styles.iconButton,
            color: wrapLines ? 'var(--bb-accent)' : 'var(--bb-muted)',
          }}
          aria-pressed={wrapLines}
          aria-label={wrapLines ? 'Disable line wrapping' : 'Enable line wrapping'}
          title={wrapLines ? 'Disable line wrapping' : 'Enable line wrapping'}
          onClick={() => setWrapLines((current) => !current)}
        >
          <WrapText size={13} strokeWidth={2} />
        </button>
        <button style={styles.button} disabled={saving} onClick={() => void refreshGitHub()}>Sync comments</button>
      </header>
      {visibleError && (
        <div role="alert" style={styles.error}>{visibleError}</div>
      )}
      {!diffError && patch === null && diffQuery.isPending && <div style={styles.message}>Loading diff…</div>}
      {!diffError && patch === '' && <div style={styles.message}>No working copy changes.</div>}
      {!diffError && patch && (
        <div style={styles.viewer}>
          <CodeView<CommentAnnotation>
            ref={codeViewRef}
            items={items}
            key={diffTheme}
            style={{
              height: '100%', minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain',
              '--diffs-font-size': 'clamp(8px, calc(var(--bb-ui-font-size, 15px) * 0.75), 16px)',
              '--diffs-bg': bigbandTheme.editor.background,
              '--diffs-fg': bigbandTheme.editor.foreground,
              '--diffs-bg-context-override': bigbandTheme.editor.background,
              '--diffs-bg-context-gutter-override': bigbandTheme.editor.gutter_background,
              '--diffs-bg-hover-override': bigbandTheme.editor.active_line_background,
              '--diffs-bg-selection-override': bigbandTheme.editor.selection_background,
              '--diffs-bg-separator-override': bigbandTheme.secondary,
              '--diffs-fg-number-override': bigbandTheme.editor.line_number,
              '--diffs-addition-color-override': bigbandTheme.diff.added,
              '--diffs-deletion-color-override': bigbandTheme.diff.removed,
              '--diffs-modified-color-override': bigbandTheme.diff.modified,
              '--diffs-bg-addition-override': bigbandTheme.diff.added_background,
              '--diffs-bg-deletion-override': bigbandTheme.diff.removed_background,
              '--diffs-bg-addition-number-override': bigbandTheme.diff.added_background,
              '--diffs-bg-deletion-number-override': bigbandTheme.diff.removed_background,
              '--diffs-bg-addition-emphasis-override': bigbandTheme.diff.added_word_background,
              '--diffs-bg-deletion-emphasis-override': bigbandTheme.diff.removed_word_background,
            } as CSSProperties}
            options={{
              diffStyle, overflow: wrapLines ? 'wrap' : 'scroll', stickyHeaders: true,
              unsafeCSS: DIFF_BACKGROUND_CSS,
              theme: diffTheme,
              themeType: bigbandTheme.mode,
              lineHoverHighlight: 'line', enableGutterUtility: true,
              onGutterUtilityClick: (range, itemContext) => {
                if (itemContext.type !== 'diff') return;
                const startSide = range.side ?? range.endSide;
                const side = range.endSide ?? range.side;
                if (!startSide || !side) return;
                setAnchor({
                  path: itemContext.item.fileDiff.name,
                  startSide,
                  startLine: range.start,
                  side,
                  line: range.end,
                });
              },
            }}
            renderHeaderPrefix={(item) => {
              if (item.type !== 'diff') return null;
              return (
                <button
                  type="button"
                  aria-expanded={!item.collapsed}
                  aria-label={item.collapsed ? `Expand ${item.fileDiff.name}` : `Collapse ${item.fileDiff.name}`}
                  title={item.collapsed ? 'Expand file' : 'Collapse file'}
                  style={{
                    ...styles.slotToggle,
                    color: item.collapsed ? 'var(--diffs-fg-number-override)' : 'var(--diffs-fg)',
                  }}
                  onClick={(event) => { event.stopPropagation(); toggleFile(item); }}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  {item.collapsed ? <ChevronRight size={15} strokeWidth={2} /> : <ChevronDown size={15} strokeWidth={2} />}
                </button>
              );
            }}
            renderHeaderFilenameSuffix={(item) => {
              if (item.type !== 'diff' || item.fileDiff.type === 'deleted') return null;
              const path = item.fileDiff.name;
              return (
                <button
                  type="button"
                  style={styles.editorButton}
                  aria-label={`Open ${path} in editor`}
                  title={`Open ${path} in editor`}
                  onClick={(event) => { event.stopPropagation(); void openInEditor(path); }}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <ExternalLink size={13} strokeWidth={2} />
                </button>
              );
            }}
            renderAnnotation={(annotation) => (
              <CommentAnnotationView annotation={annotation as DiffLineAnnotation<CommentAnnotation>} onDelete={(id) => void deleteLocal(id)} />
            )}
          />
        </div>
      )}
    </main>
  );
}
