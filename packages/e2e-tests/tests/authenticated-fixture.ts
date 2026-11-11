import { test as base, expect, type Request } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const authPath = join(tmpdir(), `koi-browser-auth-${process.getuid?.() ?? 0}.json`);
export const test = base.extend({
  context: async ({ context }, use) => {
    const state = JSON.parse(await readFile(authPath, 'utf8'));
    await context.addCookies(state.cookies);
    await use(context);
  },
  page: async ({ page }, use, testInfo) => {
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    const events: Array<Record<string, unknown>> = [];
    const requests: Array<Record<string, unknown>> = [];
    const pending = new Map<Request, Record<string, unknown>>();
    let droppedEvents = 0;
    let droppedRequests = 0;
    const event = (type: string, detail: Record<string, unknown> = {}) => {
      if (events.length < 200) events.push({ atMs: elapsed(), type, ...detail });
      else droppedEvents++;
    };
    const onPageError = (error: Error) => event('pageerror', {
      name: error.name, message: error.message.slice(0, 4000), stack: error.stack?.slice(0, 8000),
    });
    const onConsole = (message: import('@playwright/test').ConsoleMessage) => {
      if (message.type() === 'error') event('console.error', {
        text: message.text().slice(0, 4000), location: message.location(),
      });
    };
    const onRequest = (request: Request) => {
      if (requests.length >= 800) { droppedRequests++; return; }
      const entry = { startedAtMs: elapsed(), method: request.method(),
        url: request.url(), resourceType: request.resourceType() };
      requests.push(entry);
      pending.set(request, entry);
    };
    const onResponse = (response: import('@playwright/test').Response) => {
      const entry = pending.get(response.request());
      if (entry) Object.assign(entry, { responseAtMs: elapsed(), status: response.status(),
        contentType: response.headers()['content-type'] });
    };
    const onRequestFinished = (request: Request) => {
      const entry = pending.get(request);
      if (entry) Object.assign(entry, { finishedAtMs: elapsed() });
      pending.delete(request);
    };
    const onRequestFailed = (request: Request) => {
      const detail = { failedAtMs: elapsed(), failure: request.failure()?.errorText };
      const entry = pending.get(request);
      if (entry) Object.assign(entry, detail);
      event('requestfailed', { url: request.url(), resourceType: request.resourceType(), ...detail });
      pending.delete(request);
    };
    const onCrash = () => event('crash', { url: page.url() });
    const onClose = () => event('close', { url: page.url() });
    const onDomContentLoaded = () => event('domcontentloaded', { url: page.url() });
    const onLoad = () => event('load', { url: page.url() });
    page.on('pageerror', onPageError);
    page.on('console', onConsole);
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFailed);
    page.on('crash', onCrash);
    page.on('close', onClose);
    page.on('domcontentloaded', onDomContentLoaded);
    page.on('load', onLoad);
    const statusPath = testInfo.outputPath('browser-diagnostic-status.json');
    await writeFile(statusPath, JSON.stringify({
      version: 'browser-diagnostics-v2', phase: 'fixture-ready', test: testInfo.title,
      capturedAt: new Date().toISOString(), status: testInfo.status, expectedStatus: testInfo.expectedStatus,
    }, null, 2));
    try {
      await use(page);
    } finally {
      try {
        await writeFile(statusPath, JSON.stringify({
          version: 'browser-diagnostics-v2', phase: 'fixture-finally', test: testInfo.title,
          capturedAt: new Date().toISOString(), status: testInfo.status, expectedStatus: testInfo.expectedStatus,
          errorCount: testInfo.errors.length, url: page.url(), closed: page.isClosed(),
          eventCount: events.length, requestCount: requests.length,
        }, null, 2));
        if (testInfo.status !== testInfo.expectedStatus || testInfo.errors.length > 0) {
        const diagnosticPath = testInfo.outputPath('browser-failure-diagnostics.json');
        const diagnostics = (documentState: unknown) => JSON.stringify({
          version: 'browser-diagnostics-v2', capturedAt: new Date().toISOString(), test: testInfo.title,
          status: testInfo.status, expectedStatus: testInfo.expectedStatus,
          url: page.url(), closed: page.isClosed(), events, droppedEvents,
          requests, droppedRequests, documentState,
        }, null, 2);
        // Save network/errors before contacting the renderer, so even a failed
        // diagnostic evaluation leaves usable evidence on disk.
        await writeFile(diagnosticPath, diagnostics({ pending: true }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        let documentState: unknown;
        try {
          // A hung renderer must not make failure diagnostics hang as well.
          documentState = await Promise.race([
            page.evaluate(() => {
              const root = document.getElementById('root');
              const clone = root?.cloneNode(true) as HTMLElement | undefined;
              clone?.querySelectorAll('input').forEach(input => input.removeAttribute('value'));
              return {
                url: location.href, readyState: document.readyState, title: document.title,
                visibility: document.visibilityState,
                rootPresent: !!root, rootChildren: root?.childElementCount,
                rootDOM: clone?.outerHTML.slice(0, 24_000),
                bodyChildren: Array.from(document.body?.children ?? []).map(element => element.tagName),
                viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth },
                viteError: document.querySelector('vite-error-overlay')?.shadowRoot?.textContent?.slice(0, 4000),
                scripts: Array.from(document.scripts).map(script => ({
                  src: script.src, type: script.type, async: script.async, defer: script.defer,
                })),
                jsResources: performance.getEntriesByType('resource')
                  .filter(entry => (entry as PerformanceResourceTiming).initiatorType === 'script'
                    || /\.(?:[cm]?js|[jt]sx?)(?:\?|$)/.test(entry.name))
                  .slice(0, 800).map(entry => entry.toJSON()),
                navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()),
              };
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Renderer diagnostic evaluation exceeded 2 seconds.')), 2000);
            }),
          ]);
        } catch (error) {
          documentState = { unavailable: error instanceof Error ? error.message : String(error) };
        } finally { if (timer) clearTimeout(timer); }
        await writeFile(diagnosticPath, diagnostics(documentState));
        // A path attachment is materialized and shown by the list reporter;
        // an inline application/json body is otherwise neither saved nor shown.
        await testInfo.attach('browser-failure-diagnostics', { contentType: 'application/json', path: diagnosticPath });
        }
      } finally {
        page.off('pageerror', onPageError);
        page.off('console', onConsole);
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('requestfinished', onRequestFinished);
        page.off('requestfailed', onRequestFailed);
        page.off('crash', onCrash);
        page.off('close', onClose);
        page.off('domcontentloaded', onDomContentLoaded);
        page.off('load', onLoad);
      }
    }
  },
  request: async ({ playwright }, use) => {
    const request = await playwright.request.newContext({ storageState: authPath, extraHTTPHeaders: { 'x-koiforge-request': '1' } });
    await use(request); await request.dispose();
  },
});
export { expect };
