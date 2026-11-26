import { useEffect, useState } from 'react';
import { storage } from '#imports';
import { getStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { READ_PROGRESS_KEY, type ReadRunProgress } from '@/entrypoints/utils/readTask';

export interface ReadProgressView {
    isLoaded: boolean;
    isReading: boolean;
    // Server progress when the round started plus the submissions confirmed in
    // this round. Never points: a submission can still be rejected upstream.
    completed: number;
    target: number;
    max: number;
}

const INITIAL: ReadProgressView = { isLoaded: false, isReading: false, completed: 0, target: 0, max: 0 };

function toView(progress: ReadRunProgress | null): ReadProgressView {
    if (!progress) return { ...INITIAL, isLoaded: true };
    const completed = Math.max(0, (Number(progress.baseline) || 0) + (Number(progress.submitted) || 0));
    return {
        isLoaded: true,
        isReading: Boolean(progress.isReading),
        completed,
        target: Math.max(0, Number(progress.target) || 0),
        max: Math.max(0, Number(progress.max) || 0),
    };
}

// Live view of the reading half. The background writes the record; the popup
// only reads it, so a closed popup never holds a round's progress hostage.
export function useReadProgress(): ReadProgressView {
    const [view, setView] = useState<ReadProgressView>(INITIAL);

    useEffect(() => {
        let mounted = true;

        void getStorageItem<ReadRunProgress>(READ_PROGRESS_KEY, StorageValues.LOCAL).then(
            (progress) => {
                if (mounted) setView(toView(progress));
            },
            () => {
                if (mounted) setView((previous) => ({ ...previous, isLoaded: true }));
            }
        );

        const unwatch = storage.watch<ReadRunProgress>(`local:${READ_PROGRESS_KEY}`, (progress) => {
            setView(toView(progress));
        });

        return () => {
            mounted = false;
            unwatch();
        };
    }, []);

    return view;
}
