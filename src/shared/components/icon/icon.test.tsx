import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Icon } from '/@/shared/components/icon/icon';

describe('Icon', () => {
    it('forwards props it does not consume (e.g. onClick) to the svg', () => {
        const onClick = vi.fn();
        const { container } = render(
            <Icon aria-label="expand" icon="arrowRightS" onClick={onClick} />,
        );
        const svg = container.querySelector('svg')!;

        fireEvent.click(svg);

        expect(onClick).toHaveBeenCalledTimes(1);
        expect(svg.getAttribute('aria-label')).toBe('expand');
    });
});
