for (const panel of document.querySelectorAll('[data-comparison]')) {
  const $ = selector => panel.querySelector(selector.replace('#wild-', `#${panel.dataset.comparison}-`));
  let examples = [], selected = null, stage = null, starting = null, cells = [];
  let serial = 0, playing = false, t = 0, visible = false, animation = null, lastTime = 0, direction = 1;

  function setState(value) {
    t = Math.max(0, Math.min(1, Number(value)));
    $('#wild-state').value = t;
    $('#wild-state-value').textContent = `${Math.round(t * 100)}%`;
    cells.forEach(cell => cell.view?.setState(t));
  }

  function stop() {
    playing = false;
    $('#wild-play').textContent = 'Play motion';
  }

  function animate(now) {
    animation = null;
    if (!stage || !visible || document.hidden) { lastTime = 0; return; }
    if (playing && lastTime) {
      const next = t + direction * Math.min(now - lastTime, 100) / 2500;
      if (next >= 1 || next <= 0) direction *= -1;
      setState(next);
    }
    lastTime = now;
    stage.renderAll();
    animation = requestAnimationFrame(animate);
  }

  function wake() {
    if (animation === null && visible && !document.hidden && stage) animation = requestAnimationFrame(animate);
  }

  async function appearance(cell, token) {
    if (!cell.summary) return;
    cell.meta.textContent = $('#wild-materials').checked ? 'Loading appearance…' : cell.summary;
    await cell.view.setColorMode($('#wild-materials').checked);
    if (token === serial) cell.meta.textContent = cell.summary;
  }

  async function loadSelected() {
    const token = ++serial;
    const object = selected;
    stop();
    setState(0);
    cells.forEach(cell => { cell.view.clear(); cell.summary = null; cell.meta.textContent = 'Loading…'; });
    $('#wild-status').textContent = `Loading ${object.title.toLowerCase()}…`;
    let failures = 0;
    await Promise.all(cells.map(async (cell, i) => {
      try {
        const summary = await cell.view.load(object.methods[i].bundle);
        if (token !== serial) return;
        cell.summary = `${summary.parts} parts · ${summary.joints} joints`;
        cell.view.setState(t);
        await appearance(cell, token);
      } catch (error) {
        if (token !== serial) return;
        failures += 1;
        cell.meta.textContent = 'Could not load this result';
        console.error(error);
      }
    }));
    if (token === serial) $('#wild-status').textContent = failures ? 'Some results could not load. Select the example again to retry.' : '';
  }

  function choose(object) {
    selected = object;
    $('#wild-input-image').src = object.input;
    $('#wild-input-image').alt = `${object.title}, input photograph`;
    $('#wild-input-caption').textContent = object.pose;
    [...$('.wild-choices').children].forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === object.id)));
    if (stage) loadSelected();
  }

  async function start() {
    if (starting) return starting;
    starting = (async () => {
      const { createStage } = await import('./scene.js');
      stage = createStage($('#wild-canvas'));
      cells.forEach(cell => { cell.view = stage.addView(cell.element); });
      panel.querySelectorAll('.wild-controls button, .wild-controls input').forEach(control => { control.disabled = false; });
      wake();
      await loadSelected();
    })().catch(error => {
      $('#wild-status').textContent = '3D preview unavailable. Reload to retry.';
      console.error(error);
    });
    return starting;
  }

  async function main() {
    const response = await fetch(panel.dataset.manifest);
    if (!response.ok) throw new Error('Examples unavailable');
    examples = await response.json();
    for (const object of examples) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'wild-choice'; button.dataset.id = object.id;
      const image = document.createElement('img');
      image.src = object.input; image.alt = ''; image.loading = 'lazy';
      const label = document.createElement('span'); label.textContent = object.title;
      button.append(image, label);
      button.addEventListener('click', () => choose(object));
      $('.wild-choices').append(button);
    }
    cells = examples[0].methods.map(method => {
      const wrapper = document.createElement('div');
      wrapper.className = `wild-cell${['Ours', 'DualArt'].includes(method.id) ? ' ours' : ''}`;
      const heading = document.createElement('h3'); heading.textContent = method.label;
      const element = document.createElement('div');
      element.className = 'wild-view'; element.setAttribute('aria-label', `${method.label} interactive model`);
      const meta = document.createElement('p'); meta.className = 'wild-meta';
      wrapper.append(heading, element, meta); $('.wild-grid').append(wrapper);
      return { element, meta, view: null, summary: null };
    });
    choose(examples[0]);
    $('#wild-status').textContent = '';
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) { start(); wake(); }
    }).observe(panel);
    document.addEventListener('visibilitychange', wake);
    $('#wild-state').addEventListener('input', event => { stop(); setState(event.target.value); });
    $('#wild-play').addEventListener('click', () => {
      playing = !playing;
      if (t >= 1) direction = -1;
      if (t <= 0) direction = 1;
      $('#wild-play').textContent = playing ? 'Pause motion' : 'Play motion';
    });
    $('#wild-materials').addEventListener('change', () => cells.forEach(cell => appearance(cell, serial)));
    $('#wild-reset').addEventListener('click', () => cells.forEach(cell => cell.view.frameCamera()));
  }

  main().catch(error => { $('#wild-status').textContent = 'Could not load examples. Reload to retry.'; console.error(error); });
}
