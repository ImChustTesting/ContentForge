# Contributing

ContentForge is a labor of love. The maintainer's bandwidth is finite. Read this before opening a large PR.

## Scope guard

The manifesto (`PROJECT_MANIFESTO_OSS.md`) is the contract. Before proposing a feature, check it. If it's in §4 ("what PROJECT_NAME does NOT do"), the answer is no — we'll close the PR with a link to the section. Examples that **will** be closed without a long discussion:

- Auto-publishing to IG / LinkedIn / TikTok.
- Built-in voice cloning, dubbing, or DAW-style multi-track editing.
- Hosted SaaS tier or paid features.
- Telemetry or "anonymous usage" pings (even opt-in is a no for v1).
- Browser-extension or mobile clients.

Things we **will** consider, in rough priority order:

- Active-speaker detection in GENERAL mode.
- Alternate LLM providers behind a `LLM_PROVIDER` env var.
- Caption-style picker UI.
- A real `MAX_SOURCE_MINUTES` lift via chunked transcription.
- GPU opt-in for users who have one.
- MinIO-as-storage path that is properly tested.

When in doubt, open an issue first and ask.

## Local setup

```bash
git clone https://github.com/ImChustTesting/ContentForge.git
cd ContentForge
cp .env.example .env

# Generate the three required secrets and paste them into .env.
openssl rand -hex 16  # POSTGRES_PASSWORD
openssl rand -hex 32  # SESSION_SECRET
openssl rand -hex 32  # ENCRYPTION_KEY

docker compose up --build
```

Open <http://localhost:3000> and run the setup wizard.

For pure dashboard work without Docker:

```bash
cd app
npm install
DATABASE_URL=... SESSION_SECRET=... ENCRYPTION_KEY=... node --watch src/index.js
```

For worker work, you'll want the actual ffmpeg / Python deps on your host. Easier path: keep the worker in Docker and develop the app side natively.

## Code style

- **Node:** ESM, top-level await, no TypeScript build step. Prefer `pino` over `console.log`. Parameterized SQL only.
- **Python:** stdlib + the pinned packages in `requirements.txt`. No build wheels at runtime. Prefer `argparse` over click.
- **HTML:** Handlebars partials in `app/src/views/`. Vanilla JS for interactivity (no React, no build step). HTMX for server interactions.
- **CSS:** one `style.css` in `app/src/public/`. Custom properties for theming, no preprocessor.
- **Comments:** explain *why*, not *what*. The code already says what.

## Testing

- **Unit tests:** `npm test` in `app/` or `worker/`. Keep total runtime under 30 seconds.
- **Integration:** spin up the docker-compose stack and run the smoke test:
  ```bash
  cd worker && npm run test:smoke
  ```
- A PR should add tests for any new pure-logic surface (prefilter heuristics, smoothing math, schema validation). UI changes are exempted but a screenshot in the PR is appreciated.

## PR checklist

- [ ] One topic per PR. "Fix typo + add feature X" gets split.
- [ ] Tests added or updated where it makes sense.
- [ ] No new external service dependencies. If you add one, it must be optional.
- [ ] No new secrets in env without a paragraph in `SECURITY.md` about the threat model.
- [ ] No version bumps to `pg-boss`, `@anthropic-ai/sdk`, or `mediapipe` without verifying the smoke test still passes — these have load-bearing API surface for us.

## Maintainer expectations

This is an open-source project run by one person on the side. Acknowledgement of a PR may take a week. Merging may take longer. Please don't take silence personally.

The two responses you may get on a feature PR:
1. "This fits, with these changes." — we work through review together.
2. "This is out of scope per manifesto §X." — we close, with a link.

## License

All contributions are licensed under MIT. By submitting a PR you agree to this.
