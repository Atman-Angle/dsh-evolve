/**
 * Fixture unpacking: copies a directory fixture into the run workspace, or
 * extracts a tarball/zip when the fixture path ends with a known archive
 * suffix. The eval runner keeps fixtures immutable by always copying/extracting
 * into a fresh per-run workspace.
 *
 * @module dsh-evolve/offline/eval/unpack
 */

import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

/** Extract one archive with the platform `tar` (handles .tar.gz/.tgz/.zip via tar). */
async function extractArchive(archive: string, target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', target], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar exited ${code} extracting ${basename(archive)}`))
    })
  })
}

const ARCHIVE_SUFFIXES = ['.tar', '.tar.gz', '.tgz', '.zip']

/**
 * Materialize a fixture into `target`: directory fixtures are copied
 * recursively; archives are extracted. The source is never modified.
 */
export async function extract(fixture: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  const lower = fixture.toLowerCase()
  if (ARCHIVE_SUFFIXES.some(suffix => lower.endsWith(suffix))) {
    await extractArchive(fixture, target)
    return
  }
  // Plain directory fixture: copy recursively, keeping file modes.
  const entries = await readdir(fixture)
  if (entries.length === 0) return
  await cp(fixture, target, { recursive: true, force: false })
}