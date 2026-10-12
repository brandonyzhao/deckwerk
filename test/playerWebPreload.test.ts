// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';
import { WEB_BRIDGE_SOURCE } from '../src/shared/webBridge.js';

/**
 * Web pages on upcoming slides load before the slide is reached.
 *
 * A web element's frame used to be created only when its slide rendered, so
 * a heavy page (a WebGL viewer, megabytes of data) sat under its poster for
 * seconds every time the talk arrived at it. The player now loads the next
 * slides' pages on hidden stages of their own and, since a frame that moves
 * in the document loads again, shows the slide on the stage its page loaded
 * on. These tests pin what that must not break: the page is the same frame
 * (never moved, so never reloaded), it is not told it is active until its
 * slide is shown, it cannot drive the deck while waiting, the rest of the
 * slide still renders around it in order, and the window stays small.
 */

type Web = Extract<SlideElement, { type: 'web' }>;

function web(id: string, src: string, overrides: Partial<Web> = {}): Web {
  return {
    id, type: 'web', x: 100, y: 100, w: 800, h: 450, rot: 0, z: 2, opacity: 1,
    class: [], style: {}, src, poster: null, interactive: true, title: id, ...overrides,
  };
}

function text(id: string, z: number): SlideElement {
  return {
    id, type: 'text', x: 0, y: 0, w: 600, h: 100, rot: 0, z, opacity: 1,
    class: ['role-title'], style: {}, html: id, align: 'left', valign: 'top',
  } as SlideElement;
}

function deckWith(slides: SlideElement[][], skipped: number[] = []): Deck {
  const deck = emptyDeck('Web preload');
  deck.slides = slides.map((elements, i) => ({
    ...deck.slides[0],
    id: `s${i}`,
    elements,
    ...(skipped.includes(i) ? { skipped: true } : {}),
  }));
  return deck;
}

let host: HTMLElement;
let player: Player | null = null;

const resolveSrc = (src: string) => `/deck/${src}`;

/** The stage the audience sees. */
function visibleStage(): HTMLElement {
  const stages = [...host.querySelectorAll<HTMLElement>(':scope > .stage:not(.stage-preload)')];
  expect(stages).toHaveLength(1);
  return stages[0];
}

function preloadStages(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(':scope > .stage.stage-preload')];
}

function frameFor(root: ParentNode, src: string): HTMLIFrameElement | null {
  return [...root.querySelectorAll<HTMLIFrameElement>('iframe.web-frame')]
    .find((frame) => frame.getAttribute('src') === `/deck/${src}`) ?? null;
}

/** What the deck has posted to a page, bridge events only. */
function recordPosts(frame: HTMLIFrameElement): unknown[] {
  const posted: unknown[] = [];
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((message: unknown) => {
    posted.push(message);
  }) as Window['postMessage']);
  return posted;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function animationFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

/** Every node the player removed from the document, so a moved (reloaded) frame shows up. */
function watchRemovals(): Node[] {
  const removed: Node[] = [];
  new MutationObserver((records) => {
    for (const record of records) removed.push(...record.removedNodes);
  }).observe(host, { childList: true, subtree: true });
  return removed;
}

const detachedAt = (removed: Node[], frame: Node): boolean =>
  removed.some((node) => node === frame || node.contains(frame));

beforeEach(() => {
  document.body.replaceChildren();
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
  if (!CSS.escape) CSS.escape = (value) => value;
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  player?.destroy();
  player = null;
  vi.restoreAllMocks();
});

describe('web page preloading', () => {
  it('loads the next slide\'s page on a hidden stage, unannounced', async () => {
    const deck = deckWith([[text('title-0', 1)], [web('viewer', 'assets/web/viewer.html')]]);
    player = new Player({ deck, container: host, resolveSrc });
    await flush();

    expect(frameFor(visibleStage(), 'assets/web/viewer.html')).toBeNull();
    const [stage] = preloadStages();
    expect(stage, 'the next slide\'s page was not preloaded').toBeDefined();
    // Hidden by opacity, not visibility or display: Chromium stops rendering
    // a cross-origin frame that is hidden, and the page must finish drawing.
    expect(stage.style.opacity).toBe('0');
    expect(stage.style.visibility).toBe('');
    expect(stage.style.display).toBe('');
    expect(stage.hasAttribute('inert')).toBe(true);
    expect(stage.getAttribute('aria-hidden')).toBe('true');

    const frame = frameFor(stage, 'assets/web/viewer.html')!;
    expect(frame.isConnected).toBe(true);
    const posted = recordPosts(frame);
    frame.dispatchEvent(new Event('load'));
    expect(posted, 'a preloaded page was told about a slide it is not on').toEqual([]);
  });

  it('shows the slide on the stage its page loaded on, without moving the frame', async () => {
    const deck = deckWith([
      [text('title-0', 1)],
      [text('behind', 1), web('viewer', 'assets/web/viewer.html'), text('over', 3)],
    ]);
    player = new Player({ deck, container: host, resolveSrc });
    await flush();
    const [stage] = preloadStages();
    const frame = frameFor(stage, 'assets/web/viewer.html')!;
    const posted = recordPosts(frame);
    frame.dispatchEvent(new Event('load'));
    // load + two frames: the page is ready (and its poster gone) while still off screen.
    await animationFrames(3);
    const box = frame.closest<HTMLElement>('.web-body')!;
    expect(box.dataset.webReady).toBe('true');

    const removed = watchRemovals();
    player.next();
    await flush();

    expect(visibleStage()).toBe(stage);
    expect(preloadStages()).not.toContain(stage);
    expect(stage.style.opacity).toBe('');
    expect(stage.hasAttribute('inert')).toBe(false);
    expect(stage.hasAttribute('aria-hidden')).toBe(false);
    expect(frameFor(stage, 'assets/web/viewer.html')).toBe(frame);
    expect(detachedAt(removed, frame), 'the frame was moved, which reloads its page').toBe(false);
    expect(frame.closest<HTMLElement>('.web-body')!.dataset.webReady).toBe('true');
    // The rest of the slide is the fresh render, in paint order around the page.
    const root = stage.querySelector<HTMLElement>(':scope > .slide')!;
    expect(root.dataset.slideId).toBe('s1');
    expect([...root.children].map((node) => (node as HTMLElement).dataset.elementId))
      .toEqual(['behind', 'viewer', 'over']);
    expect(host.querySelectorAll('[data-element-id="title-0"]')).toHaveLength(0);
    // Told it is active once, now that its slide is shown.
    expect(posted).toEqual([{ source: WEB_BRIDGE_SOURCE, event: 'active', step: 0, steps: 1 }]);
  });

  it('tells a page that is still loading it is active when it loads, once', async () => {
    const deck = deckWith([[], [web('viewer', 'assets/web/viewer.html')]]);
    player = new Player({ deck, container: host, resolveSrc });
    await flush();
    const frame = frameFor(preloadStages()[0], 'assets/web/viewer.html')!;
    const posted = recordPosts(frame);
    player.next();
    expect(posted).toEqual([]);
    frame.dispatchEvent(new Event('load'));
    expect(posted).toEqual([{ source: WEB_BRIDGE_SOURCE, event: 'active', step: 0, steps: 1 }]);
  });

  it('does not let a preloaded page drive the deck', async () => {
    const deck = deckWith([[], [web('viewer', 'assets/web/viewer.html')], []]);
    player = new Player({ deck, container: host, resolveSrc });
    await flush();
    const frame = frameFor(preloadStages()[0], 'assets/web/viewer.html')!;
    window.dispatchEvent(new MessageEvent('message', {
      data: { source: WEB_BRIDGE_SOURCE, action: 'next' }, source: frame.contentWindow,
    }));
    expect(player.getCursor().slide).toBe(0);
  });

  it('walks past skipped slides, and keeps the window small', async () => {
    const deck = deckWith([
      [],
      [web('skipped', 'assets/web/skipped.html')],
      [web('a', 'assets/web/a.html')],
      [web('b', 'assets/web/b.html')],
      [web('c', 'assets/web/c.html')],
    ], [1]);
    player = new Player({ deck, container: host, resolveSrc });
    await flush();
    // One page at a time: the second preload starts once the first is showing.
    const first = frameFor(host, 'assets/web/a.html')!;
    expect(first).not.toBeNull();
    first.dispatchEvent(new Event('load'));
    await animationFrames(3);
    await flush();
    expect(frameFor(host, 'assets/web/skipped.html')).toBeNull();
    expect(frameFor(host, 'assets/web/b.html')).not.toBeNull();
    expect(frameFor(host, 'assets/web/c.html')).toBeNull();
    expect(preloadStages()).toHaveLength(2);

    // Jumping away tears down what is no longer within reach. The slide just
    // before the new one is already loaded, so it is kept for a step back.
    const second = frameFor(host, 'assets/web/b.html')!;
    player.goToSlide(4);
    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);
    expect(preloadStages()).toHaveLength(1);
    expect(frameFor(host, 'assets/web/a.html')).toBeNull();
  });

  it('keeps the page just left loaded, so going back shows it at once', async () => {
    const deck = deckWith([[], [web('viewer', 'assets/web/viewer.html')], [text('after', 1)]]);
    player = new Player({ deck, container: host, resolveSrc });
    await flush();
    const frame = frameFor(preloadStages()[0], 'assets/web/viewer.html')!;
    const posted = recordPosts(frame);
    frame.dispatchEvent(new Event('load'));
    player.next();
    const removed = watchRemovals();

    player.next();
    await flush();
    expect(frame.isConnected, 'the page just left was unloaded').toBe(true);
    expect(frame.closest('.stage')!.classList.contains('stage-preload')).toBe(true);
    expect(posted.at(-1)).toEqual({ source: WEB_BRIDGE_SOURCE, event: 'inactive' });
    expect(frameFor(visibleStage(), 'assets/web/viewer.html')).toBeNull();
    expect(visibleStage().querySelector('[data-element-id="after"]')).not.toBeNull();

    player.prev();
    await flush();
    expect(frameFor(visibleStage(), 'assets/web/viewer.html')).toBe(frame);
    expect(detachedAt(removed, frame)).toBe(false);
    expect(posted.at(-1)).toEqual({ source: WEB_BRIDGE_SOURCE, event: 'active', step: 0, steps: 1 });
  });

  it('waits for the visible slide\'s own page before preloading the next', async () => {
    const deck = deckWith([
      [web('here', 'assets/web/here.html')],
      [web('next', 'assets/web/next.html')],
    ]);
    player = new Player({ deck, container: host, resolveSrc });
    await flush();
    expect(preloadStages()).toHaveLength(0);
    frameFor(visibleStage(), 'assets/web/here.html')!.dispatchEvent(new Event('load'));
    await animationFrames(3);
    await flush();
    expect(frameFor(preloadStages()[0] ?? host, 'assets/web/next.html')).not.toBeNull();
  });

  it('stays blank when advancing onto a preloaded slide while blanked', async () => {
    const deck = deckWith([[], [web('viewer', 'assets/web/viewer.html')]]);
    player = new Player({ deck, container: host, resolveSrc });
    await flush();
    const stage = preloadStages()[0];
    expect(player.toggleBlank()).toBe(true);
    player.next();
    expect(visibleStage()).toBe(stage);
    expect(stage.style.opacity).toBe('0');
    expect(player.toggleBlank()).toBe(false);
    expect(stage.style.opacity).toBe('1');
  });

  it('drops a preloaded page whose element changed, and shows the new one', async () => {
    const deck = deckWith([[], [web('viewer', 'assets/web/old.html')]]);
    player = new Player({ deck, container: host, resolveSrc });
    await flush();
    const stale = frameFor(host, 'assets/web/old.html')!;
    expect(stale).not.toBeNull();

    const edited = structuredClone(deck);
    (edited.slides[1].elements[0] as Web).src = 'assets/web/new.html';
    player.setDeck(edited);
    expect(stale.isConnected).toBe(false);
    await flush();
    const fresh = frameFor(preloadStages()[0], 'assets/web/new.html');
    expect(fresh).not.toBeNull();
    player.next();
    expect(frameFor(visibleStage(), 'assets/web/new.html')).toBe(fresh);
  });

  it('morphs onto a preloaded slide, on the stage its page loaded on', async () => {
    const deck = deckWith([
      [text('title', 1), text('leaves', 2)],
      [text('title', 1), web('viewer', 'assets/web/viewer.html')],
    ]);
    deck.slides[1].elements[0] = { ...deck.slides[1].elements[0], x: 400 };
    deck.slides[1].morphFromPrevious = true;
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel() {}, finish() {} }));
    const originalAnimate = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    try {
      player = new Player({ deck, container: host, resolveSrc });
      await flush();
      const stage = preloadStages()[0];
      const frame = frameFor(stage, 'assets/web/viewer.html')!;
      player.next();
      expect(visibleStage()).toBe(stage);
      expect(frameFor(stage, 'assets/web/viewer.html')).toBe(frame);
      // The title moved, the old object fades out as a ghost on the shown stage.
      const animated = animate.mock.contexts as unknown as HTMLElement[];
      expect(animated.some((node) => node.dataset?.elementId === 'title')).toBe(true);
      expect(stage.querySelector('.morph-ghost')).not.toBeNull();
    } finally {
      HTMLElement.prototype.animate = originalAnimate;
    }
  });

  it('leaves decks without web pages on the one stage', async () => {
    const deck = deckWith([[text('a', 1)], [text('b', 1)], [text('c', 1)]]);
    player = new Player({ deck, container: host, resolveSrc });
    await flush();
    const stage = visibleStage();
    player.next();
    player.next();
    player.prev();
    expect(visibleStage()).toBe(stage);
    expect(host.querySelectorAll(':scope > .stage')).toHaveLength(1);
  });
});
