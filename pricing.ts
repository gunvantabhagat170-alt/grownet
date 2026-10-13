export function minimumPayoutPaise(category: string, videoSeconds: number | null): number {
  if (
    category === "image_editing" ||
    category === "product_image_editing" ||
    category === "background_removal" ||
    category === "image_poster" ||
    category === "youtube_thumbnail"
  ) {
    return 900;
  }
  if (category === "website_testing" || category === "app_testing" || category === "bug_reporting") {
    return 1000;
  }
  if (
    category === "content_writing" ||
    category === "caption_writing" ||
    category === "product_description" ||
    category === "proofreading"
  ) {
    return 5000;
  }
  if (category === "video_editing" || category === "reel_editing" || category === "long_video") {
    const seconds = videoSeconds ?? 0;
    if (seconds > 300) return 35000;
    if (seconds > 120) return 20000;
    if (seconds > 60) return 15000;
    return 9000;
  }
  return 1000;
}
