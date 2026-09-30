/**
 * The city's on-screen interface, kept small and flat: one contextual prompt
 * (enter a door, call the platform, take a lift), a location chip, the ride
 * controls while on the discovery platform, the fast-lift panel with search,
 * and the solid screen shown while a fast lift travels. Plain DOM, updated
 * only when its text changes, so it never re-renders per frame.
 *
 * Nothing here needs hover, right click or a keyboard: every action is a
 * button that also works as a tap.
 */

export interface LiftDestination {
  label: string;
  detail: string;
  towerId: string;
  floor: number;
  current?: boolean;
}

export interface SearchResultView {
  title: string;
  detail: string;
  /** Where the result leads: a floor, or straight into the world when it has no door this window. */
  actionLabel: string;
  select(): void;
}

export interface LiftPanel {
  title: string;
  subtitle: string;
  destinations: LiftDestination[];
  floorCount: number;
  towerId: string;
  go(destination: { towerId: string; floor: number }): void;
  search(query: string): SearchResultView[];
}

export interface HudHandlers {
  onPrompt(): void;
  onRide(direction: -1 | 0 | 1): void;
  onPanelClosed(): void;
}

export class CityHud {
  private promptButton: HTMLButtonElement;
  private chip: HTMLDivElement;
  private ride: HTMLDivElement;
  private rideLabel: HTMLSpanElement;
  private travelScreen: HTMLDivElement;
  private travelLabel: HTMLDivElement;
  private dialog: HTMLDialogElement | null = null;
  private promptText: string | null = null;
  private chipText: string | null = null;
  private rideText: string | null = null;

  constructor(
    private container: HTMLElement,
    private touch: boolean,
    private handlers: HudHandlers,
  ) {
    this.promptButton = document.createElement('button');
    this.promptButton.type = 'button';
    this.promptButton.className = 'walk-add-prompt city-prompt';
    this.promptButton.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.onPrompt();
    });

    this.chip = document.createElement('div');
    this.chip.className = 'city-chip';
    this.chip.setAttribute('aria-live', 'polite');

    this.ride = document.createElement('div');
    this.ride.className = 'city-ride';
    this.rideLabel = document.createElement('span');
    this.rideLabel.className = 'city-ride-label';
    const rideButton = (label: string, title: string, direction: -1 | 0 | 1) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'city-ride-button';
      button.textContent = label;
      button.title = title;
      button.setAttribute('aria-label', title);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        handlers.onRide(direction);
      });
      return button;
    };
    this.ride.append(
      rideButton('▲', touch ? 'Ride up' : 'Ride up (R)', 1),
      rideButton('■', touch ? 'Stop at the next floor' : 'Stop at the next floor (X)', 0),
      rideButton('▼', touch ? 'Ride down' : 'Ride down (F)', -1),
      this.rideLabel,
    );

    this.travelScreen = document.createElement('div');
    this.travelScreen.className = 'city-travel';
    this.travelLabel = document.createElement('div');
    this.travelLabel.className = 'city-travel-label';
    this.travelScreen.append(this.travelLabel);

    container.append(this.promptButton, this.chip, this.ride, this.travelScreen);
  }

  /** The one contextual action, or null for none. */
  setPrompt(text: string | null): void {
    if (text === this.promptText) return;
    this.promptText = text;
    if (text) this.promptButton.textContent = text;
    this.promptButton.classList.toggle('visible', text !== null);
  }

  get promptVisible(): boolean {
    return this.promptText !== null;
  }

  setLocation(text: string | null): void {
    if (text === this.chipText) return;
    this.chipText = text;
    this.chip.textContent = text ?? '';
    this.chip.classList.toggle('visible', text !== null);
  }

  setRide(text: string | null): void {
    if (text === this.rideText) return;
    this.rideText = text;
    this.rideLabel.textContent = text ?? '';
    this.ride.classList.toggle('visible', text !== null);
  }

  showTravel(text: string | null): void {
    if (text !== null) this.travelLabel.textContent = text;
    this.travelScreen.classList.toggle('active', text !== null);
  }

  get panelOpen(): boolean {
    return this.dialog !== null;
  }

  openPanel(panel: LiftPanel): void {
    this.closePanel();
    document.exitPointerLock?.();
    const dialog = document.createElement('dialog');
    dialog.className = 'city-dialog';
    dialog.setAttribute('aria-label', panel.title);

    const header = document.createElement('div');
    header.className = 'city-dialog-header';
    const titles = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = panel.title;
    const subtitle = document.createElement('p');
    subtitle.textContent = panel.subtitle;
    titles.append(title, subtitle);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'city-dialog-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.closePanel());
    header.append(titles, close);

    const list = document.createElement('div');
    list.className = 'city-destinations';
    for (const destination of panel.destinations) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'city-destination';
      button.disabled = destination.current === true;
      const label = document.createElement('span');
      label.textContent = destination.label;
      const detail = document.createElement('small');
      detail.textContent = destination.current ? 'You are here' : destination.detail;
      button.append(label, detail);
      button.addEventListener('click', () => {
        this.closePanel();
        panel.go(destination);
      });
      list.append(button);
    }

    const floorRow = document.createElement('form');
    floorRow.className = 'city-row';
    const floorInput = document.createElement('input');
    floorInput.type = 'number';
    floorInput.inputMode = 'numeric';
    floorInput.min = '0';
    floorInput.max = String(panel.floorCount - 1);
    floorInput.placeholder = `Floor 0–${panel.floorCount - 1}`;
    floorInput.setAttribute('aria-label', 'Floor number');
    const floorGo = document.createElement('button');
    floorGo.type = 'submit';
    floorGo.textContent = 'Go';
    floorRow.append(floorInput, floorGo);
    floorRow.addEventListener('submit', (event) => {
      event.preventDefault();
      const floor = Math.round(Number(floorInput.value));
      if (!Number.isFinite(floor) || floor < 0 || floor >= panel.floorCount) return;
      this.closePanel();
      panel.go({ towerId: panel.towerId, floor });
    });

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'city-search';
    searchInput.placeholder = 'Find a world, creator or category';
    searchInput.setAttribute('aria-label', 'Search worlds');
    const results = document.createElement('div');
    results.className = 'city-results';
    const renderResults = () => {
      const hits = searchInput.value.trim() ? panel.search(searchInput.value) : [];
      results.replaceChildren(
        ...hits.map((hit) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'city-result';
          const name = document.createElement('span');
          name.textContent = hit.title;
          const detail = document.createElement('small');
          detail.textContent = hit.detail;
          const action = document.createElement('em');
          action.textContent = hit.actionLabel;
          row.append(name, detail, action);
          row.addEventListener('click', () => {
            this.closePanel();
            hit.select();
          });
          return row;
        }),
      );
      if (searchInput.value.trim() && !hits.length) {
        const empty = document.createElement('p');
        empty.className = 'city-empty';
        empty.textContent = 'No worlds match.';
        results.append(empty);
      }
    };
    searchInput.addEventListener('input', renderResults);

    const body = document.createElement('div');
    body.className = 'city-dialog-body';
    body.append(list, floorRow, searchInput, results);
    dialog.append(header, body);
    dialog.addEventListener('close', () => {
      if (this.dialog === dialog) this.closePanel();
    });
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    this.container.append(dialog);
    this.dialog = dialog;
    dialog.showModal();
    if (!this.touch) searchInput.focus();
  }

  closePanel(): void {
    const dialog = this.dialog;
    if (!dialog) return;
    this.dialog = null;
    if (dialog.open) dialog.close();
    dialog.remove();
    this.handlers.onPanelClosed();
  }

  dispose(): void {
    this.closePanel();
    this.promptButton.remove();
    this.chip.remove();
    this.ride.remove();
    this.travelScreen.remove();
  }
}
