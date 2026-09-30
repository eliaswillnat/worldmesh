/**
 * Stripe.js, loaded from js.stripe.com only when someone reaches the payment
 * step (Stripe requires it be loaded from there, never bundled). Only the
 * publishable key ever reaches the browser; it comes from the server with the
 * PaymentIntent.
 */

export interface StripeElement {
  mount(target: HTMLElement): void;
  on(event: 'ready' | 'change', handler: (event: { complete?: boolean }) => void): void;
  destroy(): void;
}

export interface StripeElements {
  create(type: 'payment', options?: Record<string, unknown>): StripeElement;
}

export interface StripeError {
  type: string;
  message?: string;
}

export interface StripeClient {
  elements(options: Record<string, unknown>): StripeElements;
  confirmPayment(options: {
    elements: StripeElements;
    redirect: 'if_required';
    confirmParams: { return_url: string };
  }): Promise<{ error?: StripeError; paymentIntent?: { id: string; status: string } }>;
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeClient;
  }
}

const STRIPE_JS = 'https://js.stripe.com/v3/';
let loading: Promise<void> | null = null;

export async function loadStripe(publishableKey: string): Promise<StripeClient> {
  if (!window.Stripe) {
    loading ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = STRIPE_JS;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        loading = null;
        script.remove();
        reject(new Error('Could not load the payment form.'));
      };
      document.head.appendChild(script);
    });
    await loading;
  }
  if (!window.Stripe) throw new Error('Could not load the payment form.');
  return window.Stripe(publishableKey);
}
