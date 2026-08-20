# Contributing

## Development setup

This plugin follows the DeepSeek Harness source layout. Clone both repositories
as siblings:

```text
workspace/
  deepseek-harness/
  dsh-evolve/
```

Use Node.js `>=22.19` and pnpm. Then run:

```powershell
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

Keep runtime observation non-blocking and local by default. Changes that can
alter future agent behavior must preserve evidence, explicit approval, and
rollback paths. Add focused tests for behavior changes and update documents
when contracts change.
