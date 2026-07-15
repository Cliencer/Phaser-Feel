# Phaser-Feel

Phaser-Feel is a GPL-3.0-or-later deterministic game-feel feedback orchestration plugin for Phaser 4.

This public repository is the buildable runtime-source mirror. The package is under active development and has not been published to npm.

## Documentation

Read the [bilingual API documentation and try the interactive demos](https://cliencer.github.io/Phaser-Feel/).

## Requirements

- Node.js 24
- pnpm 10
- Phaser `>=4.0.0 <5`

## Build

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

The ESM entry points and declarations are emitted to `dist/`; an IIFE browser build is emitted as `dist/phaser-feel.global.js`.

## Public API areas currently implemented

- deterministic `FeelPlayer` and `FeelHandle` scheduling;
- Feedback registry and schema validation;
- Phaser 4 RuntimeAdapter boundaries;
- camera shake and event emission;
- safe target resolution and property Tween feedbacks;
- composable TimeDomains and `time.freeze`.

Copyright 2026 Cliencer.
