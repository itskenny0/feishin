import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import { isShareExpiryValid, toShareExpiryTimestamp } from './share-expiry';

describe('share-expiry', () => {
    describe('isShareExpiryValid', () => {
        it('treats an empty value as valid ("never expires")', () => {
            // This is the regression: a clearable picker advertises "leave empty
            // for a link that never expires", so an empty value must pass.
            expect(isShareExpiryValid('')).toBe(true);
            expect(isShareExpiryValid(null)).toBe(true);
            expect(isShareExpiryValid(undefined)).toBe(true);
        });

        it('accepts a future date', () => {
            const future = dayjs().add(1, 'year').format('YYYY-MM-DD HH:mm:ss');
            expect(isShareExpiryValid(future)).toBe(true);
        });

        it('rejects a past date', () => {
            const past = dayjs().subtract(1, 'minute').format('YYYY-MM-DD HH:mm:ss');
            expect(isShareExpiryValid(past)).toBe(false);
        });
    });

    describe('toShareExpiryTimestamp', () => {
        it('maps an empty value to 0 (never expires), not NaN', () => {
            expect(toShareExpiryTimestamp('')).toBe(0);
            expect(toShareExpiryTimestamp(null)).toBe(0);
            expect(toShareExpiryTimestamp(undefined)).toBe(0);
        });

        it('returns the millisecond timestamp for a real date', () => {
            const value = '2999-01-01 00:00:00';
            expect(toShareExpiryTimestamp(value)).toBe(dayjs(value).valueOf());
            expect(Number.isNaN(toShareExpiryTimestamp(value))).toBe(false);
        });
    });
});
