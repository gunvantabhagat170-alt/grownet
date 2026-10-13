import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MIN_WITHDRAWAL_PAISE, POINTS_PER_RUPEE, pointsToPaise } from "./points.ts";
import { pickDailyQuiz, quizLooksLikeMeta, QUIZ_BANK } from "./quiz-bank.ts";

describe("points conversion", () => {
  it("uses 20 points = ₹1", () => {
    assert.equal(POINTS_PER_RUPEE, 20);
    assert.equal(pointsToPaise(20), 100);
  });

  it("treats 500 points as ₹25, not ₹500", () => {
    assert.equal(pointsToPaise(500), 2500);
    assert.equal((pointsToPaise(500) / 100).toFixed(2), "25.00");
    assert.notEqual(pointsToPaise(500), 50000);
  });
});

describe("withdrawal floor", () => {
  it("is ₹69", () => {
    assert.equal(MIN_WITHDRAWAL_PAISE, 6900);
  });
});

describe("daily quiz bank", () => {
  it("picks 5 unique general-knowledge questions", () => {
    const qs = pickDailyQuiz("2026-10-05", "user-a", 5);
    assert.equal(qs.length, 5);
    assert.equal(new Set(qs.map((q) => q.q)).size, 5);
    for (const q of qs) {
      assert.equal(q.a.length, 4);
      assert.ok(q.correct >= 0 && q.correct < 4);
      assert.ok(q.points >= 10 && q.points <= 15);
      assert.equal(quizLooksLikeMeta(q.q), false);
    }
  });

  it("randomizes by day and user", () => {
    const a = pickDailyQuiz("2026-10-05", "user-a", 5).map((q) => q.q).join("|");
    const b = pickDailyQuiz("2026-10-06", "user-a", 5).map((q) => q.q).join("|");
    const c = pickDailyQuiz("2026-10-05", "user-b", 5).map((q) => q.q).join("|");
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  it("has no development-meta questions in the bank", () => {
    for (const q of QUIZ_BANK) {
      assert.equal(quizLooksLikeMeta(q.q), false);
    }
  });
});
