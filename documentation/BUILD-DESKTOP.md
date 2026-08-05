# Desktop installable build (Windows)

Rhema ships as a **Tauri** desktop app. Development uses `bun run tauri dev`; a **production installer** bundles the UI plus Bible data and AI assets.

## One-time on this machine

1. [Prerequisites](../README.md#prerequisites) (Bun, Rust, Visual Studio C++, `bun run setup:windows` on Windows).
2. Data and models:

   ```powershell
   cd C:\path\to\rhema
   bun run setup:all
   bun run download:twi-bible   # optional
   bun run build:bible          # close Rhema first if DB is locked
   ```

3. **Deepgram** (recommended for installed builds): set your API key in the app **Settings → API Keys** after install (no `.env` in the installer).

## Build the installer

```powershell
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"
$env:CARGO_TARGET_DIR = "C:\Users\you\rhema\src-tauri\target"

bun run build:desktop
```

This runs:

1. **`prepare:bundle`** — verifies `data/rhema.db`, embeddings, and ONNX model exist (same paths as dev).
2. **`tauri build`** — Vite production frontend + Rust release + **NSIS** / **MSI** (Windows).

## Output location

| Platform | Typical path |
|----------|----------------|
| Windows | `src-tauri\target\release\bundle\nsis\Rhema_*-setup.exe` or `msi\` |

Run the setup exe on any PC **without** Bun/Rust/Python. The app loads Bible and embeddings from its bundled **resource** folder.

## Size

Expect **~1 GB+** if you include everything from `setup:all`. Most of that is the ONNX embedding model and SQLite Bible DB.

## Local Whisper in installed builds

The default installer bundles **Deepgram-ready** assets. **Whisper** is not included unless you run `bun run download:whisper` and add the whisper file to `tauri.conf.json` `bundle.resources` (or extend `scripts/prepare-bundle.ts`). For most live setups, use **Deepgram** in Settings.

## New PC (end users)

They only run the **installer** you built. They do **not** run `setup:all` unless you ship a dev/source package instead of an installer.

## Troubleshooting

- **`resource path doesn't exist` or `prepare:bundle` failures** → run `bun run setup:all` and `bun run build:bible`.
- **Linker / ONNX errors on Windows** → use MSVC 14.44+ and a clean `CARGO_TARGET_DIR` under the repo (see README).
- **Blank Bible after install** → ensure `data/rhema.db` exists before `tauri build`.
