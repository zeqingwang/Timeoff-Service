# Human submission checklist

Use this before you submit an assignment to catch what graders often look for and improve your score.

## Requirements and scope

- [ ] Re-read the assignment prompt and tick every bullet (features, files to touch, forbidden changes, report format).
- [ ] If a rubric exists, map each criterion to something in your repo (commit, test, or doc) and note any gaps.
- [ ] Confirm you did not edit excluded files (e.g. attached plan files or instructions the grader forbade changing).

## Runs that graders expect

- [ ] **Install**: From a clean state (optional: delete `node_modules`), `npm ci` or `npm install` succeeds.
- [ ] **Build**: `npm run build` (or the documented build command) exits 0.
- [ ] **Lint**: If the project has `npm run lint`, run it and fix or justify any failures you leave in.
- [ ] **Unit tests**: `npm test` — all green; no skipped tests you were supposed to implement.
- [ ] **E2E**: If required, `npm run test:e2e` — all green.
- [ ] **Coverage**: If mentioned, `npm run test:cov` — note totals; ensure new or changed code is exercised, not only the global percentage.

## Quality of the solution

- [ ] **Happy path**: Main user story works (manual smoke: documented `start:dev` + curl or Postman if applicable).
- [ ] **Error paths**: Required failures use the correct status codes and messages (e.g. 503 vs 502 vs 404).
- [ ] **Edge cases**: Idempotency and edge cases from the spec are covered by tests, or briefly noted in your write-up if explicitly out of scope.

## Repo hygiene

- [ ] **No secrets**: No API keys, real credentials in `.env`, or tokens in the repo; use `.env.example` only if allowed.
- [ ] **No junk**: Remove stray `console.log`, debug-only files, and accidental TODOs in critical paths unless the assignment wants them.
- [ ] **Git**: Commits are meaningful (or one clear final commit); the commit message matches what you actually changed.

## What you submit

- [ ] Submit exactly what they asked (zip, repo link, branch name, PDF report) — double-check portal fields.
- [ ] If you include a README section or report: spell-check; include **how to run** and **what you implemented** in your own words.
- [ ] If the assignment is paired or grouped: your contribution is obvious in commit history or the report if required.

## Last pass (about 10 minutes)

- [ ] Run `npm test` again from a clean terminal in the project root.
- [ ] Open the assignment prompt one more time and ask: *Would a tired grader see that I did X?* If not, add one sentence to the README or report.

---

*Tailor this list to your deliverables (e.g. GitHub only vs GitHub + PDF). Remove sections that do not apply.*
