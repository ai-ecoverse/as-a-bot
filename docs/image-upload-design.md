# Design: `gh image` — Image/Video Uploads for Coding Agents

## Problem

`gh` on its own cannot attach images to a PR or issue
([cli/cli#12960](https://github.com/cli/cli/issues/12960)). GitHub's
user-attachments upload endpoint is not exposed via the API, so coding agents
that want to include a screenshot or screen recording in a PR description have
no sanctioned path. The existing workaround,
[gh-image](https://github.com/drogers0/gh-image), drives a remote-controlled
browser through the web UI — heavyweight, brittle, and hard to run headless.

This design provides a different approach: content-addressed uploads to a
Cloudflare R2 bucket, brokered by the as-a-bot Worker, and gated by a GitHub
Actions workflow that only repository maintainers can dispatch. Installing the
as-a-bot GitHub App is the only setup: the app commits the workflow to the
repository automatically, and the repository needs **no secrets**.

## Goals

- `gh image <file>` returns a stable, serveable URL for an image or video that
  can be embedded in PR/issue Markdown.
- Zero per-repo configuration beyond installing the GitHub App: no secrets,
  no manual workflow copying.
- Upload capability is gated on repository write access (the same bar as
  pushing code), enforced by GitHub itself.
- Content-addressed storage: the same file uploaded twice yields the same URL,
  and a URL can never silently change content.
- Bounded storage: uploads expire after 90 days; re-uploading the same file
  renews it at the same URL.

## Non-goals

- Attaching files to GitHub's own `user-images`/`user-attachments` CDN (no API
  exists — that is the premise of the problem).
- Access control on *reads*. Serve URLs are public (but unguessable without
  the content hash for private content).

## Architecture

Three components, mirroring the mcpecrets pattern (Worker for compute, GitHub
Actions for the trust boundary):

1. **`gh image` command** (ai-aligned-gh wrapper) — computes the content hash,
   dispatches the workflow, polls the Worker, uploads the file.
2. **`image-upload.yml` workflow** — a thin, secret-free authorization relay,
   committed to each repo automatically by the app on installation
   (`app-install.js`; canonical copy in `workflow-template.js`, mirrored in
   [`templates/image-upload.yml`](../templates/image-upload.yml) for manual
   installs). GitHub enforces that only users with write access can dispatch
   it; its OIDC token proves *which repository* is asking.
3. **as-a-bot Worker** — verifies the OIDC token, **mints the pre-signed R2
   PUT URL itself** (`r2-presign.js`, no dependencies) using R2 credentials
   that live only as Worker secrets, stores it briefly in KV, and serves
   uploaded objects from R2.

```
as-a-bot app installed on owner/repo
   │ webhook: installation created / repos added
   ▼
Worker POST /webhook ──► commits .github/workflows/image-upload.yml
                          (installation token; skips if file exists)

gh image shot.png
   │
   │ 1. sha256(file) = <hash>
   │ 2. gh workflow run image-upload.yml -f hash=<hash> -f ext=png
   ▼                                  (requires write access — GitHub enforces)
GitHub Actions (target repo, no secrets)
   │ 3. POST /image-upload/offer {hash, ext}   (Bearer: GitHub OIDC token)
   ▼
as-a-bot Worker
   │ 4. derive owner/repo from OIDC `repository` claim
   │ 5. pre-sign PUT https://<account>.r2.cloudflarestorage.com/<bucket>/
   │       <owner>/<repo>/<hash>.png  (x-amz-checksum-sha256 signed in)
   │ 6. KV: offer:<owner>/<repo>/<hash>.png  (TTL ≤ 15 min)
   ▲                                                │
   │ 7. GET /image-upload/status?...  (poll)        │
   │    → { status: "ready", upload_url, ... }      │
gh image                                            │
   │ 8. PUT file → pre-signed R2 URL                │
   ▼                                                ▼
R2 bucket: <owner>/<repo>/<hash>.png ◄──── 9. GET /i/<owner>/<repo>/<hash>.png
                                             (served by Worker, immutable,
                                              expires after 90 days)
```

### Flow in detail

1. `gh image shot.png` computes `hash = SHA-256(file)` (hex) and derives the
   extension from the filename.
2. **Dedupe check**: `HEAD /i/<owner>/<repo>/<hash>.png` — if the object
   already exists (content-addressed), print the URL and stop.
3. `gh workflow run image-upload.yml -f hash=<hash> -f ext=png` in the target
   repo. Owner/repo come from the working directory or `--repo`. Under an AI
   tool the dispatch uses the as-a-bot user-to-server token, so the run is
   attributed like every other write in the wrapper.
4. The workflow job validates its inputs, requests a GitHub OIDC token
   (`id-token: write`, audience `as-a-bot-images`), and POSTs
   `{hash, ext}` to `/image-upload/offer`. That is all it does — it holds no
   credentials and receives back only the serve URL (never the upload URL,
   which must not appear in publicly readable run logs).
5. The Worker verifies the OIDC token (signature against GitHub's JWKS,
   issuer, audience, expiry) and derives `owner/repo` **from the token's
   `repository` claim** — coordinates cannot be spoofed. It mints a pre-signed
   `PUT <bucket>/<owner>/<repo>/<hash>.<ext>` URL (SigV4 query auth,
   15-minute expiry) with **`x-amz-checksum-sha256` as a signed header**, and
   stores the offer in KV keyed `offer:<owner>/<repo>/<hash>.<ext>` with a
   matching TTL.
6. `gh image` polls `GET /image-upload/status?owner=&repo=&hash=&ext=` (every
   3 s, default timeout 180 s):
   - `202 {"status":"pending"}` — workflow hasn't reported yet,
   - `200 {"status":"ready", upload_url, upload_headers, serve_url}`,
   - `200 {"status":"uploaded", serve_url}` — object already in R2.
7. `gh image` PUTs the file to `upload_url` with the returned headers
   (`x-amz-checksum-sha256: <base64 hash>` + `Content-Type`). R2 rejects the
   upload if the body doesn't match the signed checksum.
8. `gh image` verifies `HEAD <serve_url>` succeeds and prints the serve URL.
   With a wildcard serve domain configured (`IMAGE_SERVE_DOMAIN`), that is
   `https://<repo>--<owner>.<domain>/<hash>.<ext>` — GitHub's Camo image
   proxy is reluctant about `*.workers.dev` hosts, and hostname-based URLs
   are cleaner to embed. Path-based
   `https://<worker>/i/<owner>/<repo>/<hash>.<ext>` always works as a
   fallback (and is what repos with non-hostname-safe names — dots,
   underscores — get). Owner names cannot contain `--` (GitHub rule), so
   the last `--` in the host label is always the separator; keys are
   lowercased since GitHub names are case-insensitively unique.

## Worker API

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/webhook` | POST | HMAC (`X-Hub-Signature-256`) | App installation events → auto-commit the workflow |
| `/image-upload/offer` | POST | GitHub Actions OIDC (aud `as-a-bot-images`) | Workflow requests a pre-signed upload URL |
| `/image-upload/status` | GET | none | Client polls for the upload URL / upload state |
| `/i/{owner}/{repo}/{hash}.{ext}` | GET, HEAD | none | Serve the stored object (immutable caching) |
| `https://{repo}--{owner}.<IMAGE_SERVE_DOMAIN>/{hash}.{ext}` | GET, HEAD | none | Hostname-based serving on the wildcard domain (same objects) |

Offer payload (owner/repo come from the OIDC token, never the body):

```json
{ "hash": "<64 hex chars>", "ext": "png", "expires_in": 900 }
```

The Worker validates hash format and the extension allowlist (`png jpg jpeg
gif webp svg avif mp4 mov webm`), and responds with `{status, serve_url}`
only.

## Storage layout & bindings

- **R2 bucket** (`IMAGES` binding, bucket `as-a-bot-images`):
  objects at `<owner>/<repo>/<hash>.<ext>`. Content-addressed and immutable.
- **KV** (`IMAGE_OFFERS` binding): transient offers at
  `offer:<owner>/<repo>/<hash>.<ext>`, TTL-bounded (60 s–1 h, default 15 min).
- **Worker secrets**: `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (S3
  credentials used only for pre-signing; never leave the Worker),
  `GITHUB_WEBHOOK_SECRET`, plus the existing `GITHUB_APP_ID` /
  `GITHUB_APP_PRIVATE_KEY` used to mint installation tokens for the
  workflow auto-install.

## Upload lifetime (90-day TTL)

Uploads are kept for 90 days, enforced in two layers:

1. **Serve-time enforcement (Worker)**: objects older than 90 days
   (`uploaded` timestamp from R2) are refused with `410 Gone` and deleted on
   access; the status endpoint stops reporting them as `uploaded`, so a
   re-run of `gh image` transparently re-uploads and renews the same URL.
   `Cache-Control: max-age` is capped at the object's remaining lifetime.
2. **Storage reclamation (R2 lifecycle rule)**: a bucket lifecycle rule
   deletes objects 90 days after creation even if they are never requested
   again. Set once with:
   ```sh
   npx wrangler r2 bucket lifecycle add as-a-bot-images --name expire-uploads --expire-days 90
   ```

Embedded Markdown images older than 90 days therefore break unless renewed —
that is the intended trade-off for bounded storage. Re-running
`gh image <same file>` restores the identical URL.

## Trust model

| Threat | Mitigation |
|--------|-----------|
| Arbitrary users minting upload URLs | Offers require a GitHub Actions OIDC token, and only users with **write access** can dispatch `workflow_dispatch` — GitHub enforces this. |
| Spoofed coordinates (uploading into another repo's namespace) | `owner/repo` are derived exclusively from the OIDC token's `repository` claim, which GitHub controls. |
| Stolen upload URL (workflow inputs are visible to anyone with read access on public repos, so the poll coordinates are not secret) | The pre-signed URL has `x-amz-checksum-sha256` in its signed headers: it can **only** upload content matching the requested hash. Worst case, an attacker uploads the identical bytes the maintainer was about to upload. The upload URL is also never returned to the workflow (run logs are readable), only via the status endpoint. |
| Content swap after publication | Keys are content-addressed; the serve path refuses objects whose stored R2 SHA-256 checksum is missing or does not match the hash in the key. URLs are immutable for their lifetime. |
| Credential blast radius | R2 credentials exist in exactly one place: Worker secrets. Repositories hold no secrets at all. Compromising a repo yields nothing; compromising a workflow run yields at most checksum-bound upload URLs for that repo's own namespace. |
| Forged webhook (tricking the Worker into committing workflows) | `/webhook` verifies `X-Hub-Signature-256` (HMAC over the raw body with the app's webhook secret) before acting; the auto-install also never overwrites an existing workflow file. |
| SVG script execution | Served with `X-Content-Type-Options: nosniff` and a restrictive `Content-Security-Policy` (and GitHub proxies embedded images through Camo anyway). |

## Alternatives considered

- **Browser automation (gh-image)**: works, but needs a full browser, user
  session cookies, and breaks whenever the web UI changes.
- **Workflow pre-signs the URL itself (R2 credentials as Actions secrets)**:
  the initial design. Rejected because it puts cloud credentials in every
  participating repo (painful to onboard, wide blast radius: any repo holding
  the credentials can write any key in the shared bucket) and requires manual
  setup. With the Worker minting URLs, repos need zero secrets and writes are
  confined to the calling repo's own prefix.
- **Client uploads through the Worker (no pre-signed URL)**: simplest, but
  Workers cap request bodies well below R2's 5 GB single-PUT limit, which
  matters for videos; direct-to-R2 also keeps large transfers off the Worker.
- **Repo-committed uploads (orphan branch / git LFS)**: pollutes history,
  size limits, and `raw.githubusercontent.com` is not a good video host.

## Setup

### Repository (one-time)

Install the [as-a-bot app](https://github.com/apps/as-a-bot) on the
repository. The app commits `.github/workflows/image-upload.yml`
automatically. That's it — no secrets, no variables.

(Manual alternative: copy
[`templates/image-upload.yml`](../templates/image-upload.yml) to
`.github/workflows/image-upload.yml`.)

### GitHub App (operator, one-time)

- Webhook URL: `https://<worker>/webhook`, with a webhook secret
  (`GITHUB_WEBHOOK_SECRET`).
- Subscribe to **Installation** events.
- Repository permissions: **Contents: Read & write**, **Workflows: Read &
  write** (required to commit workflow files).

### Worker (operator, one-time)

```sh
wrangler r2 bucket create as-a-bot-images
wrangler r2 bucket lifecycle add as-a-bot-images --name expire-uploads --expire-days 90
```

Deployment itself is CI-driven (`.github/workflows/deploy.yml`): every push
to `main` runs the tests, syncs `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` /
`GH_WEBHOOK_SECRET` from Actions secrets into Worker secrets (the last one
lands as `GITHUB_WEBHOOK_SECRET` — Actions secret names may not start with
`GITHUB_`), and runs `wrangler deploy` (authenticated by the
`CLOUDFLARE_TOKEN` Actions secret).
The bindings are declared in `wrangler.toml` (`IMAGES`, `IMAGE_OFFERS`) along
with the `R2_ACCOUNT_ID` / `R2_BUCKET` / `IMAGE_OIDC_AUDIENCE` vars.

For embeddable hostname-based URLs, put a zone on the Cloudflare account and
set in `wrangler.toml`:

```toml
IMAGE_SERVE_DOMAIN = "img.example.com"
routes = [ { pattern = "*.img.example.com/*", zone_name = "example.com" } ]
```

(A `*.img.example.com` wildcard DNS record proxied through Cloudflare makes
the route resolve; the worker then serves
`https://<repo>--<owner>.img.example.com/<hash>.<ext>`.)

## Limitations / future work

- First upload of a file pays GitHub Actions queue latency (typically
  10–30 s). Re-uploads of known content are instant (dedupe via HEAD) —
  until they expire.
- Uploads expire after 90 days (see above); embedded URLs must be renewed by
  re-running `gh image` on the same file if they should outlive that.
- No file-size limit is enforced beyond R2's single-PUT limit (~5 GB);
  a `size` workflow input with a signed `content-length-range` could be added.
