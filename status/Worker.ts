import { db, migrate } from 'bigband/db';
import { openView, registerRPC, workspaces } from 'bigband/host';
import type { ViewPlacement } from 'bigband/host';

await migrate('status', [{
  version: 1,
  query: `
    DEFINE TABLE OVERWRITE diff_comment SCHEMAFULL;
    REMOVE FIELD IF EXISTS scope ON diff_comment;
    DEFINE FIELD OVERWRITE instance ON diff_comment TYPE string;
    DEFINE FIELD OVERWRITE resolved_at ON diff_comment TYPE option<datetime>;
    DEFINE FIELD OVERWRITE path ON diff_comment TYPE string;
    DEFINE FIELD OVERWRITE side ON diff_comment TYPE string ASSERT $value IN ['additions', 'deletions'];
    DEFINE FIELD OVERWRITE line_number ON diff_comment TYPE int;
    DEFINE FIELD OVERWRITE body ON diff_comment TYPE string;
    DEFINE FIELD OVERWRITE created_at ON diff_comment TYPE datetime DEFAULT time::now();
    DEFINE INDEX OVERWRITE diff_comment_location ON diff_comment FIELDS instance, path, side, line_number;
  `,
}, {
  version: 2,
  query: `
    DEFINE FIELD OVERWRITE start_side ON diff_comment TYPE option<string>;
    DEFINE FIELD OVERWRITE start_line ON diff_comment TYPE option<int>;
  `,
}, {
  version: 3,
  query: `
    DEFINE FIELD OVERWRITE thread_id ON diff_comment TYPE option<record<diff_comment>>;
    DEFINE INDEX OVERWRITE diff_comment_thread ON diff_comment FIELDS instance, thread_id, created_at;
  `,
}]);

interface OpenDiffArgs {
  workspace_id?: string;
  placement?: ViewPlacement;
  vcs?: 'git' | 'jj';
  command?: string[];
}

async function openDiff({ workspace_id, placement = 'tab', vcs, command }: OpenDiffArgs = {}) {
  const workspaceId = String(workspace_id ?? '').trim();
  if (!workspaceId) throw new Error("status.open_diff: missing 'workspace_id'");
  if (command !== undefined && (!Array.isArray(command) || command.length === 0 || command.some((arg) => typeof arg !== 'string'))) {
    throw new Error('status.open_diff command must be a non-empty string array');
  }

  const workspace = (await workspaces()).find((candidate) => candidate.workspace_id === workspaceId);
  if (!workspace?.project || !workspace.repository) {
    throw new Error('status.open_diff requires an open project workspace with a repository');
  }

  if (command === undefined && vcs !== 'git' && vcs !== 'jj') {
    const backend = workspace.repository.backend;
    if (backend !== 'git' && backend !== 'jj') {
      throw new Error(`status.open_diff does not support repository backend ${backend}`);
    }

    vcs = backend;
  }

  return openView('status', 'diff', workspaceId, { vcs, command }, placement);
}

interface CommentRpcArgs {
  instance?: string;
  id?: string;
  body?: string;
}

interface StoredComment {
  id: unknown;
  instance: string;
  path: string;
  side: 'additions' | 'deletions';
  start_side?: 'additions' | 'deletions';
  start_line?: number;
  line_number: number;
  body: string;
  created_at?: string;
  resolved_at?: string;
  thread_id?: unknown;
}

function serializeReply(reply: StoredComment) {
  return {
    id: String(reply.id),
    body: reply.body,
    author: 'You',
    createdAt: reply.created_at,
  };
}

function serializeComment(comment: StoredComment, replies: StoredComment[] = []) {
  return {
    id: String(comment.id),
    source: 'local' as const,
    instance: comment.instance,
    path: comment.path,
    side: comment.side,
    startSide: comment.start_side ?? comment.side,
    startLine: comment.start_line ?? comment.line_number,
    line: comment.line_number,
    body: comment.body,
    createdAt: comment.created_at,
    resolvedAt: comment.resolved_at ?? null,
    replies: replies.map(serializeReply),
  };
}

async function listComments({ instance }: CommentRpcArgs = {}) {
  const instanceSlug = String(instance ?? '').trim();
  if (!instanceSlug) throw new Error("status.list_comments: missing 'instance'");
  const [comments] = await db.query<[StoredComment[]]>(
    'SELECT * FROM diff_comment WHERE instance = $instance ORDER BY created_at ASC',
    { instance: instanceSlug },
  );
  return (comments ?? [])
    .filter((comment) => !comment.thread_id)
    .map((comment) => serializeComment(
      comment,
      comments.filter((reply) => String(reply.thread_id) === String(comment.id)),
    ));
}

async function resolveComment({ instance, id }: CommentRpcArgs = {}) {
  const instanceSlug = String(instance ?? '').trim();
  if (!instanceSlug) throw new Error("status.resolve_comment: missing 'instance'");
  const commentId = String(id ?? '').trim();
  if (!commentId) throw new Error("status.resolve_comment: missing 'id'");
  const [rows, replies] = await db.query<[StoredComment[], StoredComment[]]>(
    `UPDATE type::record($id) SET resolved_at = time::now()
       WHERE instance = $instance AND thread_id = NONE RETURN AFTER;
     SELECT * FROM diff_comment WHERE thread_id = type::record($id) ORDER BY created_at ASC;`,
    { id: commentId, instance: instanceSlug },
  );
  const comment = rows?.[0];
  if (!comment) throw new Error(`status.resolve_comment: comment not found: ${commentId}`);
  return serializeComment(comment, replies ?? []);
}

async function replyComment({ instance, id, body }: CommentRpcArgs = {}) {
  const instanceSlug = String(instance ?? '').trim();
  if (!instanceSlug) throw new Error("status.reply_comment: missing 'instance'");
  const commentId = String(id ?? '').trim();
  if (!commentId) throw new Error("status.reply_comment: missing 'id'");
  const replyBody = String(body ?? '').trim();
  if (!replyBody) throw new Error("status.reply_comment: missing 'body'");
  const [comments] = await db.query<[StoredComment[]]>(
    'SELECT * FROM type::record($id) WHERE instance = $instance AND thread_id = NONE LIMIT 1',
    { id: commentId, instance: instanceSlug },
  );
  const parent = comments?.[0];
  if (!parent) throw new Error(`status.reply_comment: comment not found: ${commentId}`);
  const [replies] = await db.query<[StoredComment[]]>(
    `CREATE diff_comment SET
      instance = $instance, thread_id = type::record($id), path = $path,
      start_side = $startSide, start_line = $startLine, side = $side,
      line_number = $line, body = $body RETURN AFTER`,
    {
      instance: instanceSlug,
      id: commentId,
      path: parent.path,
      startSide: parent.start_side ?? parent.side,
      startLine: parent.start_line ?? parent.line_number,
      side: parent.side,
      line: parent.line_number,
      body: replyBody,
    },
  );
  const reply = replies?.[0];
  if (!reply) throw new Error('status.reply_comment: reply was not created');
  return serializeReply(reply);
}

// Comments are deliberately scoped to a genuine project-instance slug. Keeping
// the existing `instance` field preserves every saved row without a data
// migration; workspace IDs are used only for execution and view targeting.
registerRPC('open_diff', openDiff);
registerRPC('list_comments', listComments);
registerRPC('resolve_comment', resolveComment);
registerRPC('reply_comment', replyComment);
