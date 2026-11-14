# Languages

DMLand's dashboard is written in **English**. English is the base language and always works.
Every other language is one small file in `public/lang/`. DMLand ships with **Spanish** (`es.json`)
as a complete example, and you can add any language in minutes, with or without an AI agent.

## Use a language

Open the dashboard → **Settings → Interface language** and pick one. The choice is remembered in your browser.

Only the dashboard's menus, buttons and help texts change. Your messages, replies, keywords, names and
saved data are never translated.

## Add a language

1. Copy `public/lang/es.json` to `public/lang/<code>.json`. The code is a language code such as `fr`, `pt-BR` or `de`.
2. Set `"name"` to the language's own name (for example `"Français"`). That is what the language picker shows.
3. Translate the **values** in the three sections. Never change the keys or the regular expressions.

   | Section | What it holds | Example |
   |---|---|---|
   | `dict` | Exact English text → translation. `{0}`, `{1}` are values the dashboard inserts: keep them. | `"{0} send errors in {1}": "{0} errores de envío en {1}"` |
   | `patterns` | `[regex, template]` for text with numbers or names. `$1` inserts a captured value, `$t1` a captured value that is translated too. | `["^(\\d+) min ago$", "hace $1 min"]` |
   | `events` | Same as `patterns`, for the lines of the Activity log. Unknown lines stay in English. | `["^Connected @(.+)$", "Conectada @$1"]` |

4. Two entries are the **default DMs** that the editor pre-fills for "ask for email first" (the long texts starting with
   `Hi {{username}}!` and `Hmm, that does not look like an email`). Translate them into the language your followers speak.
   Keep `{{username}}`.
5. Run `npm test`. It checks that every placeholder survived and that no dashboard text is missing.
6. Reload the dashboard and pick the language in Settings.

Anything you leave out simply shows in English.

## With an AI agent

[AGENTS.md](../AGENTS.md) tells Claude Code, Codex and similar agents to do steps 1 to 6 for you: they ask which
language you want, create the file, translate it, run the tests and report what they changed.

## Contribute a language

Translations are welcome as pull requests. Add your `public/lang/<code>.json`, make sure `npm test` passes,
and mention who reviewed the translation.
