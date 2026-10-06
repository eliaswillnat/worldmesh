/**
 * The account corner: Log in → email + password or Google / Apple / GitHub /
 * Discord; once signed in,
 * avatar, name, username and Log out. Talks to workers/auth over plain fetch
 * on the same origin (no auth client library in the bundle).
 *
 * Visitors who have never signed in cost nothing: /api/account/me is only
 * asked when this browser has signed in before.
 *
 * Signed in, the dialog also offers "Choose your character" (./avatars.ts).
 */

import { characterSummary, initAvatarWallet, setSignedIn, walletView } from './avatars';

interface AccountUser {
  id: string;
  name: string;
  image: string | null;
  username: string | null;
  handle: string | null;
}

type Provider = 'google' | 'apple' | 'github' | 'discord';

const PROVIDER_LABELS: Record<Provider, string> = {
  google: 'Continue with Google',
  apple: 'Continue with Apple',
  github: 'Continue with GitHub',
  discord: 'Continue with Discord',
};

/** Not a credential: only a hint that asking /api/account/me is worthwhile. */
const HINT_KEY = 'worldmesh.account';
/** Handles live on the hub's own domain: @username@worldmesh.net. */
const HANDLE_DOMAIN = window.location.hostname;

const button = document.querySelector<HTMLButtonElement>('#account-button')!;
const dialog = document.querySelector<HTMLDialogElement>('#account-dialog')!;
const body = dialog.querySelector<HTMLDivElement>('.account-body')!;

let user: AccountUser | null = null;
let busy = false;
let message: { text: string; error: boolean } | null = null;
/** Sign-in options the server has credentials for; asked once, when the dialog first opens. */
let providers: Provider[] | null = null;
/** Whether the server can email reset links (and requires verified emails). */
let passwordReset = false;
type View = 'sign-in' | 'sign-up' | 'forgot' | 'reset';
let view: View = 'sign-in';
/** From a reset link: /?auth=reset&token=… */
let resetToken: string | null = null;
/** Kept across re-renders so a failed attempt doesn't wipe what was typed. */
let draft = { name: '', email: '', password: '' };
/** Which page of the signed-in dialog is showing. */
let signedInView: 'account' | 'wallet' = 'account';
/** Came back from connecting an avatar platform: open the wallet once signed in. */
let openWallet = false;

const PROFILE_ICON =
  '<svg class="account-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';
/** The mobile menu button shows the same profile icon, or the avatar once signed in. */
const mobileProfile = document.querySelector<HTMLSpanElement>('#mobile-profile');

export function openAccountDialog(): void {
  message = null;
  signedInView = 'account';
  if (view === 'forgot' || (view === 'reset' && !resetToken)) view = 'sign-in';
  renderDialog();
  dialog.showModal();
  if (!user && !providers) void loadProviders();
}

/** The signed-in visitor's username, or null for guests. */
export function getUsername(): string | null {
  return user?.username ?? null;
}

/** The signed-in visitor's account id, or null for guests. */
export function getAccountId(): string | null {
  return user?.id ?? null;
}

const accountListeners = new Set<() => void>();

/** Called whenever the visitor signs in or out (including the first check). */
export function onAccountChange(listener: () => void): void {
  accountListeners.add(listener);
}

/**
 * Where to go after signing in, when a page elsewhere on this origin sent the
 * visitor here to sign in (the ad moderation page: /?login=1&next=/api/ads/admin/...).
 * Only same-origin paths; never another site.
 */
let returnTo: string | null = null;

function safeReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

export function initAccount(): void {
  openWallet = initAvatarWallet(() => {
    if (dialog.open) renderDialog();
  }) !== null;
  button.addEventListener('click', openAccountDialog);
  dialog.addEventListener('click', (event) => {
    // A click on the backdrop (the dialog element itself) closes it.
    if (event.target === dialog) dialog.close();
  });

  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('auth');
  const loginRequested = params.get('login') === '1';
  returnTo = loginRequested ? safeReturnPath(params.get('next')) : null;
  if (outcome || loginRequested) {
    resetToken = outcome === 'reset' ? params.get('token') : null;
    for (const key of ['auth', 'error', 'token', 'login', 'next']) params.delete(key);
    const query = params.toString();
    history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  }

  renderButton();
  if (loginRequested) {
    // Already signed in: go straight back. Otherwise offer the sign-in options.
    void refresh(false).then(() => {
      if (user && returnTo) {
        window.location.assign(returnTo);
        return;
      }
      message = returnTo ? { text: 'Log in to continue.', error: false } : null;
      renderDialog();
      if (!dialog.open) dialog.showModal();
      if (!providers) void loadProviders();
    });
  } else if (outcome === 'error') {
    setHint(false);
    message = { text: 'Sign-in did not complete. Please try again.', error: true };
    renderDialog();
    dialog.showModal();
    void loadProviders();
  } else if (outcome === 'reset') {
    view = resetToken ? 'reset' : 'forgot';
    if (!resetToken) message = { text: 'That reset link is invalid or has expired.', error: true };
    renderDialog();
    dialog.showModal();
  } else if (outcome === 'verified') {
    setHint(true);
    void refresh(true);
  } else if (hasHint()) {
    void refresh(outcome === 'new');
  }
}

async function refresh(openIfNoUsername: boolean): Promise<void> {
  try {
    const response = await fetch('/api/account/me', { credentials: 'same-origin' });
    if (!response.ok) return;
    user = ((await response.json()) as { user: AccountUser | null }).user;
    setHint(!!user);
    setSignedIn(!!user);
    renderButton();
    for (const listener of accountListeners) listener();
    if (dialog.open) renderDialog();
    if (user && openWallet) {
      openWallet = false;
      signedInView = 'wallet';
      renderDialog();
      dialog.showModal();
    }
    if (user && !user.username && openIfNoUsername) {
      renderDialog();
      dialog.showModal();
    }
  } catch {
    // Offline or the account service is down: stay signed out in the UI.
  }
}

async function loadProviders(): Promise<void> {
  try {
    const response = await fetch('/api/account/providers', { credentials: 'same-origin' });
    if (!response.ok) throw new Error();
    const known = Object.keys(PROVIDER_LABELS);
    const data = (await response.json()) as { providers: string[]; passwordReset?: boolean };
    providers = data.providers.filter((p): p is Provider => known.includes(p));
    passwordReset = !!data.passwordReset;
  } catch {
    message = { text: 'Log in is unavailable right now.', error: true };
  }
  if (dialog.open) renderDialog();
}

async function signIn(provider: Provider): Promise<void> {
  await run(async () => {
    const response = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        callbackURL: returnTo ?? '/',
        newUserCallbackURL: '/?auth=new',
        errorCallbackURL: '/?auth=error',
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { url?: string };
    if (!response.ok || !data.url) throw new Error('Could not start sign-in.');
    setHint(true);
    window.location.assign(data.url);
  });
}

async function postAuth(path: string, payload: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 429) throw new Error('Too many attempts. Try again in a minute.');
  return { ok: response.ok, data };
}

async function signInWithEmail(email: string, password: string): Promise<void> {
  await run(async () => {
    const { ok, data } = await postAuth('sign-in/email', { email, password, callbackURL: '/?auth=verified' });
    if (!ok) {
      if (data.code === 'EMAIL_NOT_VERIFIED') {
        message = { text: `Confirm your email first: we just sent a new link to ${email}.`, error: false };
        return;
      }
      throw new Error('Wrong email or password.');
    }
    await signedIn();
  });
}

async function signUpWithEmail(name: string, email: string, password: string): Promise<void> {
  await run(async () => {
    const { ok, data } = await postAuth('sign-up/email', { name, email, password, callbackURL: '/?auth=verified' });
    if (!ok) {
      const code = String(data.code ?? '');
      if (code.includes('ALREADY_EXISTS')) throw new Error('An account with this email already exists. Log in instead.');
      if (code.includes('PASSWORD_TOO_SHORT')) throw new Error('Use at least 8 characters for your password.');
      if (code.includes('INVALID_EMAIL')) throw new Error('That email address looks wrong.');
      throw new Error(typeof data.message === 'string' ? data.message : 'Could not create your account.');
    }
    if (!data.token) {
      // Mail is set up: the account waits for its email to be confirmed.
      view = 'sign-in';
      message = { text: `Almost there! Open the link we sent to ${email} to confirm your account.`, error: false };
      return;
    }
    await signedIn(true);
  });
}

async function requestReset(email: string): Promise<void> {
  await run(async () => {
    await postAuth('request-password-reset', { email, redirectTo: '/?auth=reset' });
    // Same answer whether or not the address has an account.
    message = { text: `If ${email} has an account, a reset link is on its way.`, error: false };
  });
}

async function resetPassword(password: string): Promise<void> {
  await run(async () => {
    const { ok } = await postAuth('reset-password', { newPassword: password, token: resetToken });
    if (!ok) throw new Error('That reset link is invalid or has expired. Ask for a new one.');
    resetToken = null;
    view = 'sign-in';
    message = { text: 'Password changed. Log in with your new password.', error: false };
  });
}

async function signedIn(isNew = false): Promise<void> {
  draft = { name: '', email: '', password: '' };
  setHint(true);
  await refresh(isNew);
  // Sent here to sign in by another page on this origin (the ad moderation page): go back.
  if (user && returnTo) {
    window.location.assign(returnTo);
    return;
  }
  if (user && (user.username || !isNew)) dialog.close();
}

async function signOut(): Promise<void> {
  await run(async () => {
    const response = await fetch('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) throw new Error('Could not log out.');
    user = null;
    setHint(false);
    setSignedIn(false);
    renderButton();
    for (const listener of accountListeners) listener();
    dialog.close();
  });
}

async function claimUsername(username: string): Promise<void> {
  await run(async () => {
    const response = await fetch('/api/account/username', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const data = (await response.json().catch(() => ({}))) as { user?: AccountUser; error?: string };
    if (!response.ok || !data.user) throw new Error(data.error || 'Could not save your username.');
    user = data.user;
    message = { text: `You are ${data.user.handle}.`, error: false };
    renderButton();
  });
}

async function run(task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  message = null;
  renderDialog();
  try {
    await task();
  } catch (error) {
    message = { text: error instanceof Error ? error.message : 'Something went wrong.', error: true };
  } finally {
    busy = false;
    if (dialog.open) renderDialog();
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderButton(): void {
  button.replaceChildren();
  if (mobileProfile) {
    mobileProfile.replaceChildren();
    if (user) mobileProfile.append(avatar(user, 'account-avatar'));
    else mobileProfile.innerHTML = PROFILE_ICON;
  }
  if (!user) {
    // Text on wide screens; a person icon in the compact mobile circle.
    button.innerHTML = PROFILE_ICON;
    const label = document.createElement('span');
    label.className = 'account-label';
    label.textContent = 'Log in';
    button.append(label);
    button.setAttribute('aria-label', 'Log in');
    return;
  }
  button.append(avatar(user, 'account-avatar'));
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = user.name;
  button.append(name);
  button.setAttribute('aria-label', `Account: ${user.name}`);
}

function renderDialog(): void {
  body.replaceChildren();
  body.append(closeButton());
  if (!user) {
    renderSignedOut();
  } else if (signedInView === 'wallet') {
    body.append(
      ...walletView(() => {
        signedInView = 'account';
        renderDialog();
      }),
    );
  } else {
    const who = document.createElement('div');
    who.className = 'account-who';
    const text = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'account-display-name';
    name.textContent = user.name;
    text.append(name);
    if (user.handle) {
      const handle = document.createElement('p');
      handle.className = 'account-handle';
      handle.textContent = user.handle;
      text.append(handle);
    }
    who.append(avatar(user, 'account-avatar large'), text);
    body.append(who);
    if (!user.username) body.append(usernameForm());
    body.append(
      characterSummary(() => {
        signedInView = 'wallet';
        message = null;
        renderDialog();
      }),
    );
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'account-logout';
    logout.textContent = 'Log out';
    logout.disabled = busy;
    logout.addEventListener('click', () => void signOut());
    body.append(logout);
  }
  if (message) {
    const note = document.createElement('p');
    note.className = 'account-message';
    note.dataset.error = String(message.error);
    note.textContent = message.text;
    body.append(note);
  }
}

function renderSignedOut(): void {
  if (view === 'reset') {
    body.append(heading('Choose a new password'));
    body.append(emailForm('reset'));
    return;
  }
  if (view === 'forgot') {
    body.append(heading('Reset your password'));
    const hint = document.createElement('p');
    hint.className = 'account-hint';
    hint.textContent = "Enter your account's email and we'll send you a link to choose a new password.";
    body.append(hint, emailForm('forgot'), linkButton('Back to log in', () => switchView('sign-in')));
    return;
  }

  body.append(heading(view === 'sign-up' ? 'Create your account' : 'Welcome back'));
  const tabs = document.createElement('div');
  tabs.className = 'account-tabs';
  tabs.setAttribute('role', 'tablist');
  for (const [id, label] of [['sign-in', 'Log in'], ['sign-up', 'Sign up']] as const) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(view === id));
    tab.textContent = label;
    tab.addEventListener('click', () => switchView(id));
    tabs.append(tab);
  }
  body.append(tabs, emailForm(view));
  if (view === 'sign-in' && passwordReset) {
    body.append(linkButton('Forgot password?', () => switchView('forgot')));
  }
  if (providers?.length) {
    const divider = document.createElement('p');
    divider.className = 'account-divider';
    divider.textContent = 'or';
    body.append(divider, ...providers.map((provider) => providerButton(provider, PROVIDER_LABELS[provider])));
  }
}

function switchView(next: View): void {
  view = next;
  draft.password = '';
  message = null;
  renderDialog();
  body.querySelector<HTMLInputElement>('input')?.focus();
}

function emailForm(kind: View): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'account-form';
    const field = (label: string, input: HTMLElement) => {
    const wrap = document.createElement('label');
    wrap.className = 'account-field';
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(text, input);
    return wrap;
  };
  const make = (type: string, name: string, autocomplete: string, placeholder: string) => {
    const input = document.createElement('input');
    input.type = type;
    input.name = name;
    input.autocomplete = autocomplete as AutoFill;
    input.placeholder = placeholder;
    input.required = true;
    input.spellcheck = false;
    return input;
  };

  const name = make('text', 'name', 'name', 'Your name');
  name.maxLength = 60;
  name.value = draft.name;
  const email = make('email', 'email', 'email', 'you@example.com');
  email.value = draft.email;
  const password = make(
    'password',
    'password',
    kind === 'sign-in' ? 'current-password' : 'new-password',
    kind === 'sign-in' ? 'Your password' : 'At least 8 characters',
  );
  password.minLength = kind === 'sign-in' ? 1 : 8;
  password.maxLength = 128;
  password.value = draft.password;

  const passwordRow = document.createElement('div');
  passwordRow.className = 'account-password';
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.className = 'account-reveal';
  reveal.textContent = 'Show';
  reveal.setAttribute('aria-label', 'Show password');
  reveal.addEventListener('click', () => {
    const hidden = password.type === 'password';
    password.type = hidden ? 'text' : 'password';
    reveal.textContent = hidden ? 'Hide' : 'Show';
    reveal.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
  });
  passwordRow.append(password, reveal);

  if (kind === 'sign-up') form.append(field('Name', name));
  if (kind !== 'reset') form.append(field('Email', email));
  if (kind !== 'forgot') form.append(field(kind === 'reset' ? 'New password' : 'Password', passwordRow));

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'account-submit';
  submit.disabled = busy;
  submit.textContent = busy
    ? 'Please wait…'
    : { 'sign-in': 'Log in', 'sign-up': 'Create account', forgot: 'Send reset link', reset: 'Save password' }[kind];
  form.append(submit);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    draft = { name: name.value.trim(), email: email.value.trim(), password: password.value };
    if (kind === 'sign-in') void signInWithEmail(draft.email, password.value);
    else if (kind === 'sign-up') void signUpWithEmail(draft.name, draft.email, password.value);
    else if (kind === 'forgot') void requestReset(draft.email);
    else void resetPassword(password.value);
  });
  return form;
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'account-link';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function closeButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'account-close';
  b.setAttribute('aria-label', 'Close');
  b.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  b.addEventListener('click', () => dialog.close());
  return b;
}

function heading(text: string): HTMLElement {
  const h = document.createElement('h2');
  h.className = 'account-title';
  h.textContent = text;
  return h;
}

function providerButton(provider: Provider, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'account-provider';
  b.disabled = busy;
  b.innerHTML = PROVIDER_ICONS[provider];
  b.append(label);
  b.addEventListener('click', () => void signIn(provider));
  return b;
}

function usernameForm(): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'account-username';
  const label = document.createElement('label');
  label.htmlFor = 'account-username-input';
  label.textContent = 'Choose your username';
  const row = document.createElement('div');
  row.className = 'account-username-row';
  const input = document.createElement('input');
  input.id = 'account-username-input';
  input.type = 'text';
  input.placeholder = 'username';
  input.autocomplete = 'username';
  input.spellcheck = false;
  input.maxLength = 30;
  input.pattern = '[A-Za-z][A-Za-z0-9_]{2,29}';
  input.required = true;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Save';
  submit.disabled = busy;
  row.append(input, submit);
  const hint = document.createElement('p');
  hint.className = 'account-hint';
  const preview = () => {
    const name = input.value.trim().toLowerCase() || 'username';
    hint.textContent = `Your public creator handle: @${name}@${HANDLE_DOMAIN}. It cannot be changed later.`;
  };
  preview();
  input.addEventListener('input', preview);
  form.append(label, row, hint);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void claimUsername(input.value);
  });
  return form;
}

function avatar(account: AccountUser, className: string): HTMLElement {
  if (account.image) {
    const img = document.createElement('img');
    img.className = className;
    img.src = account.image;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    return img;
  }
  const fallback = document.createElement('span');
  fallback.className = `${className} account-avatar-fallback`;
  fallback.textContent = account.name.charAt(0).toUpperCase();
  return fallback;
}

function hasHint(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function setHint(signedIn: boolean): void {
  try {
    if (signedIn) localStorage.setItem(HINT_KEY, '1');
    else localStorage.removeItem(HINT_KEY);
  } catch {
    // Storage blocked: the account corner simply starts signed out.
  }
}

const PROVIDER_ICONS: Record<Provider, string> = {
  apple:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M16.37 12.74c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.82-.81-3-.79-1.54.02-2.96.9-3.76 2.28-1.6 2.78-.41 6.9 1.15 9.16.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.78.74 2.99.72 1.24-.02 2.02-1.12 2.77-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.39-.92-2.41-3.65zM14.09 5.99c.63-.77 1.06-1.83.94-2.89-.91.04-2.02.61-2.67 1.37-.58.67-1.1 1.76-.96 2.8 1.02.08 2.06-.52 2.69-1.28z"/></svg>',
  discord:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#5865F2" d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.61 1.25a18.27 18.27 0 0 0-5.49 0 12.64 12.64 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-1.99a.08.08 0 0 0-.04-.1 13.1 13.1 0 0 1-1.87-.9.08.08 0 0 1 0-.13l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.07 0a.07.07 0 0 1 .08.01l.37.29a.08.08 0 0 1 0 .13c-.6.35-1.22.65-1.87.9a.08.08 0 0 0-.04.1c.36.7.77 1.36 1.22 1.99a.08.08 0 0 0 .09.03 19.84 19.84 0 0 0 6-3.03.08.08 0 0 0 .03-.06c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42z"/></svg>',
  google:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.96 10.96 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"/></svg>',
  github:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg>',
};
