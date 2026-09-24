'use client';

import { useRef } from 'react';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { notify } from '@/lib/notify';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://support-mee.vercel.app';

interface QrCodeCardCreator {
  username: string;
}

interface QrCodeCardProps {
  creator: QrCodeCardCreator;
}

const QR_SIZE = 220;
// Rendered off-screen at a higher resolution than displayed, so the
// downloaded PNG is crisp when printed or scaled up rather than a 1:1 copy
// of the small on-screen preview.
const DOWNLOAD_SIZE = 1024;

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * A creator's public donation page as a scannable QR code, with PNG and SVG
 * download options. Always reads `creator.username` from the live prop
 * rather than capturing it once, so it stays correct if the creator renames
 * themselves without needing to remount this component.
 */
export function QrCodeCard({ creator }: QrCodeCardProps) {
  const downloadCanvasRef = useRef<HTMLCanvasElement>(null);
  const profileUrl = `${SITE_URL}/${creator.username}`;

  const handleDownloadPng = () => {
    const canvas = downloadCanvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) {
        notify.error('Could not generate the QR code image.');
        return;
      }
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `${creator.username}-supportme-qr.png`);
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

  const handleDownloadSvg = () => {
    // The visible QRCodeSVG below renders the actual <svg> in the DOM; the
    // download re-serializes that same element rather than rendering a
    // second, hidden SVG copy just for export.
    const svg = document.getElementById('qr-code-card-svg');
    if (!svg) {
      notify.error('Could not generate the QR code image.');
      return;
    }
    const serialized = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([serialized], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `${creator.username}-supportme-qr.svg`);
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card-brutal p-8 space-y-4">
      <div>
        <h2 className="text-lg font-extrabold text-ink">QR code</h2>
        <p className="text-sm text-muted font-medium">
          Scan to open your donation page, or print it wherever supporters can see it.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-6">
        <div className="border-2 border-ink rounded p-3 bg-white shrink-0">
          <QRCodeSVG id="qr-code-card-svg" value={profileUrl} size={QR_SIZE} level="M" includeMargin={false} />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <p className="text-sm text-muted font-medium break-all">{profileUrl}</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={handleDownloadPng} className="btn-brutal btn-brutal-primary">
              Download PNG
            </button>
            <button type="button" onClick={handleDownloadSvg} className="btn-brutal btn-brutal-white">
              Download SVG
            </button>
          </div>
        </div>
      </div>

      {/* Offscreen, higher-resolution source for the PNG download only; the
          visible QR code above is the QRCodeSVG. */}
      <div className="hidden">
        <QRCodeCanvas ref={downloadCanvasRef} value={profileUrl} size={DOWNLOAD_SIZE} level="M" includeMargin={false} />
      </div>
    </section>
  );
}
