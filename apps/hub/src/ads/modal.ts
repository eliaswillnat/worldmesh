import { ApiError, cancelSubmission, confirmSubmission, createSubmission, type CreatedSubmission } from './api';
import {
  AD_CONFIG,
  durationLabel,
  formatBytes,
  limitsFor,
  mimeForExtension,
  normalizeDestinationUrl,
  normalizeEmail,
  sanitizeAdvertiserName,
  type AdMediaType,
} from './config';
import { loadStripe, type StripeClient, type StripeElement, type StripeElements } from './stripe';

/**
 * The advertisement form, opened from an empty billboard:
 *
 *   upload → preview → details → pay €2 (authorized, not captured) → in review
 *
 * Everything here is convenience and early feedback. The server re-checks
 * every field and file, and only Stripe (via the server) decides whether a
 * payment was authorized.
 */

export interface AdModalSlot {
  id: string;
  width: number;
  height: number;
  wide: boolean;
  description: string;
}

export interface AdModalOptions {
  slot: AdModalSlot;
  /** Draw the payment form light or dark. */
  light: boolean;
  onClose(): void;
  /** A submission reached review: refresh the billboards so this one shows as reserved. */
  onSubmitted(): void;
}

const SUBMITTED_MESSAGE =
  'Your advertisement has been submitted for review. You will receive an email once it has been approved or rejected.';

const TOKEN_KEY = (id: string) => `worldmesh.ad.${id}`;

type Step = 'form' | 'uploading' | 'payment' | 'done';

interface Media {
  file: File;
  type: AdMediaType;
  mime: string;
  url: string;
  poster: Blob | null;
}

export function openAdModal(options: AdModalOptions): { close(): void } {
  const { slot } = options;
  let step: Step = 'form';
  let mediaType: AdMediaType = 'image';
  let media: Media | null = null;
  let submission: CreatedSubmission | null = null;
  let stripe: StripeClient | null = null;
  let elements: StripeElements | null = null;
  let paymentElement: StripeElement | null = null;
  let holdTimer = 0;
  let closed = false;

  const dialog = el('dialog', { class: 'ad-dialog', 'aria-labelledby': 'ad-dialog-title' }) as HTMLDialogElement;
  // Keep the 3D world's controls out of the form: no walking or looking
  // around while typing, tapping or dragging in here.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'keyup', 'wheel', 'touchstart']) {
    dialog.addEventListener(type, (event) => event.stopPropagation());
  }
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (step !== 'uploading') close();
  });
  dialog.addEventListener('click', (event) => {
    // A click on the backdrop (the dialog element itself) closes it.
    if (event.target === dialog && step !== 'uploading') close();
  });

  const closeButton = el('button', { type: 'button', class: 'ad-close', 'aria-label': 'Close' }, '×');
  closeButton.addEventListener('click', () => close());
  const title = el('h2', { id: 'ad-dialog-title' }, 'Advertise on this billboard');
  const body = el('div', { class: 'ad-body' });
  dialog.append(el('header', { class: 'ad-header' }, title, closeButton), body);
  document.body.appendChild(dialog);
  // Release any keys held when the dialog opened, so the player does not walk on.
  window.dispatchEvent(new Event('blur'));
  dialog.showModal();

  window.addEventListener('pagehide', handlePageHide);
  renderForm();
  return { close };

  // ── Step 1: the form ──────────────────────────────────────────────────────

  function renderForm(): void {
    step = 'form';
    title.textContent = 'Advertise on this billboard';
    const limits = limitsFor(mediaType);
    const [recommendedW, recommendedH] = slot.wide ? [2160, 1080] : [1080, 2160];

    const summary = el(
      'p',
      { class: 'ad-summary' },
      el('strong', {}, AD_CONFIG.priceLabel),
      ` · runs ${durationLabel()} after approval · ${slot.description}`,
    );
    const review = el(
      'p',
      { class: 'ad-review-note' },
      el('strong', {}, 'Every advertisement is reviewed by hand before it goes live. '),
      `Your card is only authorized now. You are charged ${AD_CONFIG.priceLabel} only if the advertisement is approved; if it is rejected, the authorization is released and you pay nothing.`,
    );

    const typeImage = radio('ad-type', 'image', 'Image', mediaType === 'image');
    const typeVideo = radio('ad-type', 'video', 'Video', mediaType === 'video');
    const typeSwitch = el('div', { class: 'ad-segmented', role: 'radiogroup', 'aria-label': 'Advertisement type' }, typeImage.label, typeVideo.label);
    for (const option of [typeImage, typeVideo]) {
      option.input.addEventListener('change', () => {
        if (!option.input.checked) return;
        mediaType = option.input.value as AdMediaType;
        clearMedia();
        renderForm();
      });
    }

    const extensions = Object.values(limits.types).flat();
    const fileInput = el('input', {
      type: 'file',
      class: 'ad-file-input',
      accept: [...Object.keys(limits.types), ...extensions.map((ext) => `.${ext}`)].join(','),
    }) as HTMLInputElement;
    const fileLabel = el(
      'label',
      { class: 'ad-drop' },
      fileInput,
      el('span', { class: 'ad-drop-title' }, media ? media.file.name : mediaType === 'image' ? 'Choose an image' : 'Choose a video'),
      el(
        'span',
        { class: 'ad-drop-hint' },
        mediaType === 'image'
          ? `PNG, JPG or WebP · up to ${formatBytes(limits.maxBytes)}`
          : `MP4 or WebM · up to ${formatBytes(limits.maxBytes)} · ${AD_CONFIG.video.maxSeconds} s · plays muted`,
      ),
    );

    // Same shape as the billboard: portrait screens by height, landscape by width.
    const shape = slot.wide ? 'width: 100%' : 'height: min(42vh, 360px); width: auto';
    const preview = el('div', { class: 'ad-preview', style: `aspect-ratio: ${slot.width} / ${slot.height}; ${shape}` });
    preview.append(el('span', { class: 'ad-preview-empty' }, 'Preview'));
    const hint = el(
      'p',
      { class: 'ad-hint' },
      `Shown whole on a ${slot.wide ? 'landscape 2:1' : 'portrait 1:2'} screen, never cropped. Best at ${recommendedW} × ${recommendedH} px.`,
    );

    const url = field('Destination URL', { type: 'url', name: 'destinationUrl', placeholder: 'https://', autocomplete: 'url', inputmode: 'url', required: '', maxlength: String(AD_CONFIG.text.urlMaxLength) });
    const name = field('Advertiser, creator or project name', { type: 'text', name: 'advertiserName', autocomplete: 'organization', required: '', maxlength: String(AD_CONFIG.text.advertiserMaxLength) });
    const email = field('Contact email', { type: 'email', name: 'contactEmail', autocomplete: 'email', required: '', maxlength: String(AD_CONFIG.text.emailMaxLength) });
    const consentInput = el('input', { type: 'checkbox', name: 'consent', required: '' }) as HTMLInputElement;
    const consent = el(
      'label',
      { class: 'ad-consent' },
      consentInput,
      el('span', {}, 'I confirm that I own or have permission to use this content and that the advertisement does not contain illegal, misleading or prohibited material.'),
    );
    const error = el('p', { class: 'ad-error', role: 'alert' });
    const submit = el('button', { type: 'submit', class: 'ad-primary' }, `Continue to payment · ${AD_CONFIG.priceLabel}`);

    const form = el('form', { class: 'ad-form', novalidate: '' }, summary, review, typeSwitch, fileLabel, preview, hint, url.wrap, name.wrap, email.wrap, consent, error, submit) as HTMLFormElement;
    body.replaceChildren(form);
    if (media) showPreview(preview, media);

    // A message about a field goes away as soon as the field is touched again.
    form.addEventListener('input', () => {
      error.textContent = '';
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      error.textContent = '';
      fileLabel.classList.add('busy');
      try {
        const next = await readMedia(file, mediaType);
        clearMedia();
        media = next;
        fileLabel.querySelector('.ad-drop-title')!.textContent = file.name;
        showPreview(preview, next);
      } catch (problem) {
        clearMedia();
        fileInput.value = '';
        fileLabel.querySelector('.ad-drop-title')!.textContent = mediaType === 'image' ? 'Choose an image' : 'Choose a video';
        preview.replaceChildren(el('span', { class: 'ad-preview-empty' }, 'Preview'));
        error.textContent = problem instanceof Error ? problem.message : 'That file cannot be used.';
      } finally {
        fileLabel.classList.remove('busy');
      }
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      error.textContent = '';
      const destination = normalizeDestinationUrl(url.input.value);
      const advertiser = sanitizeAdvertiserName(name.input.value);
      const contact = normalizeEmail(email.input.value);
      const problem = !media
        ? `Choose ${mediaType === 'image' ? 'an image' : 'a video'} to upload.`
        : !destination
          ? 'Enter a destination URL starting with https:// (other link types are not allowed).'
          : !advertiser
            ? `Enter the advertiser, creator or project name (up to ${AD_CONFIG.text.advertiserMaxLength} characters).`
            : !contact
              ? 'Enter a valid contact email. We write to it when the advertisement is approved or rejected.'
              : !consentInput.checked
                ? 'Please confirm that you have the rights to this content and that it is allowed.'
                : null;
      if (problem) {
        error.textContent = problem;
        return;
      }
      url.input.value = destination!;
      void upload({ destination: destination!, advertiser: advertiser!, contact: contact! });
    });
  }

  // ── Step 2: upload and reserve ────────────────────────────────────────────

  async function upload(details: { destination: string; advertiser: string; contact: string }): Promise<void> {
    if (!media) return;
    step = 'uploading';
    title.textContent = 'Uploading…';
    const bar = el('div', { class: 'ad-progress-bar' });
    const status = el('p', { class: 'ad-status' }, 'Uploading your advertisement and reserving the billboard…');
    body.replaceChildren(el('div', { class: 'ad-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar), status);

    const form = new FormData();
    form.set('billboardId', slot.id);
    form.set('mediaType', media.type);
    form.set('media', media.file, media.file.name);
    if (media.poster) form.set('poster', media.poster, 'poster.jpg');
    form.set('destinationUrl', details.destination);
    form.set('advertiserName', details.advertiser);
    form.set('contactEmail', details.contact);
    form.set('consent', 'yes');
    try {
      submission = await createSubmission(form, (fraction) => {
        bar.style.width = `${Math.round(fraction * 100)}%`;
      });
    } catch (problem) {
      if (closed) return;
      renderForm();
      const message =
        problem instanceof ApiError && problem.status === 409
          ? 'Someone else has just reserved this billboard. Please pick another empty one.'
          : problem instanceof Error
            ? problem.message
            : 'The upload did not go through.';
      body.querySelector('.ad-error')!.textContent = message;
      return;
    }
    if (closed) {
      cancelSubmission(submission.id, submission.token);
      return;
    }
    try {
      sessionStorage.setItem(TOKEN_KEY(submission.id), submission.token);
    } catch {
      // Private mode: only needed if the bank redirects away mid-payment.
    }
    await renderPayment();
  }

  // ── Step 3: authorize €2 ──────────────────────────────────────────────────

  async function renderPayment(): Promise<void> {
    if (!submission) return;
    step = 'payment';
    title.textContent = `Authorize ${AD_CONFIG.priceLabel}`;
    const mount = el('div', { class: 'ad-payment-element' });
    const timer = el('p', { class: 'ad-timer' });
    const error = el('p', { class: 'ad-error', role: 'alert' });
    const pay = el('button', { type: 'button', class: 'ad-primary', disabled: '' }, `Authorize ${AD_CONFIG.priceLabel}`) as HTMLButtonElement;
    const back = el('button', { type: 'button', class: 'ad-secondary' }, 'Cancel and release the billboard');
    body.replaceChildren(
      el(
        'p',
        { class: 'ad-review-note' },
        `${AD_CONFIG.priceLabel} is held on your card, not charged. It is charged only if your advertisement is approved, and released if it is rejected or not reviewed in time.`,
      ),
      mount,
      timer,
      error,
      pay,
      back,
    );
    back.addEventListener('click', () => close());

    const tick = () => {
      const left = Math.max(0, submission!.holdExpiresAt - Date.now());
      const minutes = Math.floor(left / 60000);
      const seconds = Math.floor((left % 60000) / 1000);
      timer.textContent = left > 0 ? `Billboard reserved for you for ${minutes}:${String(seconds).padStart(2, '0')}` : 'Your reservation has run out. Close this and start again.';
      if (left <= 0) {
        pay.disabled = true;
        window.clearInterval(holdTimer);
      }
    };
    tick();
    holdTimer = window.setInterval(tick, 1000);

    try {
      stripe = await loadStripe(submission.publishableKey);
      if (closed) return;
      elements = stripe.elements({
        clientSecret: submission.clientSecret,
        appearance: {
          theme: options.light ? 'stripe' : 'night',
          variables: { fontFamily: 'Urbanist, ui-sans-serif, system-ui, sans-serif', borderRadius: '10px' },
        },
        fonts: [{ cssSrc: 'https://fonts.googleapis.com/css2?family=Urbanist:wght@400;500;600&display=swap' }],
      });
      paymentElement = elements.create('payment', { layout: 'tabs' });
      paymentElement.on('ready', () => {
        pay.disabled = submission!.holdExpiresAt <= Date.now();
      });
      paymentElement.mount(mount);
    } catch (problem) {
      error.textContent = problem instanceof Error ? problem.message : 'Could not load the payment form.';
      return;
    }

    pay.addEventListener('click', async () => {
      if (!stripe || !elements || !submission) return;
      pay.disabled = true;
      back.setAttribute('disabled', '');
      error.textContent = '';
      pay.textContent = 'Authorizing…';
      const result = await stripe.confirmPayment({
        elements,
        redirect: 'if_required',
        confirmParams: { return_url: `${window.location.origin}/?ad_return=${encodeURIComponent(submission.id)}` },
      });
      if (closed) return;
      if (result.error) {
        // Declines and validation problems: let them fix it and try again.
        error.textContent = result.error.message || 'The payment could not be authorized.';
        pay.disabled = submission.holdExpiresAt <= Date.now();
        back.removeAttribute('disabled');
        pay.textContent = `Authorize ${AD_CONFIG.priceLabel}`;
        return;
      }
      await finish();
    });
  }

  /** Stripe accepted the card; ask the server, which asks Stripe, whether it really is authorized. */
  async function finish(): Promise<void> {
    if (!submission) return;
    try {
      const result = await confirmSubmission(submission.id, submission.token);
      if (result.status === 'pending' || result.status === 'approved' || result.status === 'active') {
        renderDone();
        return;
      }
      renderProblem(result.message || 'The payment was not authorized. You have not been charged.');
    } catch (problem) {
      // The webhook will still pick it up; do not make them pay twice.
      renderProblem(
        problem instanceof Error
          ? `${problem.message} If your card was authorized, your advertisement is still submitted and you will get an email.`
          : 'Could not confirm the payment.',
      );
    }
  }

  // ── Step 4: in review ─────────────────────────────────────────────────────

  function renderDone(): void {
    step = 'done';
    window.clearInterval(holdTimer);
    try {
      if (submission) sessionStorage.removeItem(TOKEN_KEY(submission.id));
    } catch {
      // Ignore.
    }
    title.textContent = 'Submitted for review';
    const ok = el('button', { type: 'button', class: 'ad-primary' }, 'Back to the city');
    ok.addEventListener('click', () => close());
    body.replaceChildren(el('div', { class: 'ad-done-icon', 'aria-hidden': 'true' }, '✓'), el('p', { class: 'ad-done' }, SUBMITTED_MESSAGE), ok);
    options.onSubmitted();
  }

  function renderProblem(message: string): void {
    step = 'done';
    window.clearInterval(holdTimer);
    title.textContent = 'Something went wrong';
    const ok = el('button', { type: 'button', class: 'ad-primary' }, 'Close');
    ok.addEventListener('click', () => close());
    body.replaceChildren(el('p', { class: 'ad-error' }, message), ok);
    options.onSubmitted();
  }

  // ── Closing ───────────────────────────────────────────────────────────────

  function close(): void {
    if (closed) return;
    closed = true;
    // Walking away from the payment step releases the billboard right away
    // (the server double-checks with Stripe first, in case it was authorized).
    if (step === 'payment' && submission) cancelSubmission(submission.id, submission.token);
    window.clearInterval(holdTimer);
    window.removeEventListener('pagehide', handlePageHide);
    paymentElement?.destroy();
    clearMedia();
    dialog.close();
    dialog.remove();
    options.onClose();
  }

  function handlePageHide(): void {
    if (step === 'payment' && submission) cancelSubmission(submission.id, submission.token, true);
  }

  function clearMedia(): void {
    if (media) URL.revokeObjectURL(media.url);
    media = null;
  }
}

/**
 * The advertiser came back from a bank redirect during payment (rare for
 * cards). Returns the submission id to confirm, if any, and cleans the URL.
 */
export async function resumeReturnedSubmission(): Promise<string | null> {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('ad_return');
  if (!id) return null;
  for (const key of ['ad_return', 'payment_intent', 'payment_intent_client_secret', 'redirect_status']) params.delete(key);
  const query = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  let token: string | null = null;
  try {
    token = sessionStorage.getItem(TOKEN_KEY(id));
    sessionStorage.removeItem(TOKEN_KEY(id));
  } catch {
    // Ignore.
  }
  if (!token) return null;
  try {
    const result = await confirmSubmission(id, token);
    return result.status === 'pending' ? SUBMITTED_MESSAGE : result.message || 'The payment was not authorized. You have not been charged.';
  } catch {
    return 'We could not confirm your payment yet. If it was authorized, you will receive an email.';
  }
}

// ── Media checks ────────────────────────────────────────────────────────────

/** Validate a picked file like the server will, and make a still frame for videos. */
async function readMedia(file: File, type: AdMediaType): Promise<Media> {
  const limits = limitsFor(type);
  const mime = mimeForExtension(type, file.name);
  if (!mime || (file.type && file.type !== mime && !(mime === 'image/jpeg' && file.type === 'image/jpg'))) {
    throw new Error(type === 'image' ? 'Images must be PNG, JPG or WebP.' : 'Videos must be MP4 or WebM.');
  }
  if (file.size > limits.maxBytes) throw new Error(`That file is ${formatBytes(file.size)}; the limit is ${formatBytes(limits.maxBytes)}.`);
  if (file.size === 0) throw new Error('That file is empty.');
  const url = URL.createObjectURL(file);
  try {
    if (type === 'image') {
      const image = new Image();
      image.src = url;
      await image.decode().catch(() => {
        throw new Error('That image could not be read.');
      });
      if (Math.max(image.naturalWidth, image.naturalHeight) > AD_CONFIG.image.maxDimension) {
        throw new Error(`Images can be at most ${AD_CONFIG.image.maxDimension} px on their longest side.`);
      }
      return { file, type, mime, url, poster: null };
    }
    const video = await loadVideo(url);
    if (!Number.isFinite(video.duration) || video.duration > AD_CONFIG.video.maxSeconds + 0.5) {
      throw new Error(`Videos can be at most ${AD_CONFIG.video.maxSeconds} seconds long.`);
    }
    if (Math.max(video.videoWidth, video.videoHeight) > AD_CONFIG.video.maxDimension) {
      throw new Error(`Videos can be at most ${AD_CONFIG.video.maxDimension} px on their longest side (1080p).`);
    }
    const poster = await captureFrame(video).catch(() => null);
    video.removeAttribute('src');
    video.load();
    return { file, type, mime, url, poster };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const timer = window.setTimeout(() => reject(new Error('That video could not be read.')), 15000);
    video.addEventListener('loadeddata', () => {
      window.clearTimeout(timer);
      resolve(video);
    }, { once: true });
    video.addEventListener('error', () => {
      window.clearTimeout(timer);
      reject(new Error('That video could not be played in this browser. Try MP4 (H.264).'));
    }, { once: true });
    video.src = url;
  });
}

/** A JPEG still from early in the video: shown while it is far away, and in the review email. */
function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('timeout')), 6000);
    video.addEventListener(
      'seeked',
      () => {
        window.clearTimeout(timer);
        const { maxDimension, maxBytes } = AD_CONFIG.poster;
        const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
        const encode = (quality: number) =>
          canvas.toBlob(
            (blob) => {
              if (!blob) return reject(new Error('encode'));
              if (blob.size > maxBytes && quality > 0.45) encode(quality - 0.15);
              else if (blob.size > maxBytes) reject(new Error('too large'));
              else resolve(blob);
            },
            'image/jpeg',
            quality,
          );
        encode(0.82);
      },
      { once: true },
    );
    video.currentTime = Math.min(1, video.duration * 0.1);
  });
}

function showPreview(container: HTMLElement, media: Media): void {
  const node =
    media.type === 'image'
      ? el('img', { src: media.url, alt: 'Advertisement preview' })
      : (() => {
          const video = el('video', { src: media.url, muted: '', autoplay: '', loop: '', playsinline: '', 'aria-label': 'Advertisement preview' }) as HTMLVideoElement;
          video.muted = true;
          void video.play().catch(() => {});
          return video;
        })();
  container.replaceChildren(node, el('span', { class: 'ad-badge' }, 'Ad'));
}

// ── Tiny DOM helpers ────────────────────────────────────────────────────────

/** Text children are always set as text, never parsed as HTML. */
function el(tag: string, attributes: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function field(label: string, attributes: Record<string, string>): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { class: 'ad-input', ...attributes }) as HTMLInputElement;
  return { wrap: el('label', { class: 'ad-field' }, el('span', {}, label), input), input };
}

function radio(name: string, value: string, text: string, checked: boolean): { label: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { type: 'radio', name, value }) as HTMLInputElement;
  input.checked = checked;
  return { label: el('label', { class: 'ad-segment' }, input, el('span', {}, text)), input };
}
