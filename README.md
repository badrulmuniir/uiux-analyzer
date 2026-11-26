# analyzer

Accessibility fixer + WordPress block theme generator.

**Agent 5 default = adaptive (v2). Preset (v1) kept as optional/legacy, selectable via `--preset` flag.**

- Adaptive (default): `structure.mjs` detects the page's sections, `templategen.mjs` rebuilds them as block markup in the Modern style.
- Preset (legacy): `themegen.mjs` fixed templates (`modern`, `minimal`, `bold`). Run with `node e2e.mjs --preset`.
