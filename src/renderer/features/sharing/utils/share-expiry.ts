import dayjs from 'dayjs';

/**
 * Sharing supports a "never expires" link: the expiry picker is clearable and
 * its description tells the user that leaving it empty creates a link with no
 * expiration. These two helpers are the single source of truth for that
 * behavior so the form's validator and submit handler can never drift apart
 * (the original fork added the clearable picker but left the validator
 * rejecting an empty value, which made "never expires" impossible to submit).
 */

export type ShareExpiryValue = Date | null | number | string | undefined;

/**
 * Validate the chosen expiry. An empty value is intentional ("never expires")
 * and is always valid. A provided value must be strictly in the future.
 */
export const isShareExpiryValid = (value: ShareExpiryValue): boolean => {
    if (!value) return true;
    return dayjs(value).isAfter(dayjs());
};

/**
 * Convert the expiry into the value sent to the backend. Navidrome treats an
 * expiry of `0` as a share that never expires; an empty value therefore maps
 * to `0` rather than `dayjs('').valueOf()` (which is `NaN` and is rejected).
 */
export const toShareExpiryTimestamp = (value: ShareExpiryValue): number => {
    if (!value) return 0;
    return dayjs(value).valueOf();
};
