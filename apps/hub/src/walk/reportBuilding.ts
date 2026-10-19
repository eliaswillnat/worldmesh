/**
 * "Report this building" (docs/specs/buildings.md §8): from the pause screen,
 * a visitor flags the building standing nearest them in the city. Reports
 * come from WorldMesh accounts, so a person can follow up; they reach the
 * reviewers (workers/auth, POST /api/account/building/report), who hide the
 * building or set the report aside.
 */

/** What can be wrong with a building, as workers/auth names it. */
const REASONS: Array<[string, string]> = [
  ['offensive', 'Offensive or hateful'],
  ['sexual', 'Sexual content'],
  ['violent', 'Violent or graphic'],
  ['copyright', "Someone else's work"],
  ['broken', 'Broken, or in the way'],
  ['other', 'Something else'],
];

export interface ReportOptions {
  /** The world whose building it is (its canonical URL), and its name. */
  world: string;
  name: string;
  light: boolean;
  signedIn: boolean;
  /** Not signed in: take them to sign in. */
  onSignIn: () => void;
}

export function openBuildingReport(options: ReportOptions): { close: () => void } {
  const dialog = document.createElement('dialog');
  dialog.className = 'world-claim building-report';
  dialog.setAttribute('aria-labelledby', 'building-report-title');
  if (options.light) dialog.dataset.theme = 'light';
  // Keys and pointers stay in the dialog, not with the walk controls behind it.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'keyup', 'wheel', 'touchstart']) {
    dialog.addEventListener(type, (event) => event.stopPropagation());
  }

  const title = document.createElement('h2');
  title.id = 'building-report-title';
  title.textContent = 'Report this building';
  const where = (() => {
    try {
      return new URL(options.world).host;
    } catch {
      return options.world;
    }
  })();
  const note = document.createElement('p');
  const status = document.createElement('p');
  status.className = 'world-claim-status';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'world-claim-close';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '×';
  const primary = document.createElement('button');
  primary.type = 'button';
  primary.className = 'world-claim-primary';
  const actions = document.createElement('div');
  actions.className = 'world-claim-actions';
  actions.append(primary);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    dialog.close();
    dialog.remove();
  };
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  if (!options.signedIn) {
    note.textContent = `Reports on buildings come from WorldMesh accounts, so a person can follow up. Sign in, walk back to ${options.name}, and report it from here.`;
    primary.textContent = 'Sign in';
    primary.addEventListener('click', () => {
      close();
      options.onSignIn();
    });
    dialog.append(closeButton, title, note, actions);
  } else {
    note.textContent = `The building of ${options.name} (${where}). What is wrong with it?`;
    const reasons = document.createElement('fieldset');
    reasons.className = 'building-report-reasons';
    const legend = document.createElement('legend');
    legend.textContent = 'Reason';
    reasons.append(legend);
    for (const [value, label] of REASONS) {
      const row = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'building-report-reason';
      radio.value = value;
      row.append(radio, label);
      reasons.append(row);
    }
    const details = document.createElement('textarea');
    details.className = 'building-report-note';
    details.placeholder = 'Anything a reviewer should know (optional)';
    details.maxLength = 500;
    details.rows = 3;
    primary.textContent = 'Send report';
    let sending = false;
    primary.addEventListener('click', async () => {
      if (sending) return;
      const reason = reasons.querySelector<HTMLInputElement>('input:checked')?.value;
      if (!reason) {
        status.textContent = 'Choose what is wrong with it.';
        return;
      }
      sending = true;
      primary.disabled = true;
      status.textContent = '';
      try {
        const response = await fetch('/api/account/building/report', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ world: options.world, reason, note: details.value.trim() || null }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string; alreadyReported?: boolean };
        if (!response.ok) throw new Error(body.error || 'The report could not be sent. Try again later.');
        title.textContent = 'Thanks for telling us';
        note.textContent = body.alreadyReported
          ? 'You reported this building already. A person will look at it.'
          : 'A person will look at it. If it breaks the rules, it comes down.';
        reasons.remove();
        details.remove();
        primary.textContent = 'Done';
        primary.disabled = false;
        primary.onclick = close;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'The report could not be sent.';
        primary.disabled = false;
        sending = false;
      }
    });
    dialog.append(closeButton, title, note, reasons, details, status, actions);
  }

  document.body.appendChild(dialog);
  // Held keys are let go, so the visitor doesn't keep walking behind the dialog.
  window.dispatchEvent(new Event('blur'));
  dialog.showModal();
  return { close };
}
