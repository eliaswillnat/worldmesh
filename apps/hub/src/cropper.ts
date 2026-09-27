/**
 * Interactive Image Cropper for WorldMesh cover images.
 * Supports drag-to-pan, slider zoom, mouse wheel zoom, and mobile pinch-to-zoom.
 * Constrains the image to a 3:4 aspect ratio with zero empty border margins.
 * Exports directly to compressed WebP.
 */

export interface CropperCallbacks {
  onZoomChange?: (zoom: number) => void;
  onImageLoaded?: () => void;
  onClear?: () => void;
}

export class ImageCropper {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: HTMLImageElement | null = null;

  // Internal high-res resolution (3:4 aspect ratio)
  readonly targetWidth = 600;
  readonly targetHeight = 800;

  // Zoom range
  readonly minZoom = 1.0;
  readonly maxZoom = 3.0;
  private zoom = 1.0;

  // Offset in canvas coordinates
  private panX = 0;
  private panY = 0;

  // Interaction tracking
  private activePointers = new Map<number, { x: number; y: number }>();
  private initialPinchDist: number | null = null;
  private initialPinchZoom = 1.0;
  private lastPointerPos: { x: number; y: number } | null = null;
  private isPointerDown = false;

  private callbacks: CropperCallbacks;

  constructor(canvas: HTMLCanvasElement, callbacks: CropperCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.canvas.width = this.targetWidth;
    this.canvas.height = this.targetHeight;
    this.ctx = canvas.getContext('2d')!;

    this.attachEvents();
  }

  hasImage(): boolean {
    return this.img !== null;
  }

  getZoom(): number {
    return this.zoom;
  }

  async loadFile(file: File): Promise<void> {
    const objectUrl = URL.createObjectURL(file);
    try {
      await this.loadUrl(objectUrl);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  loadUrl(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.img = img;
        this.resetTransform();
        this.draw();
        this.callbacks.onImageLoaded?.();
        resolve();
      };
      img.onerror = (err) => {
        reject(err);
      };
      img.src = url;
    });
  }

  clear(): void {
    this.img = null;
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.ctx.clearRect(0, 0, this.targetWidth, this.targetHeight);
    this.callbacks.onClear?.();
  }

  resetTransform(): void {
    if (!this.img) return;
    this.zoom = 1.0;
    const baseScale = this.getBaseScale();
    const renderW = this.img.naturalWidth * baseScale;
    const renderH = this.img.naturalHeight * baseScale;
    this.panX = (this.targetWidth - renderW) / 2;
    this.panY = (this.targetHeight - renderH) / 2;
    this.callbacks.onZoomChange?.(this.zoom);
    this.draw();
  }

  setZoom(newZoom: number, focalPoint?: { x: number; y: number }): void {
    if (!this.img) return;

    const clampedZoom = Math.min(Math.max(newZoom, this.minZoom), this.maxZoom);
    if (Math.abs(clampedZoom - this.zoom) < 0.0001) return;

    const fx = focalPoint ? focalPoint.x : this.targetWidth / 2;
    const fy = focalPoint ? focalPoint.y : this.targetHeight / 2;

    const oldScale = this.getBaseScale() * this.zoom;
    const imgX = (fx - this.panX) / oldScale;
    const imgY = (fy - this.panY) / oldScale;

    this.zoom = clampedZoom;
    const newScale = this.getBaseScale() * this.zoom;

    this.panX = fx - imgX * newScale;
    this.panY = fy - imgY * newScale;

    this.clampPan();
    this.draw();
    this.callbacks.onZoomChange?.(this.zoom);
  }

  private getBaseScale(): number {
    if (!this.img) return 1;
    return Math.max(
      this.targetWidth / this.img.naturalWidth,
      this.targetHeight / this.img.naturalHeight,
    );
  }

  private clampPan(): void {
    if (!this.img) return;
    const scale = this.getBaseScale() * this.zoom;
    const renderW = this.img.naturalWidth * scale;
    const renderH = this.img.naturalHeight * scale;

    const minX = this.targetWidth - renderW;
    const maxX = 0;
    const minY = this.targetHeight - renderH;
    const maxY = 0;

    this.panX = Math.min(Math.max(this.panX, minX), maxX);
    this.panY = Math.min(Math.max(this.panY, minY), maxY);
  }

  private draw(): void {
    this.ctx.clearRect(0, 0, this.targetWidth, this.targetHeight);
    if (!this.img) return;

    const scale = this.getBaseScale() * this.zoom;
    const renderW = this.img.naturalWidth * scale;
    const renderH = this.img.naturalHeight * scale;

    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(this.img, this.panX, this.panY, renderW, renderH);
  }

  /**
   * Exports the cropped 3:4 canvas as a WebP data URL.
   */
  exportWebP(quality = 0.85): string {
    if (!this.img) return '';
    return this.canvas.toDataURL('image/webp', quality);
  }

  /**
   * Exports the cropped canvas as a WebP Blob.
   */
  exportBlob(quality = 0.85): Promise<Blob | null> {
    return new Promise((resolve) => {
      if (!this.img) {
        resolve(null);
        return;
      }
      this.canvas.toBlob(
        (blob) => {
          resolve(blob);
        },
        'image/webp',
        quality,
      );
    });
  }

  private attachEvents(): void {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.img) return;
      canvas.setPointerCapture(e.pointerId);
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.isPointerDown = true;

      if (this.activePointers.size === 1) {
        this.lastPointerPos = { x: e.clientX, y: e.clientY };
      } else if (this.activePointers.size === 2) {
        // Start pinch
        const [p1, p2] = Array.from(this.activePointers.values());
        this.initialPinchDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        this.initialPinchZoom = this.zoom;
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.isPointerDown || !this.img) return;

      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.activePointers.size === 2 && this.initialPinchDist) {
        // Pinch zoom
        const [p1, p2] = Array.from(this.activePointers.values());
        const currentDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const ratio = currentDist / this.initialPinchDist;
        const targetZoom = this.initialPinchZoom * ratio;

        const rect = canvas.getBoundingClientRect();
        const centerClientX = (p1.x + p2.x) / 2;
        const centerClientY = (p1.y + p2.y) / 2;
        const focalX = ((centerClientX - rect.left) / rect.width) * this.targetWidth;
        const focalY = ((centerClientY - rect.top) / rect.height) * this.targetHeight;

        this.setZoom(targetZoom, { x: focalX, y: focalY });
      } else if (this.activePointers.size === 1 && this.lastPointerPos) {
        // Drag / Pan
        const rect = canvas.getBoundingClientRect();
        const scaleFactor = this.targetWidth / rect.width;

        const dx = (e.clientX - this.lastPointerPos.x) * scaleFactor;
        const dy = (e.clientY - this.lastPointerPos.y) * scaleFactor;

        this.panX += dx;
        this.panY += dy;
        this.clampPan();
        this.draw();

        this.lastPointerPos = { x: e.clientX, y: e.clientY };
      }
    });

    const onPointerUp = (e: PointerEvent) => {
      this.activePointers.delete(e.pointerId);
      if (this.activePointers.size < 2) {
        this.initialPinchDist = null;
      }
      if (this.activePointers.size === 1) {
        const remaining = Array.from(this.activePointers.values())[0];
        this.lastPointerPos = remaining;
      } else if (this.activePointers.size === 0) {
        this.isPointerDown = false;
        this.lastPointerPos = null;
      }
    };

    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    // Mouse wheel zoom
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.img) return;
        e.preventDefault();

        const rect = canvas.getBoundingClientRect();
        const focalX = ((e.clientX - rect.left) / rect.width) * this.targetWidth;
        const focalY = ((e.clientY - rect.top) / rect.height) * this.targetHeight;

        // Smooth zoom step
        const delta = e.deltaY < 0 ? 0.08 : -0.08;
        this.setZoom(this.zoom + delta, { x: focalX, y: focalY });
      },
      { passive: false },
    );
  }
}
