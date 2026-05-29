import { describe, expect, it } from 'vitest';

import { pickFirstImageFile } from '/@/shared/utils/image-drop';

const makeFileList = (files: File[]): FileList => {
    const list = {
        item: (index: number) => files[index] ?? null,
        length: files.length,
        [Symbol.iterator]: function* iterate() {
            yield* files;
        },
    } as unknown as FileList;
    files.forEach((file, index) => {
        (list as unknown as Record<number, File>)[index] = file;
    });
    return list;
};

const file = (name: string, type: string): File => new File(['x'], name, { type });

describe('pickFirstImageFile', () => {
    it('returns null for a null FileList', () => {
        expect(pickFirstImageFile(null)).toBeNull();
    });

    it('returns null for an empty FileList', () => {
        expect(pickFirstImageFile(makeFileList([]))).toBeNull();
    });

    it('returns the first image file when present', () => {
        const png = file('cover.png', 'image/png');
        const result = pickFirstImageFile(makeFileList([file('notes.txt', 'text/plain'), png]));
        expect(result).toBe(png);
    });

    it('skips non-image files and finds a later image', () => {
        const jpg = file('art.jpg', 'image/jpeg');
        const result = pickFirstImageFile(
            makeFileList([file('a.pdf', 'application/pdf'), file('b.zip', 'application/zip'), jpg]),
        );
        expect(result).toBe(jpg);
    });

    it('returns null when no file is an image', () => {
        const result = pickFirstImageFile(
            makeFileList([file('a.txt', 'text/plain'), file('b.mp3', 'audio/mpeg')]),
        );
        expect(result).toBeNull();
    });

    it('returns the first of multiple image files', () => {
        const first = file('one.png', 'image/png');
        const second = file('two.gif', 'image/gif');
        expect(pickFirstImageFile(makeFileList([first, second]))).toBe(first);
    });
});
