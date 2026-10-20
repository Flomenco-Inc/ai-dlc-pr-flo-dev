# PR Review GitHub Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the GitHub provider to reply in a review thread, submit one formal pull-request review, and resolve or unresolve a review thread.

**Architecture:** Add three methods on `lambda/shared/git-providers/github.js`, next to the existing `addPRComment` and GraphQL draft toggle. Callers pass an already-minted token. This plan does not add webhooks, the review worker, or UI.

**Tech Stack:** Node.js ESM, Vitest, GitHub REST, GitHub GraphQL.

## Global Constraints

- Phase 1 provider is GitHub only.
- Phase 1 is review-only: these methods post reviews and thread updates, and they do not push commits.
- Every bot body this feature posts ends with `<!-- aidlc-pr-review -->`.
- Formal verdicts are `COMMENT`, `REQUEST_CHANGES`, or `APPROVE`.
- Resolve and unresolve apply only to thread ids the caller passes. This module does not decide ownership.

## Later plans

This spec is four independently testable plans. This file is plan 1 only.

| Plan | Deliverable |
| --- | --- |
| 1. This file | GitHub reply, submit-review, resolve, unresolve |
| 2. Webhook ingress | HMAC, delivery dedupe, PR mirror, FIFO enqueue, phase-1 AIDLC filter |
| 3. Review worker | Debounce, lock, `pr-review-start`, approve policy, Discussion escalation |
| 4. PR/Review UI | `/space/:projectId/reviews`, project policy controls, retry |

## File structure

- Modify: `lambda/shared/git-providers/github.js` — new methods and exports
- Modify: `lambda/shared/git-providers.js` — contract comment lists the new methods
- Modify: `lambda/shared/test/git-providers.test.js` — fetch-double tests
- Create: `lambda/shared/pr-review-marker.js` — the marker string
- Create: `lambda/shared/test/pr-review-marker.test.js`

---

### Task 1: Review marker

**Files:**
- Create: `lambda/shared/pr-review-marker.js`
- Test: `lambda/shared/test/pr-review-marker.test.js`

**Interfaces:**
- Consumes: none
- Produces: `PR_REVIEW_MARKER` (`'<!-- aidlc-pr-review -->'`), `withPrReviewMarker(body: string) => string`, `hasPrReviewMarker(body: string) => boolean`

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it } from 'vitest';
import { PR_REVIEW_MARKER, hasPrReviewMarker, withPrReviewMarker } from '../pr-review-marker.js';

describe('pr-review-marker', () => {
  it('appends the marker once', () => {
    expect(withPrReviewMarker('Please rename this.')).toBe(
      `Please rename this.\n\n${PR_REVIEW_MARKER}`,
    );
    expect(withPrReviewMarker(`Already marked.\n\n${PR_REVIEW_MARKER}`)).toBe(
      `Already marked.\n\n${PR_REVIEW_MARKER}`,
    );
  });

  it('detects the marker', () => {
    expect(hasPrReviewMarker(`note\n${PR_REVIEW_MARKER}`)).toBe(true);
    expect(hasPrReviewMarker('human note')).toBe(false);
    expect(hasPrReviewMarker('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project=shared lambda/shared/test/pr-review-marker.test.js`

Expected: FAIL with `Cannot find module '../pr-review-marker.js'`

- [ ] **Step 3: Write the minimal implementation**

```js
export const PR_REVIEW_MARKER = '<!-- aidlc-pr-review -->';

export const hasPrReviewMarker = (body) => String(body ?? '').includes(PR_REVIEW_MARKER);

export const withPrReviewMarker = (body) => {
  const text = String(body ?? '').trimEnd();
  if (hasPrReviewMarker(text)) return text;
  return `${text}\n\n${PR_REVIEW_MARKER}`;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project=shared lambda/shared/test/pr-review-marker.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lambda/shared/pr-review-marker.js lambda/shared/test/pr-review-marker.test.js
git commit -m "feat: add the PR review comment marker"
```

---

### Task 2: Reply in a review thread

**Files:**
- Modify: `lambda/shared/git-providers/github.js`
- Modify: `lambda/shared/test/git-providers.test.js`
- Modify: `lambda/shared/git-providers.js` contract comment

**Interfaces:**
- Consumes: `ghFetch`, `splitOwnerRepo`, `ProviderError`, `withPrReviewMarker`
- Produces: `replyToReviewComment(ctx, repoId, commentId, { body }) => { id, body, url, createdAt }`

- [ ] **Step 1: Write the failing test**

Add this inside `describe('github provider — repo browse + PR + comments')` in `lambda/shared/test/git-providers.test.js`:

```js
it('replies in a review thread and stamps the marker', async () => {
  const fetchImpl = makeFetch([
    [
      '/comments/42/replies',
      {
        json: {
          id: 99,
          body: 'Fixed in the latest commit.\n\n<!-- aidlc-pr-review -->',
          html_url: 'https://github.com/o/r/pull/7#discussion_r99',
          created_at: '2026-10-16T00:00:00Z',
        },
      },
    ],
  ]);
  const reply = await gh.replyToReviewComment({ token: 't', fetchImpl }, 'o/r', 7, {
    commentId: 42,
    body: 'Fixed in the latest commit.',
  });
  expect(reply).toEqual({
    id: 99,
    body: 'Fixed in the latest commit.\n\n<!-- aidlc-pr-review -->',
    url: 'https://github.com/o/r/pull/7#discussion_r99',
    createdAt: '2026-10-16T00:00:00Z',
  });
  const call = fetchImpl.calls[0];
  expect(call.url).toBe('https://api.github.com/repos/o/r/pulls/7/comments/42/replies');
  expect(call.options.method).toBe('POST');
  expect(JSON.parse(call.options.body)).toEqual({
    body: 'Fixed in the latest commit.\n\n<!-- aidlc-pr-review -->',
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project=shared lambda/shared/test/git-providers.test.js -t "replies in a review thread"`

Expected: FAIL with `replyToReviewComment is not a function`

- [ ] **Step 3: Write the minimal implementation**

In `lambda/shared/git-providers/github.js`, import the marker and add:

```js
import { withPrReviewMarker } from '../pr-review-marker.js';

const replyToReviewComment = async (ctx, repoId, prNumber, { commentId, body }) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: withPrReviewMarker(body) }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ProviderError(res.status || 400, data?.message || 'Failed to reply to review comment');
  }
  return {
    id: data.id,
    body: data.body,
    url: data.html_url || null,
    createdAt: data.created_at,
  };
};
```

Add `replyToReviewComment` to both export lists at the bottom of `github.js`.

In the contract comment in `lambda/shared/git-providers.js`, add:

```js
//   replyToReviewComment(ctx, repoId, prRef, { commentId, body }) -> GitComment
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project=shared lambda/shared/test/git-providers.test.js -t "replies in a review thread"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lambda/shared/git-providers/github.js lambda/shared/git-providers.js lambda/shared/test/git-providers.test.js
git commit -m "feat: reply to a GitHub review thread"
```

---

### Task 3: Submit a pull request review

**Files:**
- Modify: `lambda/shared/git-providers/github.js`
- Modify: `lambda/shared/test/git-providers.test.js`
- Modify: `lambda/shared/git-providers.js`

**Interfaces:**
- Consumes: `withPrReviewMarker`, `ProviderError`
- Produces: `submitPullRequestReview(ctx, repoId, prNumber, { event, body, comments }) => { id, event, body, url }`
- `event` is `COMMENT`, `REQUEST_CHANGES`, or `APPROVE`
- `comments` is `[{ path, line, side, body }]`. Each comment body is marker-stamped. The summary body is marker-stamped.

- [ ] **Step 1: Write the failing test**

```js
it('submits one pull request review with stamped comments', async () => {
  const fetchImpl = makeFetch([
    [
      '/pulls/7/reviews',
      {
        json: {
          id: 5,
          state: 'CHANGES_REQUESTED',
          body: 'Needs a null check.\n\n<!-- aidlc-pr-review -->',
          html_url: 'https://github.com/o/r/pull/7#pullrequestreview-5',
        },
      },
    ],
  ]);
  const review = await gh.submitPullRequestReview({ token: 't', fetchImpl }, 'o/r', 7, {
    event: 'REQUEST_CHANGES',
    body: 'Needs a null check.',
    comments: [{ path: 'src/a.js', line: 10, side: 'RIGHT', body: 'Check null.' }],
  });
  expect(review).toEqual({
    id: 5,
    event: 'CHANGES_REQUESTED',
    body: 'Needs a null check.\n\n<!-- aidlc-pr-review -->',
    url: 'https://github.com/o/r/pull/7#pullrequestreview-5',
  });
  expect(JSON.parse(fetchImpl.calls[0].options.body)).toEqual({
    event: 'REQUEST_CHANGES',
    body: 'Needs a null check.\n\n<!-- aidlc-pr-review -->',
    comments: [
      {
        path: 'src/a.js',
        line: 10,
        side: 'RIGHT',
        body: 'Check null.\n\n<!-- aidlc-pr-review -->',
      },
    ],
  });
});

it('rejects an unknown review event before calling GitHub', async () => {
  const fetchImpl = makeFetch([]);
  await expect(
    gh.submitPullRequestReview({ token: 't', fetchImpl }, 'o/r', 7, {
      event: 'MAYBE',
      body: 'no',
    }),
  ).rejects.toThrow(/COMMENT, REQUEST_CHANGES, or APPROVE/);
  expect(fetchImpl.calls).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project=shared lambda/shared/test/git-providers.test.js -t "pull request review"`

Expected: FAIL with `submitPullRequestReview is not a function`

- [ ] **Step 3: Write the minimal implementation**

```js
const REVIEW_EVENTS = new Set(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']);

const submitPullRequestReview = async (ctx, repoId, prNumber, { event, body, comments = [] }) => {
  if (!REVIEW_EVENTS.has(event)) {
    throw new ProviderError(400, 'Review event must be COMMENT, REQUEST_CHANGES, or APPROVE');
  }
  const { owner, repo } = splitOwnerRepo(repoId);
  const payload = {
    event,
    body: withPrReviewMarker(body),
  };
  if (comments.length > 0) {
    payload.comments = comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side || 'RIGHT',
      body: withPrReviewMarker(comment.body),
    }));
  }
  const res = await ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ProviderError(res.status || 400, data?.message || 'Failed to submit pull request review');
  }
  return {
    id: data.id,
    event: data.state,
    body: data.body,
    url: data.html_url || null,
  };
};
```

Export `submitPullRequestReview` from `github.js`. Add the contract line:

```js
//   submitPullRequestReview(ctx, repoId, prRef, { event, body, comments? }) -> { id, event, body, url }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project=shared lambda/shared/test/git-providers.test.js -t "pull request review"`

Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add lambda/shared/git-providers/github.js lambda/shared/git-providers.js lambda/shared/test/git-providers.test.js
git commit -m "feat: submit a GitHub pull request review"
```

---

### Task 4: Resolve and unresolve a review thread

**Files:**
- Modify: `lambda/shared/git-providers/github.js`
- Modify: `lambda/shared/test/git-providers.test.js`
- Modify: `lambda/shared/git-providers.js`

**Interfaces:**
- Consumes: GraphQL via `ghFetch`, same pattern as `setPullRequestDraft`
- Produces: `setReviewThreadResolved(ctx, repoId, threadId, resolved: boolean) => { threadId, resolved }`
- `repoId` is validated and otherwise unused, matching `setPullRequestDraft`. `threadId` is the GraphQL node id (`PRRT_...`).

- [ ] **Step 1: Write the failing test**

```js
it('resolves and unresolves a review thread', async () => {
  const fetchImpl = makeFetch([
    [
      '/graphql',
      (url, options) => {
        const query = JSON.parse(options.body).query;
        return {
          json: {
            data: query.includes('resolveReviewThread')
              ? { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } }
              : { unresolveReviewThread: { thread: { id: 'PRRT_1', isResolved: false } } },
          },
        };
      },
    ],
  ]);
  await expect(
    gh.setReviewThreadResolved({ token: 't', fetchImpl }, 'o/r', 'PRRT_1', true),
  ).resolves.toEqual({ threadId: 'PRRT_1', resolved: true });
  await expect(
    gh.setReviewThreadResolved({ token: 't', fetchImpl }, 'o/r', 'PRRT_1', false),
  ).resolves.toEqual({ threadId: 'PRRT_1', resolved: false });
  const first = JSON.parse(fetchImpl.calls[0].options.body);
  expect(first.query).toContain('resolveReviewThread');
  expect(first.variables).toEqual({ id: 'PRRT_1' });
});

it('surfaces a GraphQL thread error', async () => {
  const fetchImpl = makeFetch([['/graphql', { json: { errors: [{ message: 'Thread not found' }] } }]]);
  await expect(
    gh.setReviewThreadResolved({ token: 't', fetchImpl }, 'o/r', 'PRRT_missing', true),
  ).rejects.toThrow(/Thread not found/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project=shared lambda/shared/test/git-providers.test.js -t "review thread"`

Expected: FAIL with `setReviewThreadResolved is not a function`

- [ ] **Step 3: Write the minimal implementation**

```js
const setReviewThreadResolved = async (ctx, repoId, threadId, resolved) => {
  splitOwnerRepo(repoId);
  const operation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  const mutation = `mutation($id:ID!){${operation}(input:{threadId:$id}){thread{id isResolved}}}`;
  const res = await ghFetch(ctx, `${API_BASE}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: mutation, variables: { id: threadId } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.errors?.length) {
    throw new ProviderError(
      res.status || 400,
      data?.errors?.[0]?.message || 'Failed to update review thread',
    );
  }
  const thread = data?.data?.[operation]?.thread;
  return { threadId: thread?.id || threadId, resolved: Boolean(thread?.isResolved) };
};
```

Export `setReviewThreadResolved`. Add the contract line:

```js
//   setReviewThreadResolved(ctx, repoId, threadId, resolved) -> { threadId, resolved }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project=shared lambda/shared/test/git-providers.test.js -t "review thread"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lambda/shared/git-providers/github.js lambda/shared/git-providers.js lambda/shared/test/git-providers.test.js
git commit -m "feat: resolve and unresolve a GitHub review thread"
```

---

## Self-review

- Spec coverage for this plan: reply, formal review (`COMMENT` / `REQUEST_CHANGES` / `APPROVE`), resolve/unresolve, marker footer. Webhook, mirror, worker, approve policy, UI, and commits are in later plans.
- Placeholder scan: none.
- Type consistency: `replyToReviewComment(ctx, repoId, prNumber, { commentId, body })`, `submitPullRequestReview(ctx, repoId, prNumber, { event, body, comments })`, `setReviewThreadResolved(ctx, repoId, threadId, resolved)`.
