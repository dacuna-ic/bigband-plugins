import { Fragment, type ReactElement, useState } from 'react';
// @ts-expect-error esm.sh serves this catalog as a JSON module.
import emojiEntries from 'https://esm.sh/@buildkite/emojis@2.0.1009/img-buildkite-64.json' with { type: 'json' };
// @ts-expect-error esm.sh serves this catalog as a JSON module.
import appleEmojiEntries from 'https://esm.sh/@buildkite/emojis@2.0.1009/img-apple-64.json' with { type: 'json' };

import { useQuery, useMutation } from '@tanstack/react-query';
import { control, exec, registerRPC } from 'bigband/host';
import { useHostEvent, usePanel } from 'bigband/panel';
import { nearestBookmark } from 'bigband/vcs';
import { Badge, Button, Tooltip, TooltipContent, TooltipTrigger } from 'bigband/ui';
import { toast } from 'bigband/utils';
import { Table } from 'surrealdb';
import { useCollection } from 'bigband/db';
import type { Pr as PrRow } from '../types/generated/index.ts';
import {
  CircleCheck, Loader, CircleX, CircleSlash, Clock, CirclePause, CircleMinus,
  Circle, RefreshCw, RotateCcw, ExternalLink, ChevronDown, ChevronUp, Terminal, Copy, Check, Sparkles,
} from 'lucide-react';

const POLL_MS = 10_000;
const CACHE_MS = 30 * 60_000;

const PR = new Table('pr');
const PR_QUERY = "SELECT number, title, url, head_ref, checks_state FROM pr WHERE repo = $repo AND state = 'OPEN' ORDER BY number DESC";
type CiPr = Pick<PrRow, 'number' | 'title' | 'url' | 'head_ref' | 'checks_state'>;

function stackPrs(bookmarks: string[], rows: CiPr[]): CiPr[] {
  const seen = new Set<number>();
  return bookmarks.flatMap(bookmark => {
    const pr = rows.find(row => row.head_ref === bookmark);
    if (!pr || seen.has(pr.number)) return [];
    seen.add(pr.number);
    return [pr];
  });
}

const AI_GATEWAY = 'https://aigateway.instacart.tools/unified/dacuna-ic/v1/chat/completions';
const AI_MODEL = 'gpt-4o-mini-2024-07-18';
const AI_MAX_LOGGED_FAILED_JOBS = 6;
const AI_TOTAL_LOG_TOKENS = 1800;
const AI_MAX_OUTPUT_TOKENS = 900;

const NO_AUTH_RE = /not authenticated|401|403|no token/i;
const NO_PIPELINE_RE = /pipeline not found|404/i;
type BuildkiteEmoji = { name: string; image: string; aliases?: string[] };
const BUILDKITE_EMOJI_ASSET_BASE = 'https://esm.sh/@buildkite/emojis@2.0.1009/';
const BUILDKITE_EMOJI_BY_NAME = new Map<string, BuildkiteEmoji>();
function addEmojiEntries(entries: BuildkiteEmoji[]) {
  for (const entry of entries) {
    BUILDKITE_EMOJI_BY_NAME.set(entry.name, entry);
    for (const alias of entry.aliases ?? []) BUILDKITE_EMOJI_BY_NAME.set(alias, entry);
  }
}
addEmojiEntries(appleEmojiEntries as BuildkiteEmoji[]);
addEmojiEntries(emojiEntries as BuildkiteEmoji[]);
const BUILDKITE_EMOJI_RE = /:([a-z0-9][a-z0-9+_-]*):/gi;

function JobTitle({ name }) {
  if (!name) return name;
  const parts = [];
  let offset = 0;
  for (const match of name.matchAll(BUILDKITE_EMOJI_RE)) {
    if (match.index > offset) parts.push(name.slice(offset, match.index));
    const entry = BUILDKITE_EMOJI_BY_NAME.get(match[1].toLowerCase());
    if (!entry) {
      parts.push(match[0]);
    } else {
      parts.push(
        <img
          key={`${match.index}-${match[0]}`}
          src={new URL(entry.image, BUILDKITE_EMOJI_ASSET_BASE).href}
          alt={match[0]}
          title={match[0]}
          draggable={false}
          style={{ display: 'inline-block', width: '13px', height: '13px', objectFit: 'contain', verticalAlign: '-0.15em', margin: '0 1px', lineHeight: 1 }}
        />,
      );
    }
    offset = match.index + match[0].length;
  }
  if (offset === 0) return name;
  if (offset < name.length) parts.push(name.slice(offset));
  return <>{parts}</>;
}


const STATE = {
  passed: { color: '#a6e3a1' },
  running: { color: '#f9e2af' },
  failed: { color: 'var(--bb-danger)' },
  broken: { color: 'var(--bb-danger)' },
  canceled: { color: '#585b70' },
  canceling: { color: '#585b70' },
  scheduled: { color: 'var(--bb-accent)' },
  blocked: { color: '#cba6f7' },
  skipped: { color: '#585b70' },
};
function stateTokens(s) { return STATE[s] || { color: 'var(--bb-muted)' }; }

const STATE_ICON = {
  passed: CircleCheck,
  running: Loader,
  failed: CircleX,
  broken: CircleX,
  canceled: CircleSlash,
  canceling: CircleSlash,
  scheduled: Clock,
  blocked: CirclePause,
  skipped: CircleMinus,
};

function duration(start, end) {
  if (!start || !end) return null;
  const s = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function isScriptJob(job) {
  if (job.soft_failed) return false;
  if (job.state === 'broken' && !job.started_at) return false;
  return job.type === 'script' || (job.name && job.type !== 'trigger' && job.type !== 'waiter');
}

function isFailedJob(job) {
  return job.state === 'failed' || job.state === 'broken' || job.state === 'timed_out';
}
function groupPath(job) {
  const value = job.group_path
    ?? job.groups
    ?? job.group
    ?? job.group_name
    ?? job.group_label
    ?? job.step?.group_path
    ?? job.step?.group
    ?? job.group_key
    ?? job.step?.group_key;
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    if (typeof entry === 'string') return entry.trim() ? [entry.trim()] : [];
    if (!entry || typeof entry !== 'object') return [];
    if (Array.isArray(entry.path)) return groupPath({ group_path: entry.path });
    const label = entry.label ?? entry.name ?? entry.title ?? entry.key;
    return typeof label === 'string' && label.trim() ? [label.trim()] : [];
  });
}

function jobGroup(job) {
  return groupPath(job).join(' / ') || null;
}

async function currentBranch(instance, vcs) {
  if (vcs === 'jj') return nearestBookmark(instance);
  const { stdout } = await exec(instance, ['git', 'branch', '--show-current']);
  const branch = stdout.trim();
  // Colocated jj repos leave Git's HEAD detached even when the working copy
  // has a bookmark. Fall back to jj before deciding there is no branch.
  return branch || nearestBookmark(instance).catch(() => null);
}

async function getRemoteUrl(instance, vcs) {
  if (vcs === 'jj') {
    const { stdout } = await exec(instance, ['jj', 'git', 'remote', 'list']);
    const m = stdout.trim().split('\n')[0]?.match(/^\S+\s+(\S+)/);
    return m?.[1] ?? null;
  }
  const { stdout, exit } = await exec(instance, ['git', 'remote', 'get-url', 'origin']);
  return exit === 0 ? stdout.trim() : null;
}

async function changedPaths(instance, vcs) {
  const commands = vcs === 'jj'
    ? [['jj', 'diff', '--summary']]
    : [
      ['git', 'diff', '--name-only'],
      ['git', 'diff', '--name-only', 'origin/master...HEAD'],
      ['git', 'diff', '--name-only', 'HEAD^', 'HEAD'],
    ];
  const paths = new Set<string>();
  for (const argv of commands) {
    const result = await exec(instance, argv).catch(() => null);
    if (result?.exit !== 0) continue;
    for (const line of (result.stdout ?? '').split('\n')) {
      const path = vcs === 'jj' ? line.replace(/^\S+\s+/, '').trim() : line.trim();
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

async function pipelineRoots(instance, paths) {
  const result = await exec(instance, ['git', 'ls-files', '*/.isc/pipeline.yml', '.isc/pipeline.yml']).catch(() => null);
  if (result?.exit !== 0) return [];
  return (result.stdout ?? '').split('\n')
    .map(file => file.trim().replace(/\/?\.isc\/pipeline\.yml$/, ''))
    .filter(root => root && paths.some(path => path === root || path.startsWith(`${root}/`)));
}

function pipelineSlug(build) {
  return build.pipeline?.slug
    ?? build.pipeline_slug
    ?? build.web_url?.match(/\/([^/]+)\/builds\//)?.[1]
    ?? null;
}

async function resolvePipelines(instance, vcs, branch) {
  const cfg = await exec(instance, ['bk', 'config', 'get', 'pipeline']).catch(() => null);
  if (cfg?.stdout?.trim()) return [cfg.stdout.trim()];

  const grep = await exec(instance, ['grep', '-r', '--include=*.toml', '--include=*.yml',
    '--include=*.yaml', '--include=*.md', '-m1', 'bigband:pipeline', '.']).catch(() => null);
  if (grep?.stdout) {
    const m = grep.stdout.match(/bigband:pipeline\s+(\S+)/);
    if (m) return [m[1]];
  }

  const remoteUrl = await getRemoteUrl(instance, vcs).catch(() => null);
  const repoPath = remoteUrl?.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1];
  const repoName = repoPath?.split('/').pop();
  if (!repoPath || !repoName) return [];

  if (branch) {
    const builds = await exec(instance, [
      'bk', 'build', 'list', '--summary', '--json', '--limit', '50', '--branch', branch,
    ]).catch(() => null);
    if (builds?.exit !== 0) {
      if (NO_AUTH_RE.test(builds?.stderr ?? '')) {
        throw Object.assign(new Error('NO_AUTH'), { code: 'no-auth' });
      }
      return [];
    }
    const list = JSON.parse(builds.stdout);
    if (Array.isArray(list)) {
      const slugs = list.map(pipelineSlug).filter(Boolean);
      const repoSlugs = slugs.filter(slug => slug === repoName || slug.startsWith(`${repoName}-`));
      return [...new Set(repoSlugs)];
    }
  }

  const paths = await changedPaths(instance, vcs);
  const roots = await pipelineRoots(instance, paths);
  const scoredRoots = roots.map((root) => ({
    root,
    score: paths.filter(path => path === root || path.startsWith(`${root}/`)).length,
  })).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score);

  const pipelines = [];
  for (const { root } of scoredRoots) {
    const slug = `${repoName}-${root.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}`;
    const view = await exec(instance, ['bk', 'pipeline', 'view', slug, '--json']).catch(() => null);
    if (view?.exit !== 0) {
      if (NO_AUTH_RE.test(view?.stderr ?? '')) {
        throw Object.assign(new Error('NO_AUTH'), { code: 'no-auth' });
      }
      continue;
    }
    const pipeline = JSON.parse(view.stdout);
    if (pipeline?.slug) pipelines.push(pipeline.slug);
  }
  return [...new Set(pipelines)];
}

function summarizeJobs(jobs) {
  const c = { passed: 0, failed: 0, running: 0, blocked: 0, other: 0 };
  for (const j of jobs) {
    if (!isScriptJob(j)) continue;
    const s = j.state;
    if (s === 'passed') c.passed++;
    else if (isFailedJob(j)) c.failed++;
    else if (s === 'running' || s === 'scheduled') c.running++;
    else if (s === 'blocked') c.blocked++;
    else c.other++;
  }
  return c;
}

// Thin multi-segment progress bar.
function ProgressBar({ counts }) {
  const total = counts.passed + counts.failed + counts.running + counts.blocked + counts.other;
  if (total === 0) return null;
  const pct = (n) => `${(n / total * 100).toFixed(1)}%`;
  return (
    <div style={{ display: 'flex', height: '3px', borderRadius: '2px', overflow: 'hidden', gap: '1px', margin: '4px 0 2px' }}>
      {counts.failed > 0 && <div style={{ width: pct(counts.failed), background: 'var(--bb-danger)' }} />}
      {counts.running > 0 && <div style={{ width: pct(counts.running), background: '#f9e2af' }} />}
      {counts.blocked > 0 && <div style={{ width: pct(counts.blocked), background: '#cba6f7' }} />}
      {counts.passed > 0 && <div style={{ width: pct(counts.passed), background: '#a6e3a1' }} />}
      {counts.other > 0 && <div style={{ width: pct(counts.other), background: 'var(--bb-muted)' }} />}
    </div>
  );
}

function JobRow({ job, instance }) {
  const t = stateTokens(job.state);
  const dur = duration(job.started_at, job.finished_at);
  const open = job.web_url
    ? () => exec(instance, ['open', job.web_url]).catch(() => exec(instance, ['xdg-open', job.web_url]).catch(() => { }))
    : null;
  const Icon = STATE_ICON[job.state] ?? Circle;
  const copyMut = useMutation({
    mutationFn: () => copyJobExcerpt(instance, job),
    onSuccess: () => setTimeout(() => copyMut.reset(), 1500),
  });
  const CopyIcon = copyMut.isSuccess ? Check : Copy;
  return (
    <div
      onClick={open}
      style={{
        display: 'flex', gap: '8px', alignItems: 'center',
        padding: '3px 0', borderBottom: '1px solid #1e1e2e',
        cursor: open ? 'pointer' : 'default',
      }}
    >
      <Icon size={11} color={t.color} strokeWidth={1.5} className={job.state === 'running' ? 'bb-spin' : ''} style={{ flexShrink: 0, display: 'block' }} />
      <span style={{
        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontSize: '11px', color: job.state === 'passed' ? 'var(--bb-muted)' : 'var(--bb-foreground)',
      }} title={job.name}><JobTitle name={job.name} /></span>
      {dur && <span style={{ color: 'var(--bb-muted)', fontSize: '10px', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{dur}</span>}
      {isFailedJob(job) && (
        <ActionTooltip label={copyMut.error ? `copy failed: ${copyMut.error instanceof Error ? copyMut.error.message : String(copyMut.error)}` : 'copy failure excerpt'}>
          <button
            onClick={(e) => { e.stopPropagation(); copyMut.mutate(); }}
            disabled={copyMut.isPending}
            style={{
              background: 'transparent', border: 'none', flexShrink: 0,
              color: copyMut.error ? 'var(--bb-danger)' : copyMut.isSuccess ? 'var(--bb-success)' : 'var(--bb-muted)',
              cursor: copyMut.isPending ? 'default' : 'pointer', padding: '0 2px', display: 'inline-flex',
            }}
            title={copyMut.error ? `copy failed: ${copyMut.error instanceof Error ? copyMut.error.message : String(copyMut.error)}` : 'copy failure excerpt'}
          >
            <CopyIcon size={11} />
          </button>
        </ActionTooltip>
      )}
    </div>
  );
}

function groupJobs(jobs) {
  const sections = new Map();
  const getSection = (g) => {
    let s = sections.get(g);
    if (!s) { s = { entries: [], stepIndex: new Map() }; sections.set(g, s); }
    return s;
  };
  for (const j of jobs) {
    const g = j.group_key || null;
    const section = getSection(g);
    if (j.parallel_group_total > 1 && j.step_key) {
      let shard = section.stepIndex.get(j.step_key);
      if (!shard) {
        shard = { kind: 'shard', stepKey: j.step_key, jobs: [] };
        section.stepIndex.set(j.step_key, shard);
        section.entries.push(shard);
      }
      shard.jobs.push(j);
    } else {
      section.entries.push({ kind: 'single', job: j });
    }
  }
  return [...sections.entries()].map(([groupKey, s]) => ({ groupKey, entries: s.entries }));
}

function shardSummary(jobs) {
  const c = { passed: 0, failed: 0, running: 0, blocked: 0, other: 0 };
  for (const j of jobs) {
    if (j.state === 'passed') c.passed++;
    else if (isFailedJob(j)) c.failed++;
    else if (j.state === 'running' || j.state === 'scheduled') c.running++;
    else if (j.state === 'blocked') c.blocked++;
    else c.other++;
  }
  let state = 'passed';
  if (c.failed) state = 'failed';
  else if (c.running) state = 'running';
  else if (c.blocked) state = 'blocked';
  else if (c.other) state = 'scheduled';
  const starts = jobs.map(j => j.started_at).filter(Boolean).sort();
  const allDone = jobs.every(j => j.finished_at);
  const ends = allDone ? jobs.map(j => j.finished_at).sort() : [];
  return {
    state, counts: c, total: jobs.length,
    start: starts[0] ?? null,
    end: allDone ? ends[ends.length - 1] : null,
  };
}

function ShardRow({ entry, instance, open, onToggle }) {
  const s = shardSummary(entry.jobs);
  const t = stateTokens(s.state);
  const done = s.counts.passed + s.counts.failed;
  const dur = duration(s.start, s.end ?? s.start);
  const sorted = entry.jobs.slice().sort(
    (a, b) => (a.parallel_group_index ?? 0) - (b.parallel_group_index ?? 0),
  );
  return (
    <>
      <div
        onClick={onToggle}
        style={{
          display: 'flex', gap: '8px', alignItems: 'center',
          padding: '3px 0', borderBottom: '1px solid #1e1e2e', cursor: 'pointer',
        }}
      >
        {open ? <ChevronUp size={11} color="#45475a" style={{ flexShrink: 0 }} />
              : <ChevronDown size={11} color="#45475a" style={{ flexShrink: 0 }} />}
        <StateIcon state={s.state} size={11} />
        <span style={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontSize: '11px', color: s.state === 'passed' ? 'var(--bb-muted)' : 'var(--bb-foreground)',
        }} title={entry.stepKey}><JobTitle name={entry.stepKey} /></span>
        <span style={{ color: t.color, fontSize: '10px', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {done}/{s.total}
          {s.counts.failed > 0 && <span style={{ color: 'var(--bb-danger)' }}> · {s.counts.failed}✗</span>}
        </span>
        {dur && <span style={{ color: 'var(--bb-muted)', fontSize: '10px', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{dur}</span>}
      </div>
      {open && (
        <div style={{ paddingLeft: '14px' }}>
          {sorted.map(j => <JobRow key={j.id} job={j} instance={instance} />)}
        </div>
      )}
    </>
  );
}

const CSS = `
  @keyframes bb-spin { to { transform: rotate(360deg); } }
  .bb-spin { display: inline-block; animation: bb-spin 1.2s linear infinite; }
  @keyframes bb-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .bb-pulse { animation: bb-pulse 1.5s ease-in-out infinite; }
`;

function StateIcon({ state, size = 14 }) {
  const t = stateTokens(state);
  const Icon = STATE_ICON[state] ?? Circle;
  return <Icon size={size} color={t.color} strokeWidth={1.5} className={state === 'running' ? 'bb-spin' : ''} style={{ flexShrink: 0, display: 'block' }} />;
}

function ActionTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="bottom" sideOffset={4}>{label}</TooltipContent>
    </Tooltip>
  );
}

// Empty / auth / error placeholder cards.
function PlaceholderCard({ children, onRefresh = null }: { children: any; onRefresh?: (() => void) | null }) {
  return (
      <div style={{
        padding: '8px 10px',
        fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif',
        display: 'flex', alignItems: 'flex-start', gap: '8px',
      }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {children}
        </div>
        {onRefresh && (
          <ActionTooltip label="refresh">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onRefresh}
              style={{ color: 'var(--bb-muted)', padding: 0, lineHeight: 1, flexShrink: 0 }}
              title="refresh"
              aria-label="refresh"
            ><RefreshCw size={13} /></Button>
          </ActionTooltip>
        )}
      </div>
  );
}

// --- query fns (pure async, no hooks) ---

async function fetchContext(instance, vcs) {
  if (vcs !== 'jj') return { repo: '', bookmarks: [], branch: await currentBranch(instance, vcs) };
  const [remoteUrl, log] = await Promise.all([
    getRemoteUrl(instance, vcs),
    exec(instance, ['jj', 'log', '-r', 'reachable(@, mutable())', '--no-graph', '--color', 'never',
      '-T', 'local_bookmarks.map(|b| b.name()).join("\\n") ++ "\\n"']),
  ]);
  if (log.exit !== 0) throw new Error(log.stderr.trim() || `jj exited ${log.exit}`);
  const repo = remoteUrl?.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1] || '';
  const bookmarks = [...new Set(log.stdout.split('\n').map(name => name.trim()).filter(Boolean))];
  return { repo, bookmarks, branch: null };
}

async function fetchBuilds(instance, pipelines, branch) {
  const args = ['bk', 'build', 'list', '--summary', '--json', '--limit', '50'];
  if (pipelines.length === 1) args.push('-p', pipelines[0]);
  args.push('--branch', branch);
  const { stdout, stderr, exit } = await exec(instance, args);
  if (exit !== 0) {
    if (NO_AUTH_RE.test(stderr)) throw Object.assign(new Error('NO_AUTH'), { code: 'no-auth' });
    if (NO_PIPELINE_RE.test(stderr)) throw Object.assign(new Error('NO_PIPELINE'), { code: 'no-pipeline' });
    throw new Error(stderr.trim() || `bk exited ${exit}`);
  }
  const list = JSON.parse(stdout);
  if (!Array.isArray(list)) return pipelines.map(pipeline => ({ pipeline, build: null }));
  return pipelines.map(pipeline => ({
    pipeline,
    build: list.find(build => (pipelineSlug(build) ?? pipeline) === pipeline) ?? null,
  }));
}

async function retryFailedJobs(instance, pipeline, build) {
  const { stderr, exit } = await exec(instance, ['bk', 'api', '--method', 'PUT',
    `/pipelines/${pipeline}/builds/${build.number}/retry_failed_jobs`,
  ]);
  if (exit !== 0) {
    if (NO_AUTH_RE.test(stderr)) throw new Error('Not authenticated (bk needs write_builds scope)');
    throw new Error(stderr.trim() || `bk exited ${exit}`);
  }
}

function groupPathsByKey(steps, parentPath = [], paths = new Map()) {
  for (const step of Array.isArray(steps) ? steps : []) {
    const nested = Array.isArray(step.steps) ? step.steps : Array.isArray(step.children) ? step.children : [];
    const rawLabel = step.group ?? (step.type === 'group' ? step.label ?? step.name : null);
    const label = typeof rawLabel === 'string' ? rawLabel.trim() : rawLabel?.label ?? rawLabel?.name ?? rawLabel?.key ?? null;
    const path = label ? [...parentPath, label] : parentPath;
    const key = step.key ?? step.identifier ?? step.id;
    if (label && key) paths.set(String(key), path);
    if (nested.length) groupPathsByKey(nested, path, paths);
  }
  return paths;
}

function addBuildkiteGroupPaths(build) {
  const groups = groupPathsByKey(build.steps ?? build.pipeline?.steps);
  if (!groups.size || !Array.isArray(build.jobs)) return build;
  return {
    ...build,
    jobs: build.jobs.map((job) => (
      job.group_path || !groups.has(String(job.group_key))
        ? job
        : { ...job, group_path: groups.get(String(job.group_key)) }
    )),
  };
}

async function fetchBuildDetails(instance, pipeline, buildNumber) {
  const primary = await exec(instance, ['bk', 'build', 'view', '--json', '-p', pipeline, String(buildNumber)]);
  if (primary.exit === 0) {
    try {
      return addBuildkiteGroupPaths(JSON.parse(primary.stdout));
    } catch {
      // Fall through to the raw API, which avoids the CLI's typed job decoder.
    }
  }

  const fallback = await exec(instance, ['bk', 'api', `/pipelines/${pipeline}/builds/${buildNumber}`, '--quiet', '--no-pager']);
  if (fallback.exit === 0) {
    try {
      return addBuildkiteGroupPaths(JSON.parse(fallback.stdout));
    } catch {
      // Report the original command error below when neither response is usable.
    }
  }

  const detail = fallback.stderr.trim() || primary.stderr.trim();
  throw new Error(detail || `bk build view exited ${primary.exit}`);
}

async function fetchJobs(instance, pipeline, buildNumber) {
  const full = await fetchBuildDetails(instance, pipeline, buildNumber);
  return (full.jobs ?? []).filter(isScriptJob);
}

const BUILDKITE_TRAILER_RE = /\n(?:🚨\s*)?Error: The command exited with status\b/;

function trimBuildkiteTrailer(output) {
  const match = output.match(BUILDKITE_TRAILER_RE);
  return (match ? output.slice(0, match.index) : output).trim();
}

async function fetchJobExcerpt(instance, job, maxTokens = 1000) {
  const { stdout, stderr, exit } = await exec(instance, [
    'bk', 'job', 'log', job.id,
    '--agent', '--max-tokens', String(maxTokens),
    '--no-timestamps', '--no-pager', '--quiet',
  ]);
  const output = trimBuildkiteTrailer(stdout || stderr);
  if (!output) throw new Error(stderr.trim() || `bk job log exited ${exit}`);
  return output;
}

function rpcString(payload, key) {
  const value = payload?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`ci RPC requires '${key}'`);
  return value.trim();
}

function rpcBuildNumber(payload) {
  const value = payload?.build_number ?? payload?.buildNumber;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error("ci RPC requires a positive 'build_number'");
  return number;
}

function rpcMaxTokens(payload) {
  const value = payload?.max_tokens ?? payload?.maxTokens ?? 1000;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 100 || number > 4000) {
    throw new Error("ci RPC 'max_tokens' must be an integer between 100 and 4000");
  }
  return number;
}

function rpcArtifactMaxBytes(payload) {
  const value = payload?.max_bytes ?? payload?.maxBytes ?? 20_000;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1_000 || number > 100_000) {
    throw new Error("ci RPC 'max_bytes' must be an integer between 1000 and 100000");
  }
  return number;
}

function isTextArtifact(artifact) {
  const mime = String(artifact.mime_type ?? '');
  const path = String(artifact.path ?? '');
  return /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|typescript))/.test(mime)
    || /\.(json|xml|ya?ml|txt|log|md|csv)$/i.test(path);
}

function summarizeJob(job) {
  return {
    id: job.id,
    name: job.name,
    type: job.type,
    step_key: job.step_key ?? null,
    group_key: job.group_key ?? null,
    group: jobGroup(job),
    state: job.state,
    soft_failed: !!job.soft_failed,
    exit_status: job.exit_status ?? null,
    signal: job.signal ?? null,
    signal_reason: job.signal_reason ?? null,
    broken_reason: job.broken_reason ?? null,
    command: job.command ?? null,
    started_at: job.started_at ?? null,
    finished_at: job.finished_at ?? null,
    retried: !!job.retried,
    retried_in_job_id: job.retried_in_job_id ?? null,
    retries_count: job.retries_count ?? null,
    parallel_group_index: job.parallel_group_index ?? null,
    parallel_group_total: job.parallel_group_total ?? null,
    web_url: job.web_url ?? null,
    log_url: job.log_url ?? null,
    artifacts_url: job.artifacts_url ?? job.artifact_url ?? null,
  };
}


function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function rpcCommand(method, instance, payload) {
  return `bigband rpc exec ci.${method} --instance ${shellQuote(instance)} ${shellQuote(JSON.stringify(payload))}`;
}


async function rpcFailedJobExcerpts(payload = {}) {
  const instance = rpcString(payload, 'instance');
  const pipeline = rpcString(payload, 'pipeline');
  const buildNumber = rpcBuildNumber(payload);
  const full = await fetchBuildDetails(instance, pipeline, buildNumber);
  const jobs = (full.jobs ?? []).filter((job) => isScriptJob(job) && isFailedJob(job));
  const maxTokens = rpcMaxTokens(payload);
  const selected = jobs.slice(0, AI_MAX_LOGGED_FAILED_JOBS);
  const excerpts = await Promise.all(selected.map(async (job) => ({
    job: summarizeJob(job),
    excerpt: await fetchJobExcerpt(instance, job, maxTokens),
  })));
  return {
    build_number: buildNumber,
    pipeline,
    excerpts,
    omitted_jobs: Math.max(0, jobs.length - selected.length),
  };
}

async function rpcRetryFailedJobs(payload = {}) {
  const instance = rpcString(payload, 'instance');
  const pipeline = rpcString(payload, 'pipeline');
  const buildNumber = rpcBuildNumber(payload);
  const build = await fetchBuildDetails(instance, pipeline, buildNumber);
  await retryFailedJobs(instance, pipeline, { ...build, number: build.number ?? buildNumber });
  return { pipeline, build_number: buildNumber, status: 'retry_requested' };
}


async function rpcArtifactPreview(payload = {}) {
  const instance = rpcString(payload, 'instance');
  const pipeline = rpcString(payload, 'pipeline');
  const buildNumber = rpcBuildNumber(payload);
  const artifactId = rpcString(payload, 'artifact_id');
  const full = await fetchBuildDetails(instance, pipeline, buildNumber);
  const artifact = (full.artifacts ?? []).find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new Error(`artifact '${artifactId}' is not part of ${pipeline} build ${buildNumber}`);
  if (!isTextArtifact(artifact)) throw new Error(`artifact '${artifact.path}' is not a supported text artifact`);
  const maxBytes = rpcArtifactMaxBytes(payload);
  const tempDir = `/tmp/bigband-ci-${crypto.randomUUID()}`;
  const command = [
    'set -eu',
    `tmp=${shellQuote(tempDir)}`,
    'mkdir -p "$tmp"',
    'trap \'rm -rf "$tmp"\' EXIT',
    'cd "$tmp"',
    `bk artifacts download ${shellQuote(artifact.id)} --build ${buildNumber} -p ${shellQuote(pipeline)} --quiet --no-pager >/dev/null`, 
    `tail -c ${maxBytes} ${shellQuote(artifact.path)}`,
  ].join('; ');
  const { stdout, stderr, exit } = await exec(instance, ['sh', '-lc', command]);
  if (exit !== 0) throw new Error(stderr.trim() || `bk artifacts download exited ${exit}`);
  return {
    artifact: {
      id: artifact.id,
      job_id: artifact.job_id ?? null,
      path: artifact.path,
      mime_type: artifact.mime_type ?? null,
      file_size: artifact.file_size ?? null,
    },
    preview: stdout,
    truncated: Number(artifact.file_size) > maxBytes,
  };
}

registerRPC('failed_job_excerpts', rpcFailedJobExcerpts);
registerRPC('artifact_preview', rpcArtifactPreview);
registerRPC('retry_failed_jobs', rpcRetryFailedJobs);


async function sendFailureSummaryToTerminal(instance, pipeline, build, jobs) {
  const failed = jobs.filter(isFailedJob);
  const lines = [
    `Buildkite build failed: ${pipeline} #${build.number}`,
    `State: ${build.state}`,
    `Branch: ${build.branch ?? 'unknown'}`,
    `Commit: ${build.commit ?? 'unknown'}`,
    '',
    `Failed steps (${failed.length}):`,
  ];
  for (const job of failed) {
    const command = String(job.command ?? '').replace(/\s+/g, ' ').trim();
    const group = jobGroup(job);
    const name = job.name ?? job.step_key ?? job.id;
    lines.push(`- ${group ? `${group} / ` : ''}${name}: ${job.state}${job.exit_status != null ? ` (exit ${job.exit_status})` : ''}`);
    if (job.step_key) lines.push(`  step: ${job.step_key}`);
    if (job.retries_count) lines.push(`  retries reported: ${job.retries_count}`);
    if (command) lines.push(`  command: ${command.length > 240 ? `${command.slice(0, 237)}...` : command}`);
  }
  lines.push('All failed excerpts:', rpcCommand('failed_job_excerpts', instance, { pipeline, build_number: build.number, max_tokens: 1000 }));
  lines.push('Retry failed jobs if the failures look unrelated or flaky:', rpcCommand('retry_failed_jobs', instance, { pipeline, build_number: build.number }));
  await control('terminal.send_text', { text: `${lines.join('\n')}\n` });
}

function redactBuildkiteUrls(value) {
  return String(value).replace(/https?:\/\/(?:www\.)?buildkite\.com\/\S+/gi, '[Buildkite URL omitted]');
}

function compactCommand(value) {
  const command = String(value ?? '').replace(/\s+/g, ' ').trim();
  return command ? `${command.slice(0, 240)}${command.length > 240 ? '...' : ''}` : null;
}


async function createAiFailureSummary(instance, pipeline, build, jobs) {
  const failed = jobs.filter(isFailedJob);
  if (!failed.length) throw new Error('No failed CI steps are available to summarize');

  const selected = failed.slice(0, AI_MAX_LOGGED_FAILED_JOBS);
  const logTokens = Math.min(600, Math.max(250, Math.floor(AI_TOTAL_LOG_TOKENS / selected.length)));
  const excerpts = await Promise.all(selected.map(async (job) => ({
    job: {
      id: job.id,
      name: job.name ?? job.step_key ?? job.id,
      step_key: job.step_key ?? null,
      group_key: job.group_key ?? null,
      group: jobGroup(job),
      state: job.state,
      exit_status: job.exit_status ?? null,
      soft_failed: !!job.soft_failed,
      retries_count: job.retries_count ?? null,
      command: compactCommand(job.command),
    },
    excerpt: redactBuildkiteUrls(await fetchJobExcerpt(instance, job, logTokens)),
  })));
  const context = {
    build: {
      pipeline,
      number: build.number,
      state: build.state,
      branch: build.branch ?? null,
      commit: build.commit ?? null,
      message: build.message ?? null,
    },
    step_counts: summarizeJobs(jobs),
    failed_job_count: failed.length,
    failed_steps: failed.map((job) => ({
      name: job.name ?? job.step_key ?? job.id,
      step_key: job.step_key ?? null,
      group_key: job.group_key ?? null,
      group: jobGroup(job),
      state: job.state,
      exit_status: job.exit_status ?? null,
      soft_failed: !!job.soft_failed,
      retries_count: job.retries_count ?? null,
      command: compactCommand(job.command),
    })),
    failed_groups: [...new Set(failed.map(jobGroup).filter(Boolean))],
  };
  const response = await fetch(AI_GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are a lightweight CI failure analyst. Use only the supplied Buildkite context and logs. Return plain text only: never JSON, code fences, object notation, or machine-readable markers. Treat a Buildkite group as the logical stage and a job name or step key as the individual task. When a group is present, identify failures as "<group> / <task>" and use group names in the opening sentence. The supplied failed_steps list is authoritative: account for every entry, and never report N reasons while listing fewer than N failed jobs. Do not collapse jobs merely because they share a group, command, or error; if the same underlying error affects multiple tasks, name each task under the grouped reason. Start with one direct sentence in this style: "Build #<number> failed in the <step> step for <N> independent reasons:"; if multiple groups or steps failed, name them naturally. Then list every distinct actionable failure an engineer needs to start fixing CI immediately. Scan the supplied logs for independent formatter, linter, typecheck, build, setup, and test failures; do not let test failures crowd out failures from commands such as oxfmt --check. For each failure, include the exact test/file or command, the observed error, expected-versus-actual values when available, and the shortest useful verbatim log excerpt when one is supplied. Group repeated instances of the same failure only when the affected task names are still listed; never merge unrelated failures. Ignore aggregate counts, passed/skipped counts, test-file counts, generic messages such as "see above", suite summaries, wrapper-script steps, and commands that merely orchestrate tests. Mention environment or setup problems only when explicitly evidenced by a missing command, credential, file, or configuration value. Do not speculate about root causes or give generic recommendations. Do not include direct Buildkite URLs or RPC commands.',
        },
        {
          role: 'user',
          content: redactBuildkiteUrls(JSON.stringify({ context, failed_logs: excerpts }, null, 2)),
        },
      ],
      max_tokens: AI_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    }),
  });
  if (!response.ok) {
    const detail = redactBuildkiteUrls((await response.text()).trim());
    throw new Error(`AI summary request failed: ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('AI returned an empty CI summary');
  return raw;
}

async function sendAiFailureSummaryToTerminal(instance, pipeline, build, jobs) {
  const summary = await createAiFailureSummary(instance, pipeline, build, jobs);
  const failed = jobs.filter(isFailedJob);
  const lines = [
    redactBuildkiteUrls(summary),
    '',
    `All failed Buildkite tasks (${failed.length}):`,
  ];
  for (const job of failed) {
    const group = jobGroup(job);
    const name = job.name ?? job.step_key ?? job.id;
    const command = compactCommand(job.command);
    lines.push(`- ${group ? `${group} / ` : ''}${name}${job.step_key ? ` [${job.step_key}]` : ''}${command ? ` — ${command}` : ''}`);
  }
  lines.push('', 'Extra information is available below; use these commands only if needed:');
  lines.push(rpcCommand('failed_job_excerpts', instance, { pipeline, build_number: build.number, max_tokens: 1000 }));
  lines.push('Preview a text artifact after obtaining its artifact id:');
  lines.push(rpcCommand('artifact_preview', instance, { pipeline, build_number: build.number, artifact_id: '<artifact-id>', max_bytes: 20_000 }));
  lines.push('Retry failed jobs if the failures look unrelated or flaky:');
  lines.push(rpcCommand('retry_failed_jobs', instance, { pipeline, build_number: build.number }));
  await control('terminal.send_text', { text: `${lines.join('\n')}\n` });
}

async function copyJobExcerpt(instance, job) {
  await navigator.clipboard.writeText(await fetchJobExcerpt(instance, job));
}

// ---

function PipelineCard({ instance, pipeline, build, branch, onRefresh, isFetching }) {
  const [expanded, setExpanded] = useState(false);
  const [openShards, setOpenShards] = useState<Set<string>>(new Set());
  const needJobs = expanded || build?.state === 'running' || build?.state === 'failed' || build?.state === 'broken';

  const jobsQ = useQuery({
    queryKey: ['instance', instance, 'ci', 'jobs', pipeline, build?.number],
    queryFn: () => fetchJobs(instance, pipeline, build.number),
    enabled: !!instance && !!build && needJobs,
    refetchInterval: (query) => (query.state.data && build?.state === 'running' ? POLL_MS : false),
    gcTime: CACHE_MS,
    refetchOnMount: 'always',
  });

  const jobs = jobsQ.data ?? [];
  const doRefresh = () => { onRefresh(); if (needJobs) jobsQ.refetch(); };

  const openInBrowser = async () => {
    if (!build?.web_url || !instance) return;
    await exec(instance, ['open', build.web_url]).catch(() => exec(instance, ['xdg-open', build.web_url]).catch(() => { }));
  };

  const retryMut = useMutation({
    mutationFn: () => retryFailedJobs(instance, pipeline, build),
    onSuccess: doRefresh,
  });

  const sendLogsMut = useMutation({
    mutationFn: () => sendFailureSummaryToTerminal(instance, pipeline, build, jobs),
  });
  const sendAiSummaryMut = useMutation({
    mutationFn: () => sendAiFailureSummaryToTerminal(instance, pipeline, build, jobs),
    onMutate: () => toast('Summarizing CI failure…', { duration: 3000 }),
    onSuccess: () => toast('AI CI summary sent to focused terminal', { duration: 3000 }),
    onError: (cause) => toast(`AI summary failed: ${cause instanceof Error ? cause.message : String(cause)}`, { duration: 5000 }),
  });


  const font = '-apple-system,BlinkMacSystemFont,sans-serif';

  if (!build) {
    return (
      <PlaceholderCard onRefresh={doRefresh}>
        <p style={{ margin: 0, color: 'var(--bb-muted)', fontSize: '11px' }}>No builds for this branch.</p>
        <p style={{ margin: 0, color: 'var(--bb-muted)', fontSize: '10px', fontFamily: 'ui-monospace,monospace' }}>
          {pipeline}{branch ? ` @ ${branch}` : ''}
        </p>
      </PlaceholderCard>
    );
  }

  const t = stateTokens(build.state);
  const dur = duration(build.started_at, build.finished_at || build.started_at);
  const counts = summarizeJobs(jobs);
  const total = counts.passed + counts.failed + counts.running + counts.blocked + counts.other;
  const isActive = build.state === 'running' || build.state === 'scheduled';

  return (
    <div style={{ fontFamily: font }}>
      <div style={{
        padding: '8px 10px',
        borderBottom: jobs.length > 0 ? '1px solid #313244' : 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <StateIcon state={build.state} size={14} />
            <Badge
              variant={isFailedJob(build) ? 'destructive' : 'outline'}
              style={{ color: t.color, fontSize: '10px', lineHeight: '16px', padding: '0 5px' }}
            >{build.state}</Badge>
            {isActive && <span className="bb-pulse" style={{ color: t.color, fontSize: '10px' }}>live</span>}
            {dur && <span style={{ color: 'var(--bb-muted)', fontSize: '10px', fontVariantNumeric: 'tabular-nums' }}>{dur}</span>}
          </div>
          <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
            <ActionTooltip label="refresh CI status">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={doRefresh}
                style={{ color: isFetching ? 'var(--bb-border)' : 'var(--bb-muted)' }}
                title="refresh"
                aria-label="refresh"
              ><RefreshCw size={13} /></Button>
            </ActionTooltip>
            <ActionTooltip label="open build in browser">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={openInBrowser}
                style={{ color: 'var(--bb-muted)' }}
                title={build.web_url}
                aria-label="open build in browser"
              ><ExternalLink size={13} /></Button>
            </ActionTooltip>
          </div>
        </div>
      </div>

      {jobsQ.error && (
        <div style={{ padding: '6px 10px 8px', color: 'var(--bb-danger)', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
            jobs unavailable: {jobsQ.error instanceof Error ? jobsQ.error.message : String(jobsQ.error)}
          </span>
          <ActionTooltip label="retry loading jobs">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => jobsQ.refetch()}
              style={{ color: 'var(--bb-danger)', flexShrink: 0 }}
              aria-label="retry loading jobs"
            ><RefreshCw size={11} /></Button>
          </ActionTooltip>
        </div>
      )}

      {jobs.length > 0 && (
        <div style={{ padding: '6px 10px 8px' }}>
          <ProgressBar counts={counts} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{ color: 'var(--bb-muted)', fontSize: '10px' }}>
              {counts.passed}/{total} passed
              {counts.failed > 0 && (
                <span style={{ color: 'var(--bb-danger)' }}> · {counts.failed} failed
                  <ActionTooltip label="retry failed jobs">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => retryMut.mutate()}
                      disabled={retryMut.isPending}
                      style={{ color: retryMut.isPending ? 'var(--bb-muted)' : 'var(--bb-danger)', padding: '0 2px', verticalAlign: 'middle' }}
                      title="retry failed"
                      aria-label="retry failed"
                    ><RotateCcw size={10} className={retryMut.isPending ? 'bb-spin' : ''} /></Button>
                  </ActionTooltip>
                  <ActionTooltip label="send raw CI failure details to focused terminal">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => sendLogsMut.mutate()}
                      disabled={sendLogsMut.isPending}
                      style={{ color: sendLogsMut.isPending ? 'var(--bb-muted)' : 'var(--bb-danger)', padding: '0 2px', verticalAlign: 'middle' }}
                      title="send CI failure summary to focused terminal"
                      aria-label="send CI failure summary to focused terminal"
                    ><Terminal size={10} /></Button>
                  </ActionTooltip>
                  <ActionTooltip label="send AI CI failure summary to focused terminal">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => sendAiSummaryMut.mutate()}
                      disabled={sendAiSummaryMut.isPending}
                      style={{ color: sendAiSummaryMut.isPending ? 'var(--bb-muted)' : 'var(--bb-accent)', padding: '0 2px', verticalAlign: 'middle' }}
                      title="send AI CI failure summary to focused terminal"
                      aria-label="send AI CI failure summary to focused terminal"
                    ><Sparkles size={10} /></Button>
                  </ActionTooltip>

                </span>
              )}
              {counts.running > 0 && <span style={{ color: '#f9e2af' }}> · {counts.running} running</span>}
            </span>
            <ActionTooltip label={expanded ? 'collapse jobs' : 'expand jobs'}>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setExpanded((e) => !e)}
                style={{ color: 'var(--bb-muted)', fontSize: '10px', padding: '0 2px', height: 'auto', gap: '2px' }}
                aria-label={expanded ? 'collapse jobs' : 'expand jobs'}
              >
                {expanded ? <><ChevronUp size={11} /> collapse</> : <>jobs <ChevronDown size={11} /></>}
              </Button>
            </ActionTooltip>
          </div>
          {retryMut.error && (
            <div style={{ color: 'var(--bb-danger)', fontSize: '10px', marginBottom: '4px', wordBreak: 'break-word' }}>
              retry failed: {retryMut.error instanceof Error ? retryMut.error.message : String(retryMut.error)}
            </div>
          )}
          {sendAiSummaryMut.error && (
            <div style={{ color: 'var(--bb-danger)', fontSize: '10px', marginBottom: '4px', wordBreak: 'break-word' }}>
              AI summary failed: {sendAiSummaryMut.error instanceof Error ? sendAiSummaryMut.error.message : String(sendAiSummaryMut.error)}
            </div>
          )}
          {expanded && (
            <div style={{ marginTop: '4px' }}>
              {groupJobs(jobs).map((section) => (
                <div key={section.groupKey ?? '__none__'}>
                  {section.groupKey && (
                    <div style={{
                      color: 'var(--bb-muted)', fontSize: '10px',
                      textTransform: 'uppercase', letterSpacing: '0.5px',
                      margin: '6px 0 2px',
                    }}>{section.groupKey}</div>
                  )}
                  {section.entries.map((entry) => {
                    if (entry.kind === 'single') {
                      return <JobRow key={entry.job.id} job={entry.job} instance={instance} />;
                    }
                    const k = `${section.groupKey ?? ''}::${entry.stepKey}`;
                    return (
                      <ShardRow
                        key={k}
                        entry={entry}
                        instance={instance}
                        open={openShards.has(k)}
                        onToggle={() => setOpenShards((prev) => {
                          const next = new Set(prev);
                          if (next.has(k)) next.delete(k); else next.add(k);
                          return next;
                        })}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!jobsQ.error && jobs.length === 0 && (build.state === 'running' || build.state === 'failed' || build.state === 'broken') && (
        <div style={{ padding: '6px 10px 8px' }}>
          <button onClick={() => setExpanded(true)} style={{
            background: 'transparent', border: '1px solid #313244', color: 'var(--bb-muted)',
            cursor: 'pointer', fontSize: '10px', padding: '4px 10px', borderRadius: '4px', width: '100%',
          }}>
            load jobs
          </button>
        </div>
      )}
    </div>
  );
}

function BranchCi({ instance, vcs, branch }) {

  const metaQ = useQuery({
    queryKey: ['instance', instance, 'ci', 'meta', vcs, branch],
    queryFn: () => resolvePipelines(instance, vcs, branch),
    enabled: !!instance,
    staleTime: 60_000,
    gcTime: CACHE_MS,
    refetchOnMount: 'always',
  });

  const pipelines = metaQ.data ?? [];

  const buildQ = useQuery({
    queryKey: ['instance', instance, 'ci', 'builds', pipelines, branch],
    queryFn: () => fetchBuilds(instance, pipelines, branch),
    enabled: !!instance && pipelines.length > 0 && !!branch,
    refetchInterval: POLL_MS,
    gcTime: CACHE_MS,
    refetchOnMount: 'always',
  });

  useHostEvent('instance.changed', () => { metaQ.refetch(); buildQ.refetch(); }, { debounce: 750 });

  const builds = buildQ.data ?? [];

  if (!instance) return null;

  if (metaQ.isPending) {
    return <PlaceholderCard><span className="bb-pulse" style={{ color: 'var(--bb-muted)', fontSize: '11px' }}>loading…</span></PlaceholderCard>;
  }

  if (metaQ.isError) {
    const { code, message } = metaQ.error as { code?: string; message: string };
    if (code === 'no-auth') {
      return (
        <PlaceholderCard onRefresh={() => metaQ.refetch()}>
          <p style={{ margin: 0, color: 'var(--bb-muted)', fontSize: '11px' }}>
            Run <code style={{ color: 'var(--bb-foreground)', background: '#181825', padding: '1px 4px', borderRadius: '3px' }}>bk auth login</code>
          </p>
        </PlaceholderCard>
      );
    }
    return (
      <PlaceholderCard onRefresh={() => metaQ.refetch()}>
        <pre style={{ margin: 0, color: 'var(--bb-danger)', fontSize: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{message}</pre>
      </PlaceholderCard>
    );
  }

  if (!pipelines.length) {
    return <PlaceholderCard><p style={{ margin: 0, color: 'var(--bb-muted)', fontSize: '11px' }}>No Buildkite pipeline found.</p></PlaceholderCard>;
  }

  if (!branch) {
    return (
      <PlaceholderCard onRefresh={() => metaQ.refetch()}>
        <p style={{ margin: 0, color: 'var(--bb-muted)', fontSize: '11px' }}>No branch found for this working copy.</p>
      </PlaceholderCard>
    );
  }

  if (buildQ.isError) {
    const { code, message } = buildQ.error as { code?: string; message: string };
    if (code === 'no-auth') {
      return (
        <PlaceholderCard onRefresh={() => buildQ.refetch()}>
          <p style={{ margin: 0, color: 'var(--bb-muted)', fontSize: '11px' }}>
            Run <code style={{ color: 'var(--bb-foreground)', background: '#181825', padding: '1px 4px', borderRadius: '3px' }}>bk auth login</code>
          </p>
        </PlaceholderCard>
      );
    }
    if (code === 'no-pipeline') {
      return <PlaceholderCard><p style={{ margin: 0, color: 'var(--bb-muted)', fontSize: '11px' }}>No Buildkite pipeline found.</p></PlaceholderCard>;
    }
    return (
      <PlaceholderCard onRefresh={() => buildQ.refetch()}>
        <pre style={{ margin: 0, color: 'var(--bb-danger)', fontSize: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{message}</pre>
      </PlaceholderCard>
    );
  }

  if (buildQ.isPending) {
    return <PlaceholderCard><span className="bb-pulse" style={{ color: 'var(--bb-muted)', fontSize: '11px' }}>loading…</span></PlaceholderCard>;
  }

  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' }}>
      <style>{CSS}</style>
      {builds.map(({ pipeline, build }) => (
        <PipelineCard
          key={pipeline}
          instance={instance}
          pipeline={pipeline}
          build={build}
          branch={branch}
          onRefresh={() => buildQ.refetch()}
          isFetching={buildQ.isFetching}
        />
      ))}
    </div>
  );
}

export default function Ci() {
  const { instance, vcs } = usePanel();
  const contextQ = useQuery({
    queryKey: ['instance', instance, 'ci', 'context', vcs],
    queryFn: () => fetchContext(instance, vcs),
    enabled: !!instance,
    gcTime: CACHE_MS,
    refetchOnMount: 'always',
  });
  const { rows, error } = useCollection<CiPr>(PR, PR_QUERY, {
    vars: { repo: contextQ.data?.repo || '' },
  });
  useHostEvent('instance.changed', () => { contextQ.refetch(); }, { debounce: 750 });

  if (!instance) return null;
  if (contextQ.isPending) return <PlaceholderCard>loading…</PlaceholderCard>;
  if (contextQ.isError) return <PlaceholderCard onRefresh={() => contextQ.refetch()}>{contextQ.error.message}</PlaceholderCard>;
  if (vcs !== 'jj') return <BranchCi instance={instance} vcs={vcs} branch={contextQ.data.branch} />;
  if (error) return <PlaceholderCard>{error}</PlaceholderCard>;
  if (!rows) return <PlaceholderCard>loading PRs…</PlaceholderCard>;

  const prs = stackPrs(contextQ.data.bookmarks, rows);
  if (!prs.length) return <PlaceholderCard>No open PRs found for this stack.</PlaceholderCard>;
  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' }}>
      {prs.map(pr => (
        <section key={`${contextQ.data.repo}#${pr.number}`} style={{ borderBottom: '1px solid var(--bb-border)' }}>
          <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <a href={pr.url} target="_blank" rel="noreferrer" style={{ color: 'var(--bb-foreground)', fontSize: '11px', textDecoration: 'none' }}>
              #{pr.number} {pr.title}
            </a>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', fontSize: '10px', color: 'var(--bb-muted)' }}>
              <span style={{ overflowWrap: 'anywhere', fontFamily: 'ui-monospace,monospace' }}>{pr.head_ref}</span>
              <Badge variant="outline" title="Aggregate PR checks, not Buildkite-only" style={{ fontSize: '10px', flexShrink: 0 }}>
                {pr.checks_state ? `checks: ${pr.checks_state.toLowerCase()}` : 'no checks'}
              </Badge>
            </div>
          </div>
          <BranchCi instance={instance} vcs={vcs} branch={pr.head_ref} />
        </section>
      ))}
    </div>
  );
}
