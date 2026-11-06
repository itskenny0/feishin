import { ipcRenderer } from 'electron';

import { listen } from './ipc';

import { QueueSong } from '/@/shared/types/domain-types';
import { PlayerRepeat, PlayerStatus } from '/@/shared/types/types';

const updatePosition = (timeSec: number) => {
    ipcRenderer.send('update-position', timeSec);
};

const updateSeek = (timeSec: number) => {
    ipcRenderer.send('update-seek', timeSec);
};

const updateVolume = (volume: number) => {
    ipcRenderer.send('update-volume', volume);
};

const updateStatus = (status: PlayerStatus) => {
    ipcRenderer.send('update-playback', status);
};

const updateRepeat = (repeat: PlayerRepeat) => {
    ipcRenderer.send('update-repeat', repeat);
};

const updateShuffle = (shuffle: boolean) => {
    ipcRenderer.send('update-shuffle', shuffle);
};

const updateLyrics = (lyrics: string) => {
    ipcRenderer.send('update-lyrics', lyrics);
};

const updateSong = (song: QueueSong | undefined, imageUrl?: null | string) => {
    ipcRenderer.send('update-song', song, imageUrl);
};

const requestSeek = listen<{ offset: number }>('request-seek');

const requestPosition = listen<{ position: number }>('request-position');

const requestToggleRepeat = listen<{ repeat: PlayerRepeat }>('mpris-request-toggle-repeat');

const requestToggleShuffle = listen<{ shuffle: boolean }>('mpris-request-toggle-shuffle');

const requestVolume = listen<{ volume: number }>('request-volume');

export const mpris = {
    requestPosition,
    requestSeek,
    requestToggleRepeat,
    requestToggleShuffle,
    requestVolume,
    updateLyrics,
    updatePosition,
    updateRepeat,
    updateSeek,
    updateShuffle,
    updateSong,
    updateStatus,
    updateVolume,
};

export type Mpris = typeof mpris;
