import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from 'react-error-boundary';
import { I18nextProvider } from 'react-i18next';
import { HashRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { ErrorFallback } from './error-fallback';

import i18n from '/@/i18n/i18n';

// Regression guard for the error-boundary crash.
//
// `ErrorFallback` is wired as a react-error-boundary `FallbackComponent` (see
// similar-songs-list.tsx). It previously read the caught error via
// `useRouteError()` from react-router. That hook is only valid inside a data
// router error element; under the app's non-data `HashRouter` it hits an
// `invariant` and THROWS during the fallback render. The throw escaped the
// boundary and crashed the parent boundary instead of containing the error.
//
// The fix reads the error from the `error` prop (`FallbackProps`). These tests
// render the fallback exactly the way it's used in production — inside a
// react-error-boundary under a HashRouter — and assert it renders without
// throwing and surfaces the error message.
const Boom = () => {
    throw new Error('kaboom-detail-string');
};

const renderWithProviders = (ui: React.ReactNode) =>
    render(
        <I18nextProvider i18n={i18n}>
            <MantineProvider>
                <HashRouter>{ui}</HashRouter>
            </MantineProvider>
        </I18nextProvider>,
    );

describe('ErrorFallback as a react-error-boundary FallbackComponent', () => {
    it('renders the fallback (does not re-throw) when a child throws under a HashRouter', () => {
        // Silence the expected boundary console.error noise.
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(() =>
            renderWithProviders(
                <ErrorBoundary FallbackComponent={ErrorFallback}>
                    <Boom />
                </ErrorBoundary>,
            ),
        ).not.toThrow();

        // The fallback UI mounted (the caught error detail is rendered).
        expect(screen.getByText('kaboom-detail-string')).toBeTruthy();

        spy.mockRestore();
    });

    it('surfaces the caught error message from the `error` prop, not useRouteError()', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        renderWithProviders(
            <ErrorBoundary FallbackComponent={ErrorFallback}>
                <Boom />
            </ErrorBoundary>,
        );

        expect(screen.getByText('kaboom-detail-string')).toBeTruthy();

        spy.mockRestore();
    });
});
