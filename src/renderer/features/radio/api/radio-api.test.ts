import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('/@/renderer/cache', () => ({
    dropSnapshotsForEntity: (entity: string) => calls.push(`drop:${entity}`),
    readSnapshot: () => undefined,
    snapshotSwr: vi.fn(),
}));
vi.mock('/@/renderer/api', () => ({ api: { controller: {} } }));

import { invalidateRadioList } from '/@/renderer/features/radio/api/radio-api';

describe('invalidateRadioList', () => {
    it('drops the station snapshot before refetching, so the refetch hits the server', () => {
        const queryClient = new QueryClient();
        vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async (filters) => {
            calls.push(`invalidate:${JSON.stringify(filters?.queryKey)}`);
        });

        invalidateRadioList(queryClient, 'srv1');

        expect(calls).toEqual(['drop:radio', 'invalidate:["srv1","radio","list"]']);
    });
});
