import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../service/MeetingApiClient', () => ({
  MeetingApiClient: { getMeeting: vi.fn() },
  newIdempotencyKey: () => 'k',
  MeetingHttpError: class {},
}));

import MeetingDetail from './MeetingDetail';
import { MeetingApiClient } from '../service/MeetingApiClient';
import type { Meeting } from '../service/contracts';
import { __resetWKApp } from '../__mocks__/dmworkBase';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const MEETING: Meeting = {
  meetingId: 'm1',
  meetingNumber: '123456',
  title: 'Weekly sync',
  status: 'live',
  version: 1,
  passwordEnabled: true,
  createdBy: 'u-host',
};

beforeEach(() => {
  __resetWKApp();
  vi.clearAllMocks();
});

describe('MeetingDetail (XIN-1838 StrictMode double-invoke regression)', () => {
  // The E2E defect: under <StrictMode> + Vite dev the effect double-invokes
  // (mount → cleanup aborts run #1 → mount again). Run #1's aborted rejection
  // must NOT paint the terminal "出现错误，请重试" error that short-circuits
  // run #2's successful render. This reproduces that exact sequence: run #1's
  // request is aborted by the cleanup and rejects; run #2 resolves with 200 data.
  it('survives the aborted first request and renders the meeting on the successful load', async () => {
    asMock(MeetingApiClient.getMeeting).mockImplementation(
      (_id: string, signal?: AbortSignal) =>
        new Promise<Meeting>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          // Resolve on a later tick so the StrictMode cleanup aborts run #1 first.
          setTimeout(() => resolve(MEETING), 0);
        }),
    );

    render(
      <React.StrictMode>
        <MeetingDetail meetingId="m1" />
      </React.StrictMode>,
    );

    // The successful load renders the modeled detail fields (topic → title,
    // status, meeting number) and NOT the fail-closed error banner.
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    expect(screen.getByText('live')).toBeInTheDocument();
    expect(screen.getByText(/123456/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('出现错误，请重试')).toBeNull();

    // Effect double-invoked (mount → cleanup → mount).
    expect(asMock(MeetingApiClient.getMeeting).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a genuine (non-aborted) failure still surfaces the terminal error', async () => {
    asMock(MeetingApiClient.getMeeting).mockRejectedValue({ response: { status: 500, data: { message: 'boom' } } });

    render(<MeetingDetail meetingId="m1" />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('出现错误，请重试')).toBeInTheDocument();
  });

  it('clears a stale error when a later load succeeds', async () => {
    // First mount fails; a subsequent successful load for a new id must clear
    // the terminal error and render the meeting.
    asMock(MeetingApiClient.getMeeting)
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce(MEETING);

    const { rerender } = render(<MeetingDetail meetingId="m1" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    rerender(<MeetingDetail meetingId="m2" />);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('Weekly sync')).toBeInTheDocument();
  });
});
