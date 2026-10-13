export const APP_NAME = "GrowNet";
export const SUPPORT_WHATSAPP = "7841095038";
export const SUPPORT_PREFILL = "Hi GrowNet Support, I need help.";
export const COMMUNITY_GROUP_URL = "https://chat.whatsapp.com/JhpmsaEllEr2hPpJXLg8Lg";
export const PLATFORM_FEE_BPS = 1000; // 10%
export const MAX_TASK_ATTEMPTS = 2; // first claim + one reattempt; third attempt is blocked
export const DIFFICULTIES = ["beginner", "intermediate", "advanced", "pro"] as const;
export const SKILL_NAMES = ["Video Editing", "Image Editing", "Canva", "Writing", "Data", "Testing", "Design", "Tech"] as const;
export const MAX_DATA_URL_CHARS = 240_000; // ~180KB

export const CATEGORIES = [
  { id: "data_entry", label: "Data Entry", defaultHours: 6, defaultPayoutPaise: 4900 },
  { id: "text_formatting", label: "Text Formatting", defaultHours: 4, defaultPayoutPaise: 4900 },
  { id: "image_categorization", label: "Image Categorization", defaultHours: 4, defaultPayoutPaise: 4900 },
  { id: "information_finding", label: "Information Finding", defaultHours: 6, defaultPayoutPaise: 4900 },
  { id: "short_transcription", label: "Short Transcription", defaultHours: 6, defaultPayoutPaise: 6900 },
  { id: "data_cleaning", label: "Data Cleaning", defaultHours: 8, defaultPayoutPaise: 6900 },
  { id: "survey", label: "Survey", defaultHours: 2, defaultPayoutPaise: 4900 },
  { id: "website_testing", label: "Website Testing", defaultHours: 12, defaultPayoutPaise: 9900 },
  { id: "canva_design", label: "Canva Design", defaultHours: 6, defaultPayoutPaise: 9900 },
  { id: "image_poster", label: "Poster Design", defaultHours: 4, defaultPayoutPaise: 9900 },
  { id: "youtube_thumbnail", label: "YouTube Thumbnail", defaultHours: 4, defaultPayoutPaise: 9900 },
  { id: "image_editing", label: "Image Editing", defaultHours: 3, defaultPayoutPaise: 9900 },
  { id: "background_removal", label: "Background Removal", defaultHours: 3, defaultPayoutPaise: 6900 },
  { id: "social_post_design", label: "Social Media Post Design", defaultHours: 6, defaultPayoutPaise: 9900 },
  { id: "ppt_design", label: "PPT / Presentation Design", defaultHours: 24, defaultPayoutPaise: 14900 },
  { id: "product_image_editing", label: "Product Image Editing", defaultHours: 6, defaultPayoutPaise: 9900 },
  { id: "video_editing", label: "Video Editing", defaultHours: 24, defaultPayoutPaise: 9900 },
  { id: "reel_editing", label: "Short / Reel Editing", defaultHours: 12, defaultPayoutPaise: 9900 },
  { id: "captions", label: "Captions / Subtitles", defaultHours: 8, defaultPayoutPaise: 6900 },
  { id: "audio_recording", label: "Audio / Voice Recording", defaultHours: 8, defaultPayoutPaise: 9900 },
  { id: "content_writing", label: "Content Writing", defaultHours: 24, defaultPayoutPaise: 9900 },
  { id: "caption_writing", label: "Caption Writing", defaultHours: 4, defaultPayoutPaise: 4900 },
  { id: "product_description", label: "Product Description Writing", defaultHours: 6, defaultPayoutPaise: 6900 },
  { id: "proofreading", label: "Proofreading", defaultHours: 6, defaultPayoutPaise: 6900 },
  { id: "app_testing", label: "Website / App Testing", defaultHours: 12, defaultPayoutPaise: 9900 },
  { id: "bug_reporting", label: "Bug Reporting", defaultHours: 8, defaultPayoutPaise: 6900 },
  { id: "html_css", label: "Basic HTML / CSS", defaultHours: 24, defaultPayoutPaise: 14900 },
  { id: "spreadsheet", label: "Spreadsheet Formatting", defaultHours: 8, defaultPayoutPaise: 6900 },
  { id: "long_video", label: "Long Video Editing", defaultHours: 48, defaultPayoutPaise: 24900 },
  { id: "advanced_design", label: "Advanced Graphic Design", defaultHours: 24, defaultPayoutPaise: 19900 },
  { id: "landing_page", label: "Landing Page Design", defaultHours: 48, defaultPayoutPaise: 29900 },
  { id: "social_package", label: "Social Media Content Package", defaultHours: 24, defaultPayoutPaise: 19900 },
  { id: "portfolio_design", label: "Portfolio / Presentation Design", defaultHours: 24, defaultPayoutPaise: 19900 },
  { id: "basic_website", label: "Basic Website Development", defaultHours: 72, defaultPayoutPaise: 39900 },
  { id: "advanced_spreadsheet", label: "Advanced Spreadsheet / Data Formatting", defaultHours: 12, defaultPayoutPaise: 14900 },
  { id: "ai_annotation", label: "AI / Data Annotation", defaultHours: 8, defaultPayoutPaise: 9900 },
  { id: "social_promo", label: "Social Media Promotion", defaultHours: 24, defaultPayoutPaise: 9900 },
  { id: "other", label: "Other / Custom Task", defaultHours: 24, defaultPayoutPaise: 9900 },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export const SUBMISSION_TYPES = [
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
  { id: "document", label: "Document" },
  { id: "url", label: "URL" },
  { id: "other", label: "Other" },
] as const;

export const MILESTONES = [
  { paise: 100_000, kind: "certificate", label: "Silver — ₹1,000 digital certificate", physical: false, configured: true },
  { paise: 500_000, kind: "physical_certificate_trophy", label: "Gold — ₹5,000", physical: true, configured: false },
  { paise: 1_000_000, kind: "trophy_watch", label: "Platinum — ₹10,000", physical: true, configured: false },
  { paise: 5_000_000, kind: "trophy_perfume", label: "Emerald — ₹50,000", physical: true, configured: false },
  { paise: 10_000_000, kind: "milestone_1l", label: "Topaz — ₹1,00,000", physical: true, configured: false },
  { paise: 20_000_000, kind: "milestone_2l", label: "Ruby — ₹2,00,000", physical: true, configured: false },
  { paise: 35_000_000, kind: "milestone_3_5l", label: "Diamond — ₹3,50,000", physical: true, configured: false },
  { paise: 50_000_000, kind: "milestone_5l", label: "Blue Diamond — ₹5,00,000", physical: true, configured: false },
] as const;

export const LANGUAGES = [
  { id: "en", label: "English" },
  { id: "hi", label: "हिन्दी" },
  { id: "hinglish", label: "Hinglish" },
  { id: "mr", label: "मराठी" },
  { id: "te", label: "తెలుగు" },
] as const;

export type Lang = (typeof LANGUAGES)[number]["id"];

export const TASK_STATUSES = [
  "draft",
  "awaiting_payment",
  "published",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export const SLOT_STATUSES = [
  "open",
  "claimed",
  "submitted",
  "revision",
  "approved",
  "disputed",
  "cancelled",
  "expired",
] as const;

export const WITHDRAWAL_STATUSES = [
  "requested",
  "pending",
  "processing",
  "paid",
  "failed",
  "cancelled",
  "reversed",
] as const;

export const REWARD_STATUSES = [
  "requested",
  "under_review",
  "approved",
  "preparing",
  "shipped",
  "delivered",
  "cancelled",
  "rejected",
] as const;

export function categoryById(id: string) {
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];
}

export function whatsappHref() {
  return `https://wa.me/91${SUPPORT_WHATSAPP}?text=${encodeURIComponent(SUPPORT_PREFILL)}`;
}
