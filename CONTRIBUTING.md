# Contributing to DMLand

Thanks for helping. DMLand is intentionally small: Node 24, **zero npm dependencies**, SQLite via
`node:sqlite`, and a single-file vanilla JS dashboard. Please keep it that way.

## Setup

```bash
git clone https://github.com/<you>/dmland.git
cd dmland
npm test        # runs all tests, no Meta account needed
npm start       # http://localhost:3000
```

## Ground rules

- **No dependencies.** If a change needs a package, open an issue first.
- **Tests must pass** (`npm test`). Add a test for any behavior you change in `src/`.
- **Never commit secrets** or real user data. Tests use fake names and a throwaway database.
- Keep changes small and focused: one concern per pull request.
- Write user-visible text in English and wrap it so it can be translated (plain text in the markup, or `T('text')` / T-tagged templates in code). New texts need an entry in `public/lang/es.json`; `npm test` tells you what is missing. See [docs/LANGUAGES.md](docs/LANGUAGES.md).

## Pull requests

1. Fork and create a branch from `main`.
2. Make your change and run `npm test`.
3. Open a pull request describing what changed and why. Screenshots help for UI changes
   (use demo data only, never a real account).
