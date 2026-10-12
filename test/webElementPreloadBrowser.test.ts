import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck } from '../src/shared/deck.js';
import { injectWebBridgeRuntime } from '../src/shared/webBridge.js';
import {
  Cdp, electronBinary, eventually, findTarget, launchBrowser, stopBrowser, type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * A web page on the next slide is loaded, and drawing, before the talk
 * reaches it.
 *
 * A heavy WebGL page (a Plotly 3D viewer) took about two seconds to come up
 * every time its slide was reached, because its frame was only created then.
 * The player now loads it on a hidden stage while the previous slide is
 * shown. This runs a real presentation and checks what only a browser can:
 * that the hidden page keeps getting animation frames (Chromium stops
 * rendering a cross-origin frame it considers out of view, which would leave
 * a WebGL page undrawn until shown), that it is not told it
 * is active early, and that advancing shows that same loaded page -- ready in
 * the same task, never reloaded.
 */
const DECK_ID = 'web-element-preload';

/**
 * Holds its readiness for a while after load, as a page that builds a scene
 * does, then draws with WebGL on every animation frame and reports how many
 * frames it has drawn, how many times it loaded and when it was told active.
 */
const VIEWER_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#000">
<canvas id="gl" width="400" height="300" style="width:100%;height:100%;display:block"></canvas>
<script>
var loadId = Math.random().toString(36).slice(2);
var drawn = 0;
var active = [];
var built;
deckwerk.ready(new Promise(function (resolve) { built = resolve; }));
deckwerk.onActive(function (state) { active.push({ at: Date.now(), step: state.step }); });
var gl = document.getElementById('gl').getContext('webgl');
function draw() {
  if (gl) { gl.clearColor(0, 0.8, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  drawn += 1;
  requestAnimationFrame(draw);
}
addEventListener('load', function () {
  setTimeout(function () { built(); requestAnimationFrame(draw); }, 300);
});
setInterval(function () {
  parent.postMessage({ preloadTest: 'viewer', loadId: loadId, drawn: drawn, active: active, gl: !!gl }, '*');
}, 50);
</script></body></html>`;

const RECORDER = `(() => {
  const log = window.__preload = { loads: {}, latest: null };
  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.preloadTest !== 'viewer') return;
    log.loads[data.loadId] = true;
    log.latest = data;
  });
})();`;

interface ViewerReport {
  loadId: string;
  drawn: number;
  active: Array<{ at: number; step: number }>;
  gl: boolean;
}

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let present: Cdp | null = null;

afterEach(async () => {
  present?.close();
  present = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('a web element on the next slide', () => {
  it('is loaded and drawing before its slide is shown, and shown without reloading', {
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'web-element-preload-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets', 'web'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(deckDir, 'assets', 'web', 'viewer.html'), injectWebBridgeRuntime(VIEWER_PAGE), 'utf8');

    const deck = emptyDeck('Web preload');
    deck.themePreset = 'basic';
    const first = deck.slides[0];
    deck.slides = [
      { ...first, id: 'before', elements: [] },
      {
        ...first,
        id: 'viewer-slide',
        elements: [{
          id: 'viewer', type: 'web', x: 160, y: 90, w: 1600, h: 900, rot: 0, z: 1, opacity: 1,
          class: [], style: {}, src: 'assets/web/viewer.html', poster: null,
          interactive: true, title: 'Viewer',
        }],
      },
    ];
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${server.port}/present.html?deck=${DECK_ID}`;
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/api/decks`, profileDir);
    const target = await findTarget(browser.debugPort, (candidate) => candidate.url.includes('/api/decks'), browser.log);
    present = await Cdp.connect(target.webSocketDebuggerUrl!, { commandTimeoutMs: 30_000 });
    await present.call('Page.enable');
    await present.call('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
    await present.call('Page.bringToFront', {});
    await present.evaluate(`(location.href = ${JSON.stringify(url)}, null)`);

    // Still on the first slide: the viewer is on a hidden stage, ready.
    await eventually(
      () => present!.evaluate<boolean>(
        `document.querySelector('.stage-preload .web-body[data-web-ready="true"]') !== null`,
      ),
      "the next slide's page was never preloaded and readied",
    );
    const preloaded = await eventually(
      () => present!.evaluate<ViewerReport | null>('window.__preload.latest'),
      'the preloaded page never drew while hidden',
      (report) => report !== null && report.drawn >= 10,
    );
    expect(preloaded!.gl, 'no WebGL in the test browser').toBe(true);
    expect(preloaded!.active, 'the preloaded page was told it was active early').toEqual([]);
    expect(await present.evaluate<number>(
      `document.querySelectorAll('.stage:not(.stage-preload) iframe.web-frame').length`,
    )).toBe(0);

    // Advance: the very frame that loaded is shown, ready, in the same task.
    const shown = await present.evaluate<{ same: boolean; ready: string | null; visible: string }>(`(() => {
      const frame = document.querySelector('.stage-preload iframe.web-frame');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      const live = document.querySelector('.stage:not(.stage-preload) iframe.web-frame');
      return {
        same: live === frame,
        ready: live && live.closest('.web-body').dataset.webReady,
        visible: getComputedStyle(live.closest('.stage')).opacity,
      };
    })()`);
    expect(shown.same, 'advancing created a new frame instead of showing the loaded one').toBe(true);
    expect(shown.ready).toBe('true');
    expect(shown.visible).toBe('1');

    const after = await eventually(
      () => present!.evaluate<{ report: ViewerReport; loads: number }>(
        '({ report: window.__preload.latest, loads: Object.keys(window.__preload.loads).length })',
      ),
      'the shown page was never told it was active',
      (value) => value.report.active.length > 0,
    );
    expect(after.loads, 'the page loaded again when its slide was shown').toBe(1);
    expect(after.report.loadId).toBe(preloaded!.loadId);
    expect(after.report.active).toHaveLength(1);
  });
});

describe.skipIf(electronBinary)('web element preload (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
