import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acceptLanguagesFor,
  chromeMajor,
  clientHintPlatform,
  secChUa,
  stripElectronToken,
} from '../lib/browser-electron/fingerprint.js'

/**
 * These run against the exact User-Agent this host really produced before the
 * fix, so the assertions are about the shipped behaviour rather than a guess.
 */

const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.280 Electron/42.9.3 Safari/537.36'

test('the Electron token is stripped and nothing else moves', () => {
  assert.equal(
    stripElectronToken(REAL_UA),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.280 Safari/537.36',
  )
  assert.doesNotMatch(stripElectronToken(REAL_UA), /Electron/)
  // A UA that never had the token is left byte-for-byte alone.
  const plain = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36'
  assert.equal(stripElectronToken(plain), plain)
})

test('the client-hint brands mirror the engine major', () => {
  assert.equal(chromeMajor(REAL_UA), '148')
  assert.equal(chromeMajor('no version here'), undefined)
  assert.equal(
    secChUa([{ brand: 'Chromium', version: '148' }, { brand: 'Not/A)Brand', version: '99' }]),
    '"Chromium";v="148", "Not/A)Brand";v="99"',
  )
})

test('sec-ch-ua-platform is spelled the way Chromium spells it', () => {
  assert.equal(clientHintPlatform('win32'), '"Windows"')
  assert.equal(clientHintPlatform('darwin'), '"macOS"')
  assert.equal(clientHintPlatform('linux'), '"Linux"')
})

test('the language list is weighted the way real Chrome weights it', () => {
  // Electron sent the bare locale; Chromium turns this list into
  // "zh-CN,zh;q=0.9,en;q=0.8", which is the shape Chrome produces.
  assert.equal(acceptLanguagesFor('zh-CN'), 'zh-CN,zh,en')
  assert.equal(acceptLanguagesFor('en-US'), 'en-US,en', 'no duplicated base language')
  assert.equal(acceptLanguagesFor('en'), 'en')
})
