import test from 'node:test'
import assert from 'node:assert/strict'
import { probeElectronAvailability, RemoteElectronViewHost } from '../lib/browser-electron/remote-host.js'

/**
 * #8: the provider's available() consults this probe, so the seam's
 * provider-selection errors (BROWSER_PROVIDER_UNAVAILABLE / AMBIGUOUS) can
 * actually fire instead of every provider claiming to be usable.
 */

test('probeElectronAvailability reports unusable when no binary can be located', () => {
  assert.equal(probeElectronAvailability(() => {
    throw new Error('dsh-browser-plus requires Electron 42.9.3; found: none')
  }), false)
})

test('probeElectronAvailability reports usable when a binary resolves', () => {
  assert.equal(probeElectronAvailability(() => 'C:/fake/electron.exe'), true)
})

test('the self-hosted host exposes the probe to the provider without starting a child', () => {
  // Constructing the host must stay inert: resolving Electron and spawning the
  // child both happen lazily, on first use.
  const host = new RemoteElectronViewHost('C:/fake/host-main.js')
  assert.equal(typeof host.isAvailable, 'function')
  // Delegates to the real locator, so it tracks this environment (Electron is
  // an optional dependency and may legitimately be absent).
  assert.equal(host.isAvailable(), probeElectronAvailability())
  assert.equal(host.isAvailable(), probeElectronAvailability(), 'the probe result is cached')
})
