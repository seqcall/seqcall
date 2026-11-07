import { describe, expect, it } from 'vitest';
import { timeSlicer } from '../src/time-slice';

describe('long scans give way (FR-16.1 entry points)', () => {
  it('FR-16.1 a slice gives way to other work once its time is up, not before', async () => {
    const ran: string[] = [];
    const busy = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end);
    };
    setImmediate(() => ran.push('other work'));
    const slice = timeSlicer(20);
    await slice(); // time not up: no pause
    expect(ran).toEqual([]);
    busy(25);
    await slice(); // time up: the other work runs here
    expect(ran).toEqual(['other work']);
    setImmediate(() => ran.push('later work'));
    await slice(); // a new slice started: no pause again
    expect(ran).toEqual(['other work']);
  });
});
