import type { Key, OpenedSession } from '@revyl/verify';

// Interim: @revyl/verify 0.6.3's pressKey() and tap() wait for the page to settle after every action, and a
// running game never settles, so each key takes about 6 s and screenshots queue behind it. Revyl's web
// runtime already accepts a flag that skips that wait; this sends the same key and tap actions with it,
// through the SDK's own client and credentials. When Verify adds a settle option, delete this file and call
// session.pressKey(key, { settle: false }) and session.tap(at, { settle: false }) directly.

const WEB_KEY_NAMES: Partial<Record<Key, string>> = {
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  space: 'Space',
};

interface VerifyInternals {
  client: { worker(runId: string, action: string, options: { method: 'POST'; body: unknown }): Promise<{ status: number; body: Uint8Array }> };
  workflowRunId: string;
  toDevice(at: { x: number; y: number }): Promise<{ x: number; y: number }>;
}

export function withFastInput(session: OpenedSession) {
  const internals = session as unknown as VerifyInternals;
  const act = async (action: string, body: Record<string, unknown>) => {
    const response = await internals.client.worker(internals.workflowRunId, action, { method: 'POST', body: { ...body, skip_settle: true } });
    const reply = JSON.parse(new TextDecoder().decode(response.body)) as { success?: boolean; error?: string | null };
    if (response.status !== 200 || reply.success !== true) throw new Error(`${action} failed (HTTP ${response.status}): ${reply.error ?? 'no reason given'}`);
  };
  return {
    async pressKey(key: Key, options: { settle?: boolean } = {}): Promise<void> {
      if (options.settle !== false) return session.pressKey(key);
      const name = WEB_KEY_NAMES[key];
      if (!name) throw new Error(`No web key name for ${key}`);
      await act('key', { key: name });
    },
    async tap(at: { x: number; y: number }): Promise<void> {
      await act('tap', await internals.toDevice(at));
    },
  };
}
