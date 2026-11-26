import { useEffect, useState } from 'react';
import { storage } from '#imports';
import { getStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { READ_AUTH_KEY, hasReadCredentials, type ReadAuth } from '@/entrypoints/utils/readTask';

export interface ReadAuthStatus {
    isLoaded: boolean;
    // Whether the stored credentials can still be exchanged for a token.
    // A cached access token alone is not enough: it expires and cannot renew.
    authorized: boolean;
    auth: ReadAuth | null;
}

const INITIAL: ReadAuthStatus = { isLoaded: false, authorized: false, auth: null };

// Read-only view of the reading authorization. The background owns every write;
// this hook only reads once and then follows storage changes, the same way the
// search progress hook treats the run record.
export function useReadAuth(): ReadAuthStatus {
    const [status, setStatus] = useState<ReadAuthStatus>(INITIAL);

    useEffect(() => {
        let mounted = true;

        void getStorageItem<ReadAuth>(READ_AUTH_KEY, StorageValues.LOCAL).then(
            (auth) => {
                if (!mounted) return;
                setStatus({ isLoaded: true, authorized: hasReadCredentials(auth), auth });
            },
            () => {
                if (mounted) setStatus((previous) => ({ ...previous, isLoaded: true }));
            }
        );

        const unwatch = storage.watch<ReadAuth>(`local:${READ_AUTH_KEY}`, (auth) => {
            setStatus({ isLoaded: true, authorized: hasReadCredentials(auth), auth: auth ?? null });
        });

        return () => {
            mounted = false;
            unwatch();
        };
    }, []);

    return status;
}
