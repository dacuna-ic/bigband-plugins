import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Textarea } from 'bigband/ui';

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
    <div className="flex overflow-hidden">
      <div className="m-2.5 w-full max-w-[95%] font-sans sm:max-w-[70%]">
        <form
          className="rounded-lg border bg-card p-3 shadow-[0_2px_4px_rgba(0,0,0,0.05)]"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(onSave);
          }}
        >
          <div className="flex gap-2">
            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-[0.7rem] font-semibold text-secondary-foreground">
              Y
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-xs text-muted-foreground">{location}</div>
              <Textarea
                ref={textareaRef}
                aria-label="Leave a comment"
                placeholder="Leave a comment…"
                className="min-h-16 resize-none text-sm"
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
              <div className="mt-2 flex items-center gap-2">
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
    <div className="flex gap-2 py-2 first:pt-0 last:pb-0">
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-[0.7rem] font-semibold text-secondary-foreground">
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-semibold text-foreground">{author}</span>
          <span className="text-xs text-muted-foreground">
            {createdAt ? new Date(createdAt).toLocaleString() : source === 'local' ? 'Local note' : 'GitHub'}
          </span>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-foreground">{body}</p>
        {url && <a href={url} className="mt-1 inline-block text-xs text-primary hover:underline">View on GitHub</a>}
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
    <div className="m-2.5 max-w-[95%] whitespace-normal font-sans sm:max-w-[70%]">
      <div className="rounded-lg border bg-card p-3 shadow-[0_2px_4px_rgba(0,0,0,0.05)]">
        <div className="mb-1 text-xs text-muted-foreground">{location}</div>
        <ThreadMessage author={author} body={body} createdAt={createdAt} source={source} url={url} />
        {replies.length > 0 && (
          <div className="ml-8 divide-y border-t pt-2">
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
          <div className="mt-2 ml-8">
            <Textarea
              ref={replyRef}
              aria-label="Reply to comment"
              placeholder="Write a reply…"
              className="min-h-14 resize-none text-sm"
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
            <div className="mt-2 flex gap-2">
              <Button type="button" size="sm" disabled={submitting} onClick={() => void submitReply()}>Reply</Button>
              <Button type="button" size="sm" variant="outline" disabled={submitting} onClick={() => setReplying(false)}>Cancel</Button>
            </div>
          </div>
        )}
        <div className="mt-2 ml-8 flex items-center gap-4 border-t pt-2 text-xs">
          <button type="button" className="text-primary hover:underline" onClick={() => setReplying((open) => !open)}>
            {replying ? 'Close reply' : 'Reply'}
          </button>
          {onResolve && (
            <button type="button" className="text-primary hover:underline disabled:opacity-50" disabled={resolving} onClick={() => void resolve()}>
              {resolving ? 'Resolving…' : 'Resolve'}
            </button>
          )}
          {onDelete && (
            <button type="button" className="text-destructive hover:underline" onClick={onDelete}>Delete</button>
          )}
        </div>
      </div>
    </div>
  );
}
