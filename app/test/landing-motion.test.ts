// The landing's scroll-linked motion samples keyframes the way the design's interactions do: hold before the first
// frame and after the last, linear in between.
import { describe, expect, it } from 'vitest';
import { sample } from '@/lib/landing-motion';

describe('landing motion keyframes', () => {
  const xy: [number, ...number[]][] = [[9, 0, 0], [23, 150, 210], [42, 500, 820], [100, 500, 1220]];
  it('holds the first value before the first frame and the last after the last', () => {
    expect(sample(xy, 0)).toEqual([0, 0]);
    expect(sample(xy, 100)).toEqual([500, 1220]);
    expect(sample(xy, 150)).toEqual([500, 1220]);
  });
  it('interpolates linearly between frames', () => {
    expect(sample(xy, 16)).toEqual([75, 105]);
    expect(sample(xy, 23)).toEqual([150, 210]);
    expect(sample([[0, 100], [3, 100], [4, 0]], 3.5)).toEqual([50]);
  });
});
