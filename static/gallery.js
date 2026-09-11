const grid = document.querySelector('#object-gallery');
const message = document.querySelector('#gallery-message');
let viewerModule = null;
const queue = [];
let loadingCount = 0;

// Six fixed cards: at most two model downloads at once; offscreen viewers stop drawing.
function enqueue(state) {
  if (state.started || state.queued) return;
  state.queued = true;
  queue.push(state);
  drain();
}

function drain() {
  while (loadingCount < 2 && queue.length) {
    const state = queue.shift();
    state.queued = false;
    if (!state.visible) continue;
    state.started = true;
    loadingCount++;
    openCard(state).finally(() => { loadingCount--; drain(); });
  }
}

async function openCard(state) {
  const { card, item } = state;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 60000);
  let viewer;
  const status = card.querySelector('.object-status');
  const viewport = card.querySelector('.object-viewport');
  card.classList.add('is-active');
  card.querySelector('.object-launch').hidden = true;
  viewport.setAttribute('aria-busy', 'true');
  status.textContent = 'Loading 3D viewer…';
  try {
    viewerModule ||= import('./viewer/viewer.js');
    const { ObjectViewer, formatValue } = await viewerModule;
    viewer = new ObjectViewer();
    const joints = await viewer.load(item, viewport, abort.signal, progress => {
      if (progress.phase === 'download') status.textContent = `Loading model… ${progress.total ? Math.round(progress.loaded / progress.total * 100) + '%' : ''}`;
      if (progress.phase === 'parse' || progress.phase === 'compose') status.textContent = 'Preparing geometry and joints…';
    });
    clearTimeout(timeout);
    viewport.removeAttribute('aria-busy');
    card.classList.add('is-ready');
    card.querySelector('.object-controls').hidden = false;
    const play = card.querySelector('.object-play');
    play.disabled = joints.length === 0;
    const syncPlay = () => {
      play.textContent = viewer.playing ? 'Pause motion' : 'Play motion';
      play.setAttribute('aria-pressed', String(viewer.playing));
    };
    syncPlay();
    play.onclick = () => { viewer.playing = !viewer.playing; syncPlay(); };
    card.querySelector('.object-reset').onclick = () => { viewer.reset(); syncPlay(); };
    const rows = [];
    for (const [index, joint] of joints.entries()) {
      const row = document.createElement('label');
      row.className = 'joint-control';
      const name = document.createElement('span');
      name.textContent = (item.jointNames?.[joint.usdPath] || joint.id).replaceAll('_', ' ');
      const value = document.createElement('output');
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = joint.lower; slider.max = joint.upper;
      slider.step = (joint.upper - joint.lower) / 240;
      slider.id = `${item.id}-joint-${index}`;
      slider.setAttribute('aria-label', name.textContent);
      value.htmlFor = slider.id;
      row.append(name, value, slider);
      card.querySelector('.joint-list').append(row);
      rows.push({ joint, slider, value });
      slider.oninput = () => {
        viewer.playing = false; syncPlay();
        joint.setValue(Number(slider.value)); viewer.onValues();
      };
    }
    viewer.onValues = () => {
      for (const { joint, slider, value } of rows) {
        slider.value = joint.value;
        value.textContent = formatValue(joint);
        slider.setAttribute('aria-valuetext', value.textContent);
      }
    };
    viewer.onValues();
    viewer.onError = text => { status.textContent = text; play.disabled = true; };
    status.textContent = joints.length ? 'Drag to orbit · Scroll to zoom' : 'View only · No finite joint limits available';
    const expand = card.querySelector('.object-expand');
    expand.hidden = !document.fullscreenEnabled;
    expand.onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await card.requestFullscreen();
      } catch { status.textContent = 'Fullscreen is unavailable in this browser.'; }
    };
  } catch (error) {
    viewer?.dispose();
    card.classList.remove('is-active', 'is-ready');
    card.querySelector('.object-controls').hidden = true;
    card.querySelector('.joint-list').replaceChildren();
    viewport.removeAttribute('aria-busy');
    card.querySelector('.object-launch').hidden = false;
    status.textContent = abort.signal.aborted ? 'Loading timed out. Retry below.' : '3D could not load. Retry or view the dataset video above.';
    console.error('Gallery asset failed:', item.id, error);
  } finally {
    clearTimeout(timeout);
  }
}

async function loadGallery() {
  try {
    const response = await fetch('assets/gallery.json');
    if (!response.ok) throw new Error(`Gallery HTTP ${response.status}`);
    const items = await response.json();
    const states = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const state = states.get(entry.target);
        state.visible = entry.isIntersecting;
        if (state.visible) enqueue(state);
      }
    }, { threshold: 0.05 });
    const template = document.querySelector('#object-card-template');
    for (const item of items) {
      if (item.dataset !== 'realproduct') throw new Error('Dataset gallery only accepts RealProduct assets');
      const card = template.content.firstElementChild.cloneNode(true);
      card.id = item.id;
      card.querySelector('h4').textContent = item.title;
      card.querySelector('.object-meta').textContent = `RealProduct / ${item.object_id} · ${item.jointCount} joints`;
      const poster = card.querySelector('img');
      poster.src = item.poster; poster.alt = `${item.title}, reference asset preview`;
      const launch = card.querySelector('.object-launch');
      launch.textContent = 'Retry 3D';
      launch.setAttribute('aria-label', `Retry loading ${item.title}`);
      launch.hidden = true;
      const state = { card, item, visible: false, started: false, queued: false };
      launch.onclick = () => { state.started = false; enqueue(state); };
      states.set(card, state);
      grid.append(card);
      observer.observe(card);
    }
    message.hidden = true;
  } catch (error) {
    message.textContent = 'The object gallery could not load. Refresh the page to retry.';
    console.error(error);
  }
}

loadGallery();
