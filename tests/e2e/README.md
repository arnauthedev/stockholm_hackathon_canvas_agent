# E2E regression harness

Runs scenarios against an **isolated runner** (port 18790, a fresh copy of `templates/agent-home`, the built app), so it never touches `agent-home/` or a dev stack you have running.

```bash
bash tests/e2e/run.sh                         # all scenarios (~4 min; voice uses TTS + GPT-Live, a few cents)
bash tests/e2e/run.sh --tags=tool,ui          # fast: no model calls
bash tests/e2e/run.sh --tags=tool,text,ui     # no email/voice
bash tests/e2e/run.sh --only="brain-dump"     # by name
bash tests/e2e/run.sh --compare=tests/e2e/results/<main-run>.json   # FIXED / REGRESSED vs another run
```

- **Tags:**
  - `tool`: deterministic, no model calls.
  - `text`: the text brain.
  - `ui`: headless Chrome as the phone.
  - `email`: an Ethereal test mailbox, created per run, with sending enabled only in the isolated runner.
  - `voice`: TTS-generated speech as a fake microphone, real GPT-Live.
- **Results:** saved in `tests/e2e/results/` (gitignored). Spoken audio is cached in `.cache/`.
- **Model variance:** text and voice scenarios depend on the model's behaviour, so a single failure may be variance. Rerun with `--only` before concluding a regression.
- **Branch workflow** (see `docs/ROADMAP.md`):
  1. Run on `main`.
  2. Run on the branch with `--compare=<main results>`.
  3. Merge only without REGRESSED rows.
