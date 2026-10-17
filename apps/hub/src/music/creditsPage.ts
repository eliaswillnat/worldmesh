import { TRACKS, type Track } from './tracks';

/** /music-credits: one entry per song in tracks.ts, in playlist order. */

function link(href: string, text: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function paragraph(className: string, text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

function entry(track: Track): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'track';

  const title = document.createElement('h2');
  title.textContent = track.title;
  item.append(title, paragraph('artist', `by ${track.artist}`));

  const meta = document.createElement('p');
  meta.className = 'meta';
  const license = link(track.license.url, track.license.name);
  license.setAttribute('aria-label', `Licence: ${track.license.name}`);
  const source = link(track.source, 'Original source');
  source.setAttribute('aria-label', `Original source of ${track.title}`);
  meta.append(license, source);
  item.appendChild(meta);

  if (track.attribution) {
    const credit = document.createElement('blockquote');
    credit.className = 'attribution';
    credit.textContent = track.attribution;
    item.appendChild(credit);
  }
  if (track.changes) item.appendChild(paragraph('note', `Changes: ${track.changes}`));
  else if (track.license.attribution) item.appendChild(paragraph('note', 'Used unchanged.'));
  return item;
}

document.querySelector('#tracks')!.append(...TRACKS.map(entry));
