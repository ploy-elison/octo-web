import { describe, it, expect } from 'vitest';
import {
  toCamelDeep,
  toSnakeDeep,
  decodeEvaluate,
  decodeList,
  decodeMeeting,
  encodeFinalize,
  redactSensitive,
} from './adapter';

describe('snake ⇄ camel single seam (§6.3)', () => {
  it('deep snake → camel', () => {
    expect(
      toCamelDeep({ meeting_id: 'm1', password_pass_token: 't', nested: { page_token: 'p', arr: [{ a_b: 1 }] } }),
    ).toEqual({ meetingId: 'm1', passwordPassToken: 't', nested: { pageToken: 'p', arr: [{ aB: 1 }] } });
  });

  it('canonical password_pass_token → passwordPassToken (never passPassToken)', () => {
    const out = toCamelDeep<{ passwordPassToken?: string; passPassToken?: string }>({ password_pass_token: 'X' });
    expect(out.passwordPassToken).toBe('X');
    expect(out.passPassToken).toBeUndefined();
  });

  it('deep camel → snake omits undefined', () => {
    expect(toSnakeDeep({ meetingId: 'm', deviceIdHash: 'd', maybe: undefined })).toEqual({
      meeting_id: 'm',
      device_id_hash: 'd',
    });
  });

  it('decodeEvaluate maps allowed_to_prejoin truth-table fields', () => {
    const v = decodeEvaluate({
      eligible: true,
      meeting_id: 'm1',
      password_required: false,
      allowed_to_prejoin: true,
      version: 3,
    } as never);
    expect(v).toEqual({ eligible: true, meetingId: 'm1', passwordRequired: false, allowedToPrejoin: true, version: 3 });
  });

  // Approved v0.3 wire (XIN-1830/1831): list envelope is `{ items: [...], next_page_token? }`
  // and a meeting object carries `topic` (not `title`). The adapter is the single seam that
  // reads `items[]` and maps wire `topic` → domain `title`; snake_case / `topic` never leak past it.
  it('decodeList reads v0.3 items[] + next_page_token and maps topic → title', () => {
    const r = decodeList({
      items: [{ meeting_id: 'a', topic: 'Weekly sync', password_enabled: true }],
      next_page_token: 'nxt',
    } as never);
    expect(r.nextPageToken).toBe('nxt');
    expect(r.meetings).toHaveLength(1);
    expect(r.meetings[0].meetingId).toBe('a');
    expect(r.meetings[0].title).toBe('Weekly sync');
    expect(r.meetings[0].passwordEnabled).toBe(true);
    // `topic` must not survive past the adapter.
    expect((r.meetings[0] as unknown as Record<string, unknown>).topic).toBeUndefined();
  });

  it('decodeList renders an empty (not fail-closed) result for items:[]', () => {
    const r = decodeList({ items: [] } as never);
    expect(r.meetings).toEqual([]);
    expect(r.nextPageToken).toBeUndefined();
  });

  it('decodeMeeting maps wire topic → domain title at the single seam', () => {
    const m = decodeMeeting({ meeting_id: 'm1', topic: 'Standup', status: 'scheduled' } as never);
    expect(m.title).toBe('Standup');
    expect((m as unknown as Record<string, unknown>).topic).toBeUndefined();
  });

  it('encodeFinalize produces snake_case wire with pass token field', () => {
    expect(
      encodeFinalize({ meetingId: 'm', source: 'link', passwordPassToken: 'tok', deviceIdHash: 'dh', version: 2 }),
    ).toEqual({ meeting_id: 'm', source: 'link', password_pass_token: 'tok', device_id_hash: 'dh', version: 2 });
  });
});

describe('redaction for telemetry/logs (§8, §14)', () => {
  it('strips passwords and tokens at any depth', () => {
    const cleaned = redactSensitive({
      meetingId: 'm',
      password: '123456',
      passwordPassToken: 'ppt',
      nested: { link_token: 'lt', livekitToken: 'lk', ok: 'keep' },
      list: [{ token: 'z', keep: 1 }],
    });
    expect(cleaned).toEqual({ meetingId: 'm', nested: { ok: 'keep' }, list: [{ keep: 1 }] });
  });
});
