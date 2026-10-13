/** 20 points = ₹1, so 500 points = ₹25. Never treat 1 point as ₹1. */
export const POINTS_PER_RUPEE = 20;
export const MIN_WITHDRAWAL_RUPEES = 69;
export const MIN_WITHDRAWAL_PAISE = MIN_WITHDRAWAL_RUPEES * 100;
export const QUIZ_QUESTION_COUNT = 5;

export function pointsToPaise(points: number): number {
  const safe = Math.max(0, Math.round(Number(points) || 0));
  return Math.round((safe / POINTS_PER_RUPEE) * 100);
}

export function paiseToPoints(paise: number): number {
  const safe = Math.max(0, Math.round(Number(paise) || 0));
  return Math.round((safe / 100) * POINTS_PER_RUPEE);
}
