import { makeQrDataUrl } from "./qr";

export async function downloadCertificate(opts: {
  id: string;
  studentName: string;
  title: string;
  issuedAt: string;
  origin: string;
}) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 675;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#08090c";
  ctx.fillRect(0, 0, 1200, 675);
  ctx.strokeStyle = "#c5ccd8";
  ctx.lineWidth = 2;
  ctx.strokeRect(48, 36, 1104, 603);
  ctx.fillStyle = "#8b90a0";
  ctx.font = "500 18px Sora, sans-serif";
  ctx.fillText("GROWNET CERTIFICATE", 80, 100);
  ctx.fillStyle = "#eef0f4";
  ctx.font = "500 48px Sora, sans-serif";
  ctx.fillText(opts.studentName.slice(0, 42), 80, 250);
  ctx.fillStyle = "#c5ccd8";
  ctx.font = "500 28px Sora, sans-serif";
  ctx.fillText(opts.title.slice(0, 60), 80, 310);
  ctx.fillStyle = "#8b90a0";
  ctx.font = "16px Figtree, sans-serif";
  ctx.fillText(`Issued ${new Date(opts.issuedAt).toLocaleDateString()}`, 80, 380);
  ctx.fillText(`Verification ID ${opts.id}`, 80, 410);
  const verify = `${opts.origin}/verify/${opts.id}`;
  ctx.fillText(verify, 80, 440);
  ctx.fillText("This record is valid only if it matches the live verification page.", 80, 520);
  try {
    const qr = await makeQrDataUrl(verify);
    const img = await load(qr);
    ctx.drawImage(img, 920, 380, 180, 180);
  } catch {
    /* QR is optional if the encoder fails */
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `grownet-certificate-${opts.id.slice(0, 8)}.png`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
