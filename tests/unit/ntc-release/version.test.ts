import { describe, it, expect } from 'vitest';
// @ts-expect-error .mjs
import { nextNtcVersion } from '../../../tools/ntc-release/version.mjs';

describe('nextNtcVersion', () => {
  it('starts at 1', () => expect(nextNtcVersion('1.2.0', [])).toBe('1.2.0-ntc.1'));
  it('increments the max of the same base, numerically', () =>
    expect(nextNtcVersion('1.2.0', ['ntc-v1.2.0-ntc.2', 'ntc-v1.2.0-ntc.10', 'ntc-v1.1.0-ntc.99']))
      .toBe('1.2.0-ntc.11'));
  it('ignores upstream v* tags and malformed ones', () =>
    expect(nextNtcVersion('1.2.0', ['v1.2.0', 'ntc-v1.2.0-ntc.x'])).toBe('1.2.0-ntc.1'));
  it('rejects a base that is not X.Y.Z', () =>
    expect(() => nextNtcVersion('1.2', [])).toThrow(/X\.Y\.Z/));
});
