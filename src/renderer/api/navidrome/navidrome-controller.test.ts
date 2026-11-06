// Controller-level tests for the Navidrome backend with the HTTP clients mocked.

import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ndApiClient } from '/@/renderer/api/navidrome/navidrome-api';
import { NavidromeController } from '/@/renderer/api/navidrome/navidrome-controller';
import { ServerListItemWithCredential, ServerType } from '/@/shared/types/domain-types';

vi.mock('/@/renderer/api/navidrome/navidrome-api', () => ({ ndApiClient: vi.fn() }));
vi.mock('/@/renderer/api/subsonic/subsonic-api', () => ({ ssApiClient: vi.fn() }));
vi.mock('/@/renderer/api/subsonic/subsonic-controller', () => ({ SubsonicController: {} }));
vi.mock('axios', () => ({ default: { post: vi.fn() } }));

describe('NavidromeController.authenticate', () => {
    beforeEach(() => vi.mocked(ndApiClient).mockReset());

    // The credential is appended verbatim to stream / cover art / download URLs,
    // so a username with `+` or `&` must be percent-encoded or the server parses
    // a different user (`+` decodes to a space) and rejects the request.
    it('percent-encodes the username in the Subsonic credential', async () => {
        const authenticate = vi.fn(async () => ({
            body: {
                data: {
                    id: 'u1',
                    isAdmin: false,
                    subsonicSalt: 'salt',
                    subsonicToken: 'token',
                    token: 'jwt',
                    username: 'dj+radio&co',
                },
            },
            status: 200,
        }));
        vi.mocked(ndApiClient).mockReturnValue({ authenticate } as unknown as ReturnType<
            typeof ndApiClient
        >);

        const result = await NavidromeController.authenticate('http://nd.local/', {
            password: 'pw',
            username: 'dj+radio&co',
        });

        expect(result.credential).toBe('u=dj%2Bradio%26co&s=salt&t=token');
        expect(new URLSearchParams(result.credential).get('u')).toBe('dj+radio&co');
    });
});

describe('NavidromeController image uploads', () => {
    const server = {
        id: 'srv1',
        ndCredential: 'jwt',
        type: ServerType.NAVIDROME,
        url: 'http://nd.local/',
    } as ServerListItemWithCredential;

    beforeEach(() => vi.mocked(axios.post).mockReset());

    it.each([
        ['uploadArtistImage', 'artist'],
        ['uploadInternetRadioStationImage', 'radio'],
        ['uploadPlaylistImage', 'playlist'],
    ] as const)('%s posts the image to /api/%s/:id/image', async (method, resource) => {
        vi.mocked(axios.post).mockResolvedValue({ data: { status: 'ok' }, status: 200 });

        const ok = await NavidromeController[method]!({
            apiClientProps: { server, serverId: server.id },
            body: { image: new Uint8Array([1, 2, 3]) },
            query: { id: 'x1' },
        });

        expect(ok).toBe(true);
        const [url, form, config] = vi.mocked(axios.post).mock.calls[0];
        expect(url).toBe(`http://nd.local/api/${resource}/x1/image`);
        expect((form as FormData).get('image')).toBeInstanceOf(Blob);
        expect(config?.headers).toMatchObject({
            'Content-Type': 'multipart/form-data',
            'x-nd-authorization': 'Bearer jwt',
        });
    });
});
