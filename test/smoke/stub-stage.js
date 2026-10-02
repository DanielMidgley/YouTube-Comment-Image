// Stub of the stage contract (see src/stage/stage.js). Test-only props: _offset moves the capture box
// away from the document origin, _extraHeight adds fractional CSS px, _hang never settles.
const chat = document.getElementById('chat');
const row = chat.querySelector('.row');
const avatar = row.querySelector('.avatar');
const time = row.querySelector('.time');
const name = row.querySelector('.name');
const message = row.querySelector('.message');

window.stage = {
  async render(props) {
    if (props._hang) return new Promise(() => {});
    document.documentElement.dataset.theme = props.theme === 'light' ? 'light' : 'dark';

    const offset = props._offset ?? 0;
    chat.style.left = chat.style.top = `${offset}px`;
    chat.style.padding = `${props.margin ?? 0}px`;
    row.style.width = `${props.rowWidth ?? 400}px`;
    row.style.paddingBottom = `${4 + (props._extraHeight ?? 0)}px`;

    time.textContent = props.timestamp ?? '';
    time.hidden = !props.timestamp;
    name.textContent = props.name ?? '';
    message.textContent = String(props.message ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
    if (avatar.getAttribute('src') !== props.avatarSrc) avatar.src = props.avatarSrc;

    await Promise.all([
      document.fonts.load('500 13px Roboto', name.textContent || 'a'),
      document.fonts.load('400 13px Roboto', message.textContent || 'a'),
      document.fonts.load('400 11px Roboto', time.textContent || 'a'),
    ]);
    await document.fonts.ready;
    await avatar.decode().catch(() => {});

    const r = chat.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
  },
};
