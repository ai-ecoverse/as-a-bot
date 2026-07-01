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
Actions workflow that only repository maintainers can dispatch.

## Goals

- `gh image <file>` returns a stable, serveable URL for an image or video that
  can be embedded in PR/issue Markdown.
- No GitHub credentials or cloud credentials on the client beyond what `gh`
  already has.
- Upload capability is gated on repository write access (the same bar as
  pushing code), enforced by GitHub itself.
- Content-addressed storage: the same file uploaded twice yields the same URL,
  and a URL can never silently change content.

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
2. **`image-upload.yml` workflow** (committed to each participating repo,
   template in [`templates/image-upload.yml`](../templates/image-upload.yml)) —
   holds the R2 credentials as Actions secrets, pre-signs a checksum-bound PUT
   URL, and registers it with the Worker. GitHub enforces that only users with
   write access can dispatch it.
3. **as-a-bot Worker** — temporary mailbox for pre-signed URLs (KV, short TTL)
   and permanent serve path for uploaded objects (R2 binding).

```
gh image shot.png
   │
   │ 1. sha256(file) = <hash>
   │ 2. gh workflow run image-upload.yml -f hash=<hash> -f ext=png
   ▼                                  (requires write access — GitHub enforces)
GitHub Actions (target repo)
   │ 3. pre-sign PUT https://<account>.r2.cloudflarestorage.com/<bucket>/
   │       <owner>/<repo>/<hash>.png  (x-amz-checksum-sha256 signed in)
   │ 4. POST /image-upload/offer  (Bearer: GitHub OIDC token)
   ▼
as-a-bot Worker ──── KV: offer:<owner>/<repo>/<hash>.png  (TTL ≤ 15 min)
   ▲                                                │
   │ 5. GET /image-upload/status?...  (poll)        │
   │    → { status: "ready", upload_url, ... }      │
gh image                                            │
   │ 6. PUT file → pre-signed R2 URL                │
   ▼                                                ▼
R2 bucket: <owner>/<repo>/<hash>.png ◄──── 7. GET /i/<owner>/<repo>/<hash>.png
                                                (served by Worker, immutable)
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
4. The workflow job:
   - validates `hash`/`ext` inputs,
   - pre-signs `PUT <bucket>/<owner>/<repo>/<hash>.<ext>` with the AWS SDK
     against the R2 S3 endpoint, **including `x-amz-checksum-sha256` as a
     signed header** (15-minute expiry),
   - requests a GitHub OIDC token (`id-token: write`) with audience
     `as-a-bot-images`,
   - `POST /image-upload/offer` to the Worker with the pre-signed URL, the
     required upload headers, and the coordinates.
5. The Worker verifies the OIDC token (signature against GitHub's JWKS,
   issuer, audience, expiry) and that the token's `repository` claim matches
   the posted `owner/repo`, then stores the offer in KV keyed
   `offer:<owner>/<repo>/<hash>.<ext>` with a TTL matching the URL expiry.
6. `gh image` polls `GET /image-upload/status?owner=&repo=&hash=&ext=` (every
   3 s, default timeout 180 s):
   - `202 {"status":"pending"}` — workflow hasn't reported yet,
   - `200 {"status":"ready", upload_url, upload_headers, serve_url}`,
   - `200 {"status":"uploaded", serve_url}` — object already in R2.
7. `gh image` PUTs the file to `upload_url` with the returned headers
   (`x-amz-checksum-sha256: <base64 hash>` + `Content-Type`). R2 rejects the
   upload if the body doesn't match the signed checksum.
8. `gh image` verifies `HEAD <serve_url>` succeeds and prints the serve URL:
   `https://<worker>/i/<owner>/<repo>/<hash>.<ext>`.

## Worker API

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/image-upload/offer` | POST | GitHub Actions OIDC (aud `as-a-bot-images`) | Workflow registers a pre-signed upload URL |
| `/image-upload/status` | GET | none | Client polls for the upload URL / upload state |
| `/i/{owner}/{repo}/{hash}.{ext}` | GET, HEAD | none | Serve the stored object (immutable caching) |

Offer payload:

```json
{
  "owner": "ai-ecoverse", "repo": "as-a-bot",
  "hash": "<64 hex chars>", "ext": "png",
  "upload_url": "https://<account>.r2.cloudflarestorage.com/...",
  "upload_headers": { "x-amz-checksum-sha256": "<base64>" },
  "expires_in": 900
}
```

The Worker validates: hash format, extension allowlist (`png jpg jpeg gif webp
svg avif mp4 mov webm`), `upload_url` host must be `*.r2.cloudflarestorage.com`,
and OIDC `repository` claim == `owner/repo`.

## Storage layout & bindings

- **R2 bucket** (`IMAGES` binding, bucket `as-a-bot-images`):
  objects at `<owner>/<repo>/<hash>.<ext>`. Content-addressed and immutable.
- **KV** (`IMAGE_OFFERS` binding): transient offers at
  `offer:<owner>/<repo>/<hash>.<ext>`, TTL-bounded (60 s–1 h, default 15 min).

## Trust model

| Threat | Mitigation |
|--------|-----------|
| Arbitrary users minting upload URLs | Only the target repo's workflow can register offers (OIDC `repository` claim), and only users with **write access** can dispatch `workflow_dispatch` — GitHub enforces this. |
| Forged offers (attacker POSTs a malicious `upload_url`) | Offer endpoint requires a valid GitHub OIDC token for the exact repo; `upload_url` host is restricted to R2. |
| Stolen upload URL (workflow inputs are visible to anyone with read access on public repos, so the poll coordinates are not secret) | The pre-signed URL has `x-amz-checksum-sha256` in its signed headers: it can **only** upload content matching the requested hash. Worst case, an attacker uploads the identical bytes the maintainer was about to upload. |
| Content swap after publication | Keys are content-addressed; the serve path re-checks the stored R2 SHA-256 checksum against the hash in the key and refuses to serve mismatches. URLs are immutable. |
| Credential blast radius | R2 credentials live only as Actions secrets in participating repos (mcpecrets pattern) and never reach the client or the Worker. Note: any repo holding the credentials can write any key in the shared bucket — use per-org buckets/credentials if org-level isolation matters. |
| SVG script execution | Served with `X-Content-Type-Options: nosniff` and a restrictive `Content-Security-Policy` (and GitHub proxies embedded images through Camo anyway). |

## Alternatives considered

- **Browser automation (gh-image)**: works, but needs a full browser, user
  session cookies, and breaks whenever the web UI changes.
- **Worker mints the pre-signed URL directly (client → Worker with OIDC-less
  auth)**: fewer moving parts, but the Worker would need R2 credentials plus
  its own notion of "who may upload to owner/repo" — reimplementing GitHub's
  permission model. Dispatching a workflow delegates the maintainer check to
  GitHub, and keeps the Worker credential-free (mcpecrets showed this pattern
  works well).
- **Repo-committed uploads (orphan branch / git LFS)**: pollutes history,
  size limits, and `raw.githubusercontent.com` is not a good video host.

## Repo setup (one-time, per repo)

1. Install the [as-a-bot app](https://github.com/apps/as-a-bot) (for AI
   attribution of the dispatch; optional for human use).
2. Copy [`templates/image-upload.yml`](../templates/image-upload.yml) to
   `.github/workflows/image-upload.yml`.
3. Add Actions secrets (repo- or org-level): `R2_ACCOUNT_ID`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (an R2 API token scoped to
   object writes on the bucket). Optional Actions variables: `R2_BUCKET`
   (default `as-a-bot-images`), `AS_A_BOT_URL` (default
   `https://as-bot-worker.minivelos.workers.dev`).

## Worker setup (one-time, operator)

```sh
wrangler r2 bucket create as-a-bot-images   # bucket for uploads
wrangler kv namespace create IMAGE_OFFERS   # transient offer mailbox
wrangler deploy
```

The bindings are declared in `wrangler.toml` (`IMAGES`, `IMAGE_OFFERS`) and
the OIDC audience via the `IMAGE_OIDC_AUDIENCE` var.

## Limitations / future work

- First upload of a file pays GitHub Actions queue latency (typically
  10–30 s). Re-uploads of known content are instant (dedupe via HEAD).
- No garbage collection; content-addressed objects are kept forever. An R2
  lifecycle rule can cap this if needed.
- No file-size limit is enforced beyond R2's single-PUT limit (~5 GB);
  a `size` workflow input with a signed `content-length-range` could be added.
