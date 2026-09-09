import { afterEach, describe, it, expect, vi } from 'vitest';
import { gatewayFetch, ObsidianGatewayClient } from './integration-client.js';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('gateway delivery boundary', () => {
    it('aborts stalled requests within the transport budget', async () => { vi.useFakeTimers(); vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('aborted'))); }))); const request = gatewayFetch('http://127.0.0.1:47831/v1/handshake', { method: 'POST' }, 25); const rejected = expect(request).rejects.toThrow('gateway_timeout'); await vi.advanceTimersByTimeAsync(25); await rejected; });
    it('clears timeouts after success and rejects non-loopback settings before sending', async () => { vi.useFakeTimers(); const fetch = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetch); await gatewayFetch('http://127.0.0.1:1', {}, 20); expect(vi.getTimerCount()).toBe(0); const client = new ObsidianGatewayClient(() => ({ gatewayBaseUrl: 'https://example.com', clientId: crypto.randomUUID(), pairingToken: 'secret' }), () => { }); await expect(client.connect()).rejects.toThrow('unsupported_gateway'); expect(fetch).toHaveBeenCalledTimes(1); });
});

describe('manifest pending-operation transport', () => {
    it('sends a thousand pending UUIDs in the POST body, never the request URL', async () => {
        const vaultId = crypto.randomUUID(), ids = Array.from({ length: 1000 }, () => crypto.randomUUID());
        const fetch = vi.fn(async () => new Response(JSON.stringify({ binding: { vaultId, binding: 'a'.repeat(64), managedRoot: 'Memora' }, files: [], resolutions: [], cursor: null })));
        vi.stubGlobal('fetch', fetch);
        const client = new ObsidianGatewayClient(() => ({ gatewayBaseUrl: 'http://127.0.0.1:47831', clientId: crypto.randomUUID(), pairingToken: 'fixture' }), () => {});
        (client as unknown as { sessionToken: string }).sessionToken = 'fixture-session';
        await client.manifest(vaultId, 25, ids);
        const [url, options] = (fetch.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
        expect(url).toBe('http://127.0.0.1:47831/v1/obsidian/editorial/manifest');
        expect(options.method).toBe('POST');
        expect(JSON.parse(String(options.body))).toEqual({ vaultId, cursor: 25, pendingOperationIds: ids });
    });
});
