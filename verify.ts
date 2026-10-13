export type VerificationStatus = "passed" | "needs_review" | "rejected";

export type VerificationInput = {
  submissionType: string;
  content: string;
  requirement: string;
  videoSeconds?: number | null;
};

export type VerificationResult = {
  status: VerificationStatus;
  notes: string;
  checks: Record<string, boolean>;
};

const SECRET_ASK =
  /(password|otp|one[- ]time|upi\s*pin|cvv|netbanking|bank\s*login|aadhaar|pan\s*card)/i;

export function verifySubmission(input: VerificationInput): VerificationResult {
  const content = input.content.trim();
  const checks: Record<string, boolean> = {
    present: content.length > 0,
    typeOk: false,
    sizeOk: content.length <= 240_000,
    notSecretAsk: !SECRET_ASK.test(content) && !SECRET_ASK.test(input.requirement),
    requirementNoted: input.requirement.trim().length >= 8,
  };
  if (content.startsWith("data:")) {
    checks.typeOk = /^data:(image|video|application|text)\//.test(content);
  } else if (/^https?:\/\//i.test(content)) {
    checks.typeOk = true;
  } else {
    checks.typeOk = input.submissionType === "other" && content.length >= 12;
  }
  if (input.submissionType === "image") {
    checks.typeOk = content.startsWith("data:image/") || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(content);
  }
  if (input.submissionType === "video") {
    checks.typeOk = content.startsWith("data:video/") || /\.(mp4|webm|mov)(\?|$)/i.test(content) || /youtu|vimeo/i.test(content);
    if (input.videoSeconds && input.videoSeconds > 0) {
      checks.durationDeclared = true;
    }
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (!checks.present || !checks.typeOk || !checks.sizeOk || !checks.notSecretAsk) {
    return {
      status: "rejected",
      notes: failed.length ? `Failed checks: ${failed.join(", ")}` : "Submission rejected",
      checks,
    };
  }
  if (!checks.requirementNoted) {
    return { status: "needs_review", notes: "Requirement text is short. Manual review required.", checks };
  }
  return { status: "passed", notes: "Basic file, type, and safety checks passed.", checks };
}

export function commissionFromBps(studentTotalPaise: number, bps: number) {
  const fee = Math.round((studentTotalPaise * bps) / 10_000);
  return { platformFeePaise: fee, clientTotalPaise: studentTotalPaise + fee };
}
