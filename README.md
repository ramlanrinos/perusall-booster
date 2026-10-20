# Perusall Booster

A personal reading-session timer for students who read on [Perusall](https://perusall.com), for **Google Chrome**
and **Microsoft Edge** (Manifest V3).

> **Perusall Booster is not affiliated with Perusall.** Its timer is your own personal record. It is **separate
> from Perusall's official "Active engagement time"** and never reads, changes or sends anything Perusall uses for
> grading.

## Status

Work in progress. See [`implementation-plan.md`](implementation-plan.md) for the design, permissions and limitations.

## Development

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run check
```

`npm run check` runs type checking, linting, unit tests, the build, manifest validation and the
sensitive-data scan. The unpacked extension is written to `dist/`.

### Toolchain notes

* Vitest 4 runs on **Vite 7 (Rollup)**. Vite 8 uses the `rolldown` native module, which crashes with
  `SIGBUS` when loaded from an NTFS (`ntfs3`) drive, where this project was developed.
* `.npmrc` sets `legacy-peer-deps=true`, because npm ≤ 10 crashes ("edgesOut") resolving Vitest 4's optional
  peers. The required peers are explicit dev dependencies.

## License

MIT
