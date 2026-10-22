# Squares Duel development

- Canonical source: this GitHub repository, `squares-duel-src/`, on `main`.
- Make game changes inside `squares-duel-src/`. Preserve the personal homepage and unrelated root directories.
- `squares-duel/` contains generated Pages output. The Squares Duel workflow rebuilds it from source, runs tests and publishes the website. Do not hand-edit generated assets.
- Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run build:pages` inside `squares-duel-src/` when the changes require them.
- Keep credentials, sessions, account data, database files, local match records, dependencies and runtime state out of Git.
- Production API and its existing database remain on the Sites project identified by `squares-duel-src/.openai/hosting.json`. Follow `squares-duel-src/DEPLOYMENT.md` for backend releases from GitHub source; preserve its project ID, audience and live data.
- An older Sites source checkout is a deployment mirror. GitHub is authoritative; never develop a second divergent source copy there.
