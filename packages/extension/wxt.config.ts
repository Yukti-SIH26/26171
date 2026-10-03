import { defineConfig } from 'wxt';

/**
 * WXT builds one codebase into two extensions.
 *
 * Firefox is forced to MV3 rather than WXT's MV2 default: MV2 is on a
 * deprecation path, and shipping a real product on it would mean a rewrite
 * later. The cost is that Firefox MV3 background scripts are non-persistent
 * event pages, so no long-lived state can live there.
 *
 * Auto-imports are off on purpose. This codebase handles credentials, and
 * implicit globals make it harder to audit where a value came from.
 */
export default defineConfig({
  srcDir: 'src',
  imports: false,

  // Builds land in the repository root as `dist/chrome-mv3` and
  // `dist/firefox-mv3` — one loadable folder per browser. WXT appends the
  // `{browser}-mv{version}` suffix itself, so both targets can coexist.
  outDir: '../../dist',

  // WXT resolves `publicDir` against the package root, not `srcDir`, so this has
  // to be stated explicitly or the bundled model weights are silently left out of
  // the build — the extension then loads and fails only when a model is requested.
  publicDir: 'src/public',

  // WXT defaults Firefox to MV2. Forced to MV3 for both targets so we are not
  // building a product on a deprecated platform.
  manifestVersion: 3,

  manifest: ({ browser, manifestVersion }) => ({
    name: 'Yukti — Privacy Vision Agent',
    short_name: 'Yukti',
    description:
      'Reads the page locally, redacts sensitive data before anything leaves the browser, ' +
      'then executes validated actions from a remote reasoning model.',

    // Declared explicitly rather than relying on WXT's icon auto-discovery, so a
    // renamed file fails the build instead of silently shipping a default icon.
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      96: '/icon/96.png',
      128: '/icon/128.png',
    },

    permissions: [
      // Inject the structure-channel extractor.
      'scripting',
      // Vault ciphertext, audit log, preferences.
      'storage',
      // Tab identity and lifecycle, plus `captureVisibleTab`.
      'tabs',
      // Verify locally that user-requested files actually finish downloading.
      'downloads',
      // Chrome-only: offscreen document hosts the local models.
      ...(browser === 'chrome' ? ['offscreen'] : []),
      // Chrome-only: CDP access, the only route to trusted input events.
      ...(browser === 'chrome' ? ['debugger'] : []),
    ],

    // `<all_urls>`, granted once at install.
    //
    // This looks like the broadest possible ask, so it is worth being exact about
    // what it changes: nothing. The content script below is already declared
    // `matches: ['<all_urls>']`, so the extension already reads the full DOM of every
    // page. This permission adds the screenshot of the same page.
    //
    // The alternative, `getDisplayMedia`, was tried and removed. It needs no host
    // permission, but it puts a surface picker in front of the user every session and
    // lets them share a window or a monitor instead of the tab — a frame containing
    // the OS, the browser chrome and this panel, which page coordinates cannot be
    // mapped onto. `displaySurface: 'browser'` is only a hint and nothing removes
    // "Window" from the picker, so that was unpreventable rather than unlikely.
    //
    // `activeTab` cannot substitute: it is dropped on every cross-origin navigation,
    // which is exactly what an agent does.
    host_permissions: ['<all_urls>'],

    // Only loopback, for a locally hosted model. `<all_urls>` above already covers
    // every https provider, so there is nothing left to request at runtime. Note what
    // is absent: no CDN, because the models, the ONNX runtime and the OCR engine are
    // all bundled.
    optional_host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'],

    // WebAssembly is blocked in MV3 extension pages unless this is declared.
    // Without it the detector and OCR both fail instantly at instantiation —
    // not a degraded mode, a hard stop.
    //
    // `wasm-unsafe-eval` is narrower than it sounds: it permits compiling
    // WebAssembly and nothing else. No `unsafe-eval`, so JavaScript still cannot
    // be built from strings. Everything else stays at 'self', which is what
    // keeps the bundled-only guarantee enforceable by the browser rather than
    // just by our code.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },

    ...(manifestVersion === 3 ? { action: {} } : { browser_action: {} }),

    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              // Required for signing MV3 extensions; AMO does not assign one.
              id: 'kavach@sih26171.local',
              // 140 is the floor for `data_collection_permissions` below,
              // which web-ext lint flags if the minimum is set any lower.
              strict_min_version: '140.0',

              // Firefox makes us state exactly what leaves the browser, which
              // this architecture can answer narrowly and truthfully.
              //
              // `websiteContent` is declared because redacted page structure and
              // a redacted screenshot are sent to the reasoning server, on user
              // request only.
              //
              // Deliberately NOT declared, and each omission is enforced in code
              // rather than merely promised:
              //   personallyIdentifyingInfo - detected and redacted before egress
              //   authenticationInfo        - vault-only, never transmitted
              //   financialAndPaymentInfo   - redacted before egress
              //   browsingActivity          - nothing is read unless a task is given
              data_collection_permissions: {
                required: ['websiteContent'],
              },
            },
            // Android is untested and not a target: WebGPU support there is
            // patchy and memory limits are far tighter. The floor is declared
            // only because 142 is where Android gained the key above.
            gecko_android: {
              strict_min_version: '142.0',
            },
          },
        }
      : {}),
  }),

  webExt: {
    // Keep a persistent profile so a logged-in portal session survives reloads
    // during development.
    keepProfileChanges: true,
    startUrls: ['about:blank'],
  },
});
