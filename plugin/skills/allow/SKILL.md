---
name: allow
description: Opt this repository in to sending code to Cheap Agent's worker models - all models, --zdr-only (zero-retention only), or --models provider/model,... From a folder that is not a git repo, add --repo <path> to pick the repo; otherwise it lists the repos found and allows nothing.
argument-hint: "[--zdr-only | --models provider/model,...] [--repo <path>]"
disable-model-invocation: true
allowed-tools: Bash(npx -y cheap-agent@1.3.2 allow) Bash(npx -y cheap-agent@1.3.2 allow *)
---

!`npx -y cheap-agent@1.3.2 allow $ARGUMENTS`

The developer ran this consent command themselves; its output is above. Report it in one line.

Only because the user invoked this skill: If no output appears above (Codex): run that command yourself once, exactly as written, with `$ARGUMENTS` replaced by whatever the user typed after the skill name (or nothing). It needs network for npx; ask for that if the sandbox blocks it. Do not run `cheapag allow` again or change consent in any other way.
