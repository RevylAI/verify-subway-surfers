import type { Key, OpenedSession } from '@revyl/verify';

// Interim: @revyl/verify 0.6.3's pressKey() waits for the page to settle after every key, and a running
// game never settles, so each key takes about 6 s. Revyl's web runtime already accepts a flag that skips
// that wait; this sends the same key action with it, through the SDK's own client and credentials.
// The next Verify release adds pressKey(key, { settle: false }); then delete this file and call
// session.pressKey(key, { settle: false }) directly.

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
}

export function withFastKeys(session: OpenedSession) {
  const internals = session as unknown as VerifyInternals;
  return {
    async pressKey(key: Key, options: { settle?: boolean } = {}): Promise<void> {
      if (options.settle !== false) return session.pressKey(key);
      const name = WEB_KEY_NAMES[key];
      if (!name) throw new Error(`No web key name for ${key}`);
      const response = await internals.client.worker(internals.workflowRunId, 'key', { method: 'POST', body: { key: name, skip_settle: true } });
      const reply = JSON.parse(new TextDecoder().decode(response.body)) as { success?: boolean; error?: string | null };
      if (response.status !== 200 || reply.success !== true) throw new Error(`key ${key} failed (HTTP ${response.status}): ${reply.error ?? 'no reason given'}`);
    },
  };
}
