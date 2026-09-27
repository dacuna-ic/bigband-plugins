import { useCallback, useEffect, useRef, useState } from 'react';
import { css } from 'goober';
import { Button, Textarea } from 'bigband/ui';

// Installed plugins are outside the host's Tailwind source scan. Keep comment
// layout here; shared Button/Textarea components still use the host's own CSS.
const commentClass = css`
  margin: 10px;
  width: calc(100% - 20px);
  max-width: 95%;
  white-space: normal;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: clamp(9px, calc(var(--bb-ui-font-size, 15px) * 0.73), 18px);
  line-height: 1.5;
  color: var(--bb-foreground);

  @media (min-width: 640px) { max-width: 70%; }

  & .comment-card {
    box-sizing: border-box;
    border: 1px solid var(--bb-border);
    border-radius: 10px;
    background: var(--bb-background);
    padding: 12px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
  }
  & .comment-message { display: flex; gap: 8px; padding: 8px 0; }
  & .comment-message:first-child { padding-top: 0; }
  & .comment-message:last-child { padding-bottom: 0; }
  & .comment-compose { display: flex; gap: 8px; }
  & .comment-avatar {
    display: flex;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--bb-secondary);
    font-size: 0.85em;
    font-weight: 600;
  }
  & .comment-content { min-width: 0; flex: 1; }
  & .comment-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
  & .comment-author { font-weight: 600; }
  & .comment-time, & .comment-location { font-size: 0.85em; color: var(--bb-muted); }
  & .comment-location { margin-bottom: 4px; overflow-wrap: anywhere; }
  & .comment-body { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.625; }
  & .comment-link { display: inline-block; margin-top: 4px; font-size: 0.85em; color: var(--bb-accent); }
  & .comment-link:hover { text-decoration: underline; }
  & .comment-replies { margin-left: 32px; border-top: 1px solid var(--bb-border); padding-top: 8px; }
  & .comment-replies > .comment-message + .comment-message { border-top: 1px solid var(--bb-border); }
  & .comment-reply-form { margin: 8px 0 0 32px; }
  & .comment-input { width: 100%; min-height: 64px; resize: none; font: inherit; }
  & .comment-reply-form .comment-input { min-height: 56px; }
  & .comment-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
  & .comment-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
    margin: 8px 0 0 32px;
    border-top: 1px solid var(--bb-border);
    padding-top: 8px;
    font-size: 0.85em;
  }
  & .comment-actions button { padding: 0; border: 0; background: transparent; color: var(--bb-accent); font: inherit; cursor: pointer; }
  & .comment-actions button:hover { text-decoration: underline; }
  & .comment-actions button:disabled { opacity: 0.5; cursor: default; }
  & .comment-actions .comment-delete { color: var(--bb-danger); }
`;

interface CommentFormProps {
  location: string;
  canPublish: boolean;
  onCancel: () => void;
  onSave: (body: string) => Promise<void>;
  onPublish: (body: string) => Promise<void>;
}

export function CommentForm({
  location,
  canPublish,
  onCancel,
  onSave,
  onPublish,
}: CommentFormProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => textareaRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  const submit = useCallback(async (action: (body: string) => Promise<void>) => {
    if (submitting) return;
    const body = textareaRef.current?.value.trim() ?? '';
    if (body === '') {
      onCancel();
      return;
    }
    setSubmitting(true);
    try {
      await action(body);
    } finally {
      setSubmitting(false);
    }
  }, [onCancel, submitting]);

  return (
    <div style={{ display: 'flex', overflow: 'hidden' }}>
      <div className={commentClass}>
        <form
          className="comment-card"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(onSave);
          }}
        >
          <div className="comment-compose">
            <div className="comment-avatar">
              Y
            </div>
            <div className="comment-content">
              <div className="comment-location">{location}</div>
              <Textarea
                ref={textareaRef}
                aria-label="Leave a comment"
                placeholder="Leave a comment…"
                className="comment-input"
                disabled={submitting}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void submit(onSave);
                  } else if (event.key === 'Escape') {
                    onCancel();
                  }
                }}
              />
              <div className="comment-buttons">
                <Button type="submit" size="sm" disabled={submitting}>Save local</Button>
                {canPublish && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={submitting}
                    onClick={() => void submit(onPublish)}
                  >
                    Publish GitHub
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline" disabled={submitting} onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ThreadReply {
  id: string;
  author: string;
  body: string;
  createdAt?: string;
  url?: string;
}

interface CommentThreadProps {
  author: string;
  body: string;
  createdAt?: string;
  location: string;
  source: 'local' | 'github';
  url?: string;
  replies: ThreadReply[];
  onReply: (body: string) => Promise<boolean>;
  onResolve?: () => Promise<void>;
  onDelete?: () => void;
}

function ThreadMessage({ author, body, createdAt, source, url }: {
  author: string;
  body: string;
  createdAt?: string;
  source: 'local' | 'github';
  url?: string;
}) {
  const initial = author.trim().charAt(0).toUpperCase() || '?';
  return (
    <div className="comment-message">
      <div className="comment-avatar">
        {initial}
      </div>
      <div className="comment-content">
        <div className="comment-meta">
          <span className="comment-author">{author}</span>
          <span className="comment-time">
            {createdAt ? new Date(createdAt).toLocaleString() : source === 'local' ? 'Local note' : 'GitHub'}
          </span>
        </div>
        <p className="comment-body">{body}</p>
        {url && <a href={url} className="comment-link">View on GitHub</a>}
      </div>
    </div>
  );
}

export function CommentThread({
  author,
  body,
  createdAt,
  location,
  source,
  url,
  replies,
  onReply,
  onResolve,
  onDelete,
}: CommentThreadProps) {
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const [replying, setReplying] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (replying) replyRef.current?.focus();
  }, [replying]);

  const submitReply = useCallback(async () => {
    if (submitting) return;
    const reply = replyRef.current?.value.trim() ?? '';
    if (!reply) return;
    setSubmitting(true);
    try {
      if (await onReply(reply)) setReplying(false);
    } finally {
      setSubmitting(false);
    }
  }, [onReply, submitting]);

  const resolve = useCallback(async () => {
    if (!onResolve || resolving) return;
    setResolving(true);
    try {
      await onResolve();
    } finally {
      setResolving(false);
    }
  }, [onResolve, resolving]);

  return (
    <div className={commentClass}>
      <div className="comment-card">
        <div className="comment-location">{location}</div>
        <ThreadMessage author={author} body={body} createdAt={createdAt} source={source} url={url} />
        {replies.length > 0 && (
          <div className="comment-replies">
            {replies.map((reply) => (
              <ThreadMessage
                key={reply.id}
                author={reply.author}
                body={reply.body}
                createdAt={reply.createdAt}
                source={source}
                url={reply.url}
              />
            ))}
          </div>
        )}
        {replying && (
          <div className="comment-reply-form">
            <Textarea
              ref={replyRef}
              aria-label="Reply to comment"
              placeholder="Write a reply…"
              className="comment-input"
              disabled={submitting}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void submitReply();
                } else if (event.key === 'Escape') {
                  setReplying(false);
                }
              }}
            />
            <div className="comment-buttons">
              <Button type="button" size="sm" disabled={submitting} onClick={() => void submitReply()}>Reply</Button>
              <Button type="button" size="sm" variant="outline" disabled={submitting} onClick={() => setReplying(false)}>Cancel</Button>
            </div>
          </div>
        )}
        <div className="comment-actions">
          <button type="button" onClick={() => setReplying((open) => !open)}>
            {replying ? 'Close reply' : 'Reply'}
          </button>
          {onResolve && (
            <button type="button" disabled={resolving} onClick={() => void resolve()}>
              {resolving ? 'Resolving…' : 'Resolve'}
            </button>
          )}
          {onDelete && (
            <button type="button" className="comment-delete" onClick={onDelete}>Delete</button>
          )}
        </div>
      </div>
    </div>
  );
}
