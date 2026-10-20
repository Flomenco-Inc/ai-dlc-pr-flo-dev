import { describe, expect, it } from 'vitest';
import { PR_REVIEW_MARKER, hasPrReviewMarker, withPrReviewMarker } from '../pr-review-marker.js';

describe('pr-review-marker', () => {
  it('appends the marker once', () => {
    expect(withPrReviewMarker('Please rename this.')).toBe(
      `Please rename this.\n\n${PR_REVIEW_MARKER}`,
    );
    expect(withPrReviewMarker(`Already marked.\n\n${PR_REVIEW_MARKER}`)).toBe(
      `Already marked.\n\n${PR_REVIEW_MARKER}`,
    );
  });

  it('detects the marker', () => {
    expect(hasPrReviewMarker(`note\n${PR_REVIEW_MARKER}`)).toBe(true);
    expect(hasPrReviewMarker('human note')).toBe(false);
    expect(hasPrReviewMarker('')).toBe(false);
  });
});
