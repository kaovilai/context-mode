---
on:
  issues:
    types: [labeled]
  # explicit cron, not `schedule: hourly`: the fuzzy form scatters to a different
  # cron minute on every compile, so the committed lock file can never match what
  # the Agentic Workflow Lock Files check compiles. A non-round minute keeps the
  # load-scattering intent.
  schedule: "47 * * * *"
  workflow_dispatch:
    inputs:
      issue_number:
        description: "The fork-sync issue to reconcile"
        required: false
        type: string
permissions:
  copilot-requests: write
  contents: read
  issues: read
  pull-requests: read
tools:
  edit:
  bash: ["git", "node", "npm", "npx", "ls", "cat", "echo", "mkdir", "rm"]
  github:
    toolsets: [repos, issues, pull_requests]
network:
  allowed:
    - defaults
    - github
    - node
safe-outputs:
  create-pull-request:
    title-prefix: "[fork-sync] "
    labels: [fork-sync]
    draft: false
    max: 2
  add-comment:
    max: 3
  close-issue:
---

# Fork rebase reconciler

Reconcile the fork's `main` with upstream when the daily `fork-sync` rebase hits conflicts.

## When to act

This workflow runs hourly, on demand, and when an issue gets a label. Act only when there is
an OPEN issue labeled `fork-sync` in this repository (the `fork-sync` workflow opens it when a
rebase conflicted; the hourly run exists because an issue created by a workflow's own
`GITHUB_TOKEN` triggers no `labeled` event). If the dispatch input names an issue number, use
that one. No open `fork-sync`-labeled issue: do nothing, say nothing.

## What to do

1. In the repository workspace, run:
   ```bash
   git fetch --unshallow origin || git fetch origin
   git remote add upstream https://github.com/mksglu/context-mode.git
   git fetch upstream main
   git checkout -B reconcile origin/main
   git rebase upstream/main
   ```
   The `--unshallow` fetch matters: the workspace starts at depth 1, and a rebase from a
   shallow tip cannot find the fork's merge base or replay its commits.
2. If the rebase reports conflicts, resolve each one. The fork's history is: upstream's
   commits, plus a small set of fork-only changes — the shared HTTP daemon
   (`src/entries/daemon.ts`, `src/entries/server-core.ts`, ADR-0026 and its tests), the
   hooks-only plugin install, and fork-only workflow/test adjustments. Resolution rule:
   **keep the fork's intent on top of upstream's latest changes** — take upstream's version
   of everything upstream owns, and re-apply the fork's additions around it. Never delete a
   fork-only file; never re-add something upstream removed. When both sides changed the same
   line (for example a version bump in `package.json`), take the NEWER upstream version.
3. Finish the rebase (`git rebase --continue` per commit; the git identity in the workspace
   is already configured).
4. Prove the result:
   ```bash
   npm install
   node build/build.mjs --generated-only
   npx tsc --noEmit
   CONTEXT_MODE_DAEMON_PORT=0 node --test tests/*.test.mjs
   ```
   The `--generated-only` step is required: `src/prompt/_generated.ts` is git-ignored and
   `npm install` does not create it, but `src/entries/server-core.ts` imports it. If some
   tests fail only for timing on the loaded runner, re-run the failing file once before
   concluding. Do not create a pull request from a tree whose typecheck or tests fail —
   instead add a comment on the issue saying exactly what failed and stop.
5. Create a pull request (safe output `create-pull-request`) titled
   `[fork-sync] reconciled rebase onto upstream/main` with a body listing: the upstream
   HEAD sha rebased onto, the fork commits replayed, and every conflict path with a
   one-line note on how it was resolved.
6. Close the issue with a one-line comment naming the pull request. The next daily
   `fork-sync` run validates that pull request's head tree with the unit suite and adopts
   it as one commit on upstream/main.

## Hard limits

- Never force-push or push to `main` directly; the pull request is the only output channel.
- Never modify `.github/workflows/fork-sync.yml` or this file.
- If `git rebase upstream/main` reports nothing to do (upstream already contained), close
  the issue with a comment saying so.
