# Contributing

Phaser-Feel uses GPL-3.0-or-later and Developer Certificate of Origin 1.1 sign-offs.

```sh
git commit -s -m "feat: describe the change"
```

Before proposing a change, confirm that the public source mirror still passes:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Public API proposals should be discussed before implementation because the full API review, compatibility, documentation, and test process is maintained by the project owner outside this source mirror.
