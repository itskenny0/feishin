import { describe, expect, it } from 'vitest';

import { normalizeTargetStatus } from '../media-store';

describe('normalizeTargetStatus', () => {
    it('maps legacy idle → queued (was added, never synced)', () => {
        expect(normalizeTargetStatus('idle')).toBe('queued');
    });
    it('maps legacy syncing → queued (crash residue resumes)', () => {
        expect(normalizeTargetStatus('syncing')).toBe('queued');
    });
    it('resets crash residue downloading/enumerating → queued', () => {
        expect(normalizeTargetStatus('downloading')).toBe('queued');
        expect(normalizeTargetStatus('enumerating')).toBe('queued');
    });
    it('keeps settled states', () => {
        expect(normalizeTargetStatus('complete')).toBe('complete');
        expect(normalizeTargetStatus('partial')).toBe('partial');
        expect(normalizeTargetStatus('error')).toBe('error');
        expect(normalizeTargetStatus('paused')).toBe('paused');
    });
    it('falls back to queued for unknown values', () => {
        expect(normalizeTargetStatus('weird')).toBe('queued');
    });
});
