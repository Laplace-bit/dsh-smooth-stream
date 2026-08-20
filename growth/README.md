# Growth operations

This directory keeps promotion work measurable and reproducible. It is not a
list of vanity targets: every channel should lead a relevant DeepSeek Harness
user to a useful page, installation, issue, or contribution.

## Current baseline

Captured on 2026-08-20 after publishing v0.3.4:

- GitHub: 39 stars, 3 forks.
- GitHub traffic: 152 unique visitors and 149 unique cloners in the latest
  available 14-day window.
- npm: 937 downloads in the latest complete seven-day API window
  (2026-08-12 through 2026-08-18; all downloads began after launch).
- Community: 3 open issues, 3 closed issues, and 1 external pull request.

These windows are not directly comparable. The automated snapshot records the
window dates so later reviews do not mistake cumulative and rolling metrics.

## Files

- `metrics.csv`: daily GitHub and npm snapshot, maintained by the workflow.
- `distribution.csv`: one row per real submission or publication.
- `directory-list.md`: researched directories and submission status.
- `content/`: final platform-specific drafts, not generic cross-posts.

## UTM convention

Use links to the project site rather than adding tracking parameters to every
GitHub URL:

```text
https://laplace-bit.github.io/dsh-smooth-stream/install.html?utm_source=SOURCE&utm_medium=MEDIUM&utm_campaign=launch-2026-08&utm_content=SLUG
```

Allowed values:

| Field | Examples |
| --- | --- |
| `utm_source` | `hackernews`, `reddit`, `v2ex`, `juejin`, `producthunt`, `devto` |
| `utm_medium` | `community`, `directory`, `article`, `social` |
| `utm_campaign` | `launch-2026-08`, then a stable release or content campaign name |
| `utm_content` | short lowercase identifier such as `show-hn` or `install-guide` |

## Weekly review

Every seven days:

1. Compare the newest snapshot with the previous week.
2. Attribute traffic only when a published URL and its date are recorded.
3. Look beyond stars: npm downloads, unique cloners, issues, PRs, and concrete
   feedback are stronger signals of real adoption.
4. Continue channels that produce relevant visits or conversations. Stop
   repeating posts that only produce impressions.
5. Turn recurring questions and verified bugs into the next tutorial, FAQ, or
   engineering article.

## Search discovery

The Pages site exposes `robots.txt`, `sitemap.xml`, `llms.txt`, and an
IndexNow key file. After publishing a meaningful documentation update, submit
only the changed public URLs to:

```text
https://api.indexnow.org/indexnow
```

Use host `laplace-bit.github.io`, key
`91308c16da931ad66f272c523113180e`, and key location
`https://laplace-bit.github.io/dsh-smooth-stream/91308c16da931ad66f272c523113180e.txt`.

Run a local snapshot with a GitHub token that has push access:

```sh
GITHUB_REPOSITORY=Laplace-bit/dsh-smooth-stream \
GITHUB_TOKEN="$(gh auth token)" \
node scripts/capture-growth-metrics.mjs
```
