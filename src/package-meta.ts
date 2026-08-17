/** Host-only package metadata. The package manifest remains the source of truth. */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface PackageManifest {
  name?: unknown
  version?: unknown
}

function packageManifestPath(): string {
  // Production loads this Node entry from its installed file. Vite's test
  // transform instead supplies an http URL, where the project manifest is the
  // closest equivalent source of truth.
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  } catch {
    // Fall through to the project root when a browser-oriented test transform
    // has replaced import.meta.url with a non-file URL.
  }
  return join(process.cwd(), 'package.json')
}

const manifest = JSON.parse(readFileSync(packageManifestPath(), 'utf8')) as PackageManifest

function readRequiredString(field: keyof PackageManifest): string {
  const value = manifest[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dsh-smooth-stream: package.json must contain a non-empty ${field}`)
  }
  return value
}

/** npm package name, read from this plugin's manifest. */
export const STREAM_PACKAGE_NAME = readRequiredString('name')

/** Version of the code currently loaded by the Host, read from its manifest. */
export const STREAM_PACKAGE_VERSION = readRequiredString('version')
