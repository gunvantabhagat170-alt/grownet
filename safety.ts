const BYPASS =
  /(\+?\d[\d\s\-()]{8,}\d)|whatsapp|telegram|paytm|phonepe|gpay|upi[\s:]|@ok(axis|hdfc)|t\.me\/|wa\.me\/|instagram\.com|facebook\.com\/profile/i;

const PROHIBITED =
  /(password|one[- ]time\s*pin|\botp\b|upi\s*pin|cvv|netbanking|bank\s*login|seed\s*phrase|fake\s*review|buy\s*followers|mass\s*messag|credential|bypass\s*security|aadhaar\s*number)/i;

export function assertOnPlatformMessage(body: string) {
  if (BYPASS.test(body) || PROHIBITED.test(body)) {
    throw Object.assign(new Error("Keep phone numbers, UPI, passwords, OTPs, and off-platform chat off GrowNet messages."), {
      status: 400,
    });
  }
}

export function assertSafeTaskText(text: string) {
  if (PROHIBITED.test(text)) {
    throw Object.assign(
      new Error("This task asks for passwords, OTPs, financial access, or other prohibited work."),
      { status: 400 },
    );
  }
}
