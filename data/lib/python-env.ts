/**
 * Shared Python environment management utilities.
 *
 * Provides functions to find Python, create/manage a .venv, and install pip
 * packages. Used by download-model.ts and prepare-embeddings.ts so every
 * Python-dependent script shares a single virtual-environment setup path.
 */

import { join } from "node:path"
import { existsSync } from "node:fs"

export const PROJECT_ROOT = join(import.meta.dir, "..", "..")
export const VENV_DIR = join(PROJECT_ROOT, ".venv")
export const REQUIREMENTS_FILE = join(PROJECT_ROOT, "requirements.txt")
export const MIN_PYTHON_VERSION: [number, number, number] = [3, 9, 0]

/** Pin below 5.5 — optimum-cli ONNX export breaks on read-only SentenceTransformer.config (see huggingface/sentence-transformers#3830). */
export const SENTENCE_TRANSFORMERS_PIP = "sentence-transformers==5.4.1"

/** Kept for callers that need the package list; source of truth is requirements.txt. */
export const SETUP_PIP_PACKAGES = [
  "optimum-onnx[onnxruntime]",
  SENTENCE_TRANSFORMERS_PIP,
  "accelerate",
  "tokenizers",
  "numpy",
  "torch",
  "meaningless",
] as const

export function getVenvBin(name: string): string {
  if (process.platform === "win32") {
    return join(VENV_DIR, "Scripts", `${name}.exe`)
  }
  return join(VENV_DIR, "bin", name)
}

async function probePython(args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    const output = `${stdout}${stderr}`
    return exitCode === 0 && output.includes("Python")
  } catch {
    return false
  }
}

async function resolvePythonExecutable(
  versionArgs: string[]
): Promise<string | null> {
  if (!(await probePython(versionArgs))) {
    return null
  }
  const base = versionArgs.slice(0, -1)
  if (base.length === 0) {
    return null
  }
  try {
    const proc = Bun.spawn([...base, "-c", "import sys; print(sys.executable)"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = (await new Response(proc.stdout).text()).trim()
    const exitCode = await proc.exited
    if (exitCode === 0 && stdout.length > 0) {
      return stdout
    }
  } catch {
    // fall through
  }
  return base.length === 1 ? base[0]! : null
}

export async function findPython(): Promise<string> {
  const attempts: string[][] = []
  if (process.platform === "win32") {
    attempts.push(["py", "-3", "--version"])
  }
  for (const candidate of [
    "python3.12",
    "python3.11",
    "python3.10",
    "python3",
    "python",
  ]) {
    attempts.push([candidate, "--version"])
  }

  for (const versionArgs of attempts) {
    const resolved = await resolvePythonExecutable(versionArgs)
    if (resolved) {
      return resolved
    }
  }

  console.error("\n❌ Python not found.")
  console.error(
    "   Please install Python >= 3.9.0 and ensure it is in your PATH."
  )
  process.exit(1)
}

export function parsePythonVersion(
  output: string
): [number, number, number] {
  const match = output.trim().match(/Python\s+(\d+)\.(\d+)\.(\d+)/)
  if (!match) {
    throw new Error(`Could not parse Python version from: ${output.trim()}`)
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isVersionSufficient(
  version: [number, number, number]
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > MIN_PYTHON_VERSION[i]) return true
    if (version[i] < MIN_PYTHON_VERSION[i]) return false
  }
  return true
}

export async function ensureVenv(pythonCmd: string): Promise<void> {
  const venvPython =
    process.platform === "win32"
      ? getVenvBin("python")
      : getVenvBin("python3")

  if (existsSync(venvPython)) {
    console.log(`  ⏭ Virtual environment already exists at ${VENV_DIR}`)
    return
  }

  console.log(`  Creating virtual environment at ${VENV_DIR}...`)
  const proc = Bun.spawn([pythonCmd, "-m", "venv", VENV_DIR], {
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    console.error("\n❌ Failed to create virtual environment.")
    process.exit(1)
  }
  console.log("  ✓ Virtual environment created")
}

export async function installPipDeps(packages: string[]): Promise<void> {
  const pip = getVenvBin("pip")
  const installArgs = existsSync(REQUIREMENTS_FILE)
    ? (["install", "-r", REQUIREMENTS_FILE] as const)
    : (["install", ...packages] as const)
  console.log(
    existsSync(REQUIREMENTS_FILE)
      ? `  Installing from ${REQUIREMENTS_FILE}...`
      : `  Installing ${packages.join(", ")}...`,
  )
  const proc = Bun.spawn([pip, ...installArgs], {
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    console.error("\n❌ Failed to install dependencies.")
    process.exit(1)
  }
  console.log("  ✓ Dependencies installed")
}

/**
 * Full Python environment setup: find Python, verify version, create venv,
 * install packages. Returns the path to the venv Python binary.
 */
export async function ensurePythonEnv(
  packages: string[]
): Promise<string> {
  console.log("\n🐍 Setting up Python environment...\n")

  const pythonCmd = await findPython()

  const versionProc = Bun.spawn([pythonCmd, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const versionStdout = await new Response(versionProc.stdout).text()
  const versionStderr = await new Response(versionProc.stderr).text()
  await versionProc.exited
  const versionOutput = `${versionStdout}${versionStderr}`
  const version = parsePythonVersion(versionOutput)
  console.log(`  Found ${pythonCmd} version ${version.join(".")}`)

  if (!isVersionSufficient(version)) {
    console.error(
      `\n❌ Python >= ${MIN_PYTHON_VERSION.join(".")} is required, found ${version.join(".")}`
    )
    process.exit(1)
  }

  await ensureVenv(pythonCmd)
  await installPipDeps(packages)

  return getVenvBin(process.platform === "win32" ? "python" : "python3")
}
