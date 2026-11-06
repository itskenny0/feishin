import type { SliderProps as MantineSliderProps } from '@mantine/core';

import { Slider as MantineSlider } from '@mantine/core';
import { forwardRef, memo } from 'react';

import styles from './slider.module.css';

export interface SliderProps extends MantineSliderProps {}

export const Slider = memo(
    forwardRef<HTMLDivElement, SliderProps>(({ classNames, style, ...props }, ref) => {
        return (
            <MantineSlider
                classNames={{
                    bar: styles.bar,
                    label: styles.label,
                    thumb: styles.thumb,
                    track: styles.track,
                    ...classNames,
                }}
                ref={ref}
                style={style}
                {...props}
                // Mantine puts role="slider" on the thumb and names it from
                // thumbLabel; a plain aria-label only lands on the root div.
                thumbLabel={props.thumbLabel ?? props['aria-label']}
            />
        );
    }),
);

Slider.displayName = 'Slider';
