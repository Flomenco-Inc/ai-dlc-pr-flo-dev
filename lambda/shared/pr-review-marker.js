export const PR_REVIEW_MARKER = '<!-- aidlc-pr-review -->';

export const hasPrReviewMarker = (body) => String(body ?? '').includes(PR_REVIEW_MARKER);

export const withPrReviewMarker = (body) => {
  const text = String(body ?? '').trimEnd();
  if (hasPrReviewMarker(text)) return text;
  return `${text}\n\n${PR_REVIEW_MARKER}`;
};
