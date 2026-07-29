import { useEffect } from 'react';
import { useT } from '../i18n/index.js';

export interface ZoomImage {
  src: string;
  alt?: string;
}

/**
 * In-page image preview overlay ("lightbox"). Replaces the old behavior of
 * opening image attachments in a new browser tab — clicking a thumbnail now
 * blows the image up over the current page. Dismisses on backdrop click, the
 * close button, or Escape. Rendered once at the App root; `image` drives
 * visibility (null = closed).
 */
export function ImageLightbox({
  image,
  onClose,
}: {
  image: ZoomImage | null;
  onClose: () => void;
}) {
  const t = useT();

  useEffect(() => {
    if (!image) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [image, onClose]);

  if (!image) return null;

  return (
    <div
      className="img-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={image.alt || t('common.close')}
      onClick={onClose}
    >
      <button
        type="button"
        className="img-lightbox-close btn ghost sm icon"
        aria-label={t('common.close')}
        title={t('common.close')}
        onClick={onClose}
      >
        ×
      </button>
      {/* Stop propagation so clicking the image itself doesn't dismiss. */}
      <img
        className="img-lightbox-img"
        src={image.src}
        alt={image.alt ?? ''}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
