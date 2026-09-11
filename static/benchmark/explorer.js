const panel = document.querySelector('#metric-explorer');
const $ = selector => panel.querySelector(selector);
const content = {
  IoU: {
    title: 'Part box mismatch ↓', formula: '1 − generalized IoU',
    explanation: 'How well do the predicted movable parts match the reference in position and extent? A lower box mismatch is better.',
    legend: 'Cyan outlines · reference movable-part boxes',
    scope: 'These boxes come from the displayed mesh. They illustrate part extent; they are not the evaluator’s serialized boxes. A prediction is needed for matching and a score.',
  },
  cDist: {
    title: 'Part center distance ↓', formula: 'Distance between matched part centers',
    explanation: 'A part can have the right shape but sit in the wrong place. cDist measures the distance between matched reference and predicted part centers.',
    legend: 'Purple dots · reference box centers',
    scope: 'This view shows reference centers only. Without a prediction, there are no matching lines or distances to report. Formal distances use normalized coordinates.',
  },
  CD: {
    title: 'Surface distance ↓', formula: 'Symmetric squared Chamfer distance',
    explanation: 'Compare points on the reference and predicted surfaces in both directions. Smaller nearest-point distances mean the surfaces agree more closely. The base is included.',
    legend: 'Green points · surface preview, including the base',
    scope: 'The dots are a deterministic subset of mesh vertices for illustration. Formal CD uses evaluator surface samples and squared nearest-point distances; no CD score is computed here.',
  },
  AOR: {
    title: 'Articulated overlap ratio ↓', formula: 'Sibling-part overlap across motion states',
    explanation: 'Parts sharing a parent are examined for overlap as they move. Formal AOR averages the prediction’s overlap measurements over 10 states.',
    legend: 'Orange · sibling boxes; red · overlapping box volumes',
    scope: 'This is reference mesh-box overlap at the selected pose. Boxes may overlap even when surfaces do not collide. It is neither a prediction score nor contact-physics verification.',
  },
  Appearance: {
    title: 'Appearance under matched states and views', formula: 'LPIPS ↓ · PSNR ↑ · Silhouette IoU ↑',
    explanation: 'LPIPS compares perceptual image features. PSNR measures pixel-level agreement. Silhouette IoU measures the overlap of foreground masks. Each compares a prediction with its corresponding reference image.',
    legend: 'Ground truth · 5 articulation states × 8 camera views',
    scope: 'These are the actual published reference frames. No prediction is attached, so no comparison score is shown. The optional silhouette displays the reference alpha shape.',
  },
};
let examples = [], selected = null, metric = 'IoU', viewer = null, modulePromise = null;
let request = null, serial = 0, ready = false;

function configureState() {
  const input = $('#metric-state');
  input.max = metric === 'AOR' ? 100 : 4;
  input.value = 0;
  $('#metric-pose-label').hidden = ['AOR', 'Appearance'].includes(metric);
  $('#metric-view-label').hidden = metric !== 'Appearance';
  $('#metric-silhouette-label').hidden = metric !== 'Appearance';
  input.disabled = !ready || (!['AOR', 'Appearance'].includes(metric) && $('#metric-pose').value === 'RS');
}

function render() {
  const description = content[metric];
  $('#metric-title').textContent = description.title;
  $('#metric-formula').textContent = description.formula;
  $('#metric-explanation').textContent = description.explanation;
  $('#metric-legend').textContent = description.legend;
  $('#metric-scope').textContent = description.scope;
  panel.dataset.metric = metric;
  const appearance = metric === 'Appearance';
  $('#metric-model').hidden = appearance;
  $('#metric-frame').hidden = !appearance;
  $('#metric-fit').hidden = appearance;
  $('#metric-state').disabled = !ready || (!['AOR', 'Appearance'].includes(metric) && $('#metric-pose').value === 'RS');
  if (!ready) return;
  const index = Number($('#metric-state').value);
  const resting = !['AOR', 'Appearance'].includes(metric) && $('#metric-pose').value === 'RS';
  const t = resting ? 0 : index / (metric === 'AOR' ? 100 : 4);
  $('#metric-state-value').textContent = metric === 'AOR' ? `Motion preview · t = ${t.toFixed(2)}` : `${resting ? 'Rest' : `State ${index + 1} / 5`} · t = ${t.toFixed(2)}`;
  if (appearance) {
    const view = $('#metric-view').value;
    const frame = selected.frames[`t${index}/${view}.png`];
    const image = $('#metric-image');
    image.hidden = false;
    image.classList.toggle('silhouette', $('#metric-silhouette').checked);
    image.alt = `${selected.title}, ground truth, state ${index + 1}, ${view.replaceAll('_', ' ')}`;
    image.onerror = () => { image.hidden = true; $('#metric-facts').textContent = 'Reference image could not load. Select another state or view to retry.'; };
    image.src = frame;
    $('#metric-image-link').href = frame;
    $('#metric-image-caption').textContent = `${selected.title} · ${view.replaceAll('_', ' ')} · t = ${t.toFixed(2)}`;
    $('#metric-facts').textContent = 'Actual GT frame · 512 × 512 · no prediction score';
  } else {
    try {
      const key = metric === 'AOR' ? 'AOR' : `${resting ? 'RS' : 'AS'}-${metric}`;
      const facts = viewer.show(key, t);
      $('#metric-facts').textContent = metric === 'CD' ? `${facts.count} preview points · not evaluator samples`
        : metric === 'AOR' ? `${facts.count} sibling pairs · ${facts.overlaps} box intersections at this pose`
        : `${facts.count} reference movable parts · GT illustration`;
    } catch (error) {
      $('#metric-facts').textContent = `This overlay is unavailable: ${error.message}`;
    }
  }
}

async function loadExample(example) {
  request?.abort(); request = new AbortController();
  const signal = request.signal, current = ++serial;
  const timeout = setTimeout(() => { if (current === serial) request.abort(); }, 60000);
  selected = example; ready = false;
  $('#metric-controls').disabled = true;
  $('#metric-retry').hidden = true;
  $('#metric-loading').textContent = 'Loading reference model…';
  $('#metric-loading').hidden = false;
  $('#metric-poster').src = example.poster; $('#metric-poster').hidden = false;
  panel.querySelectorAll('.metric-object').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === example.id)));
  viewer?.clear();
  configureState(); render();
  try {
    modulePromise ||= import('./metrics.js');
    const { MetricViewer } = await modulePromise;
    if (current !== serial) return;
    viewer ||= new MetricViewer();
    await viewer.load(example, $('#metric-model'), signal, progress => {
      if (current === serial && progress.phase === 'download' && progress.total) $('#metric-loading').textContent = `Loading reference model… ${Math.round(100 * progress.loaded / progress.total)}%`;
    });
    if (current !== serial) return;
    ready = true; $('#metric-controls').disabled = false;
    $('#metric-loading').hidden = true; $('#metric-poster').hidden = true;
    viewer.onError = text => { $('#metric-loading').textContent = text; $('#metric-loading').hidden = false; };
    configureState(); render();
  } catch (error) {
    if (current !== serial) return;
    viewer?.clear();
    $('#metric-loading').textContent = 'The reference model could not load. Retry or select another object.';
    $('#metric-retry').hidden = false;
    console.error('Benchmark example failed', example.id, error);
  } finally { clearTimeout(timeout); }
}

$('#metric-retry').onclick = () => loadExample(selected);
$('#metric-fit').onclick = () => viewer?.fit();
$('#metric-pose').onchange = () => { configureState(); render(); };
$('#metric-state').oninput = render;
$('#metric-view').onchange = render;
$('#metric-silhouette').onchange = render;
panel.querySelectorAll('[data-metric]').forEach(button => {
  button.onclick = () => {
    metric = button.dataset.metric;
    panel.querySelectorAll('[data-metric]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    configureState(); render();
  };
});

async function initialize() {
  try {
    const response = await fetch('assets/benchmark.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    examples = await response.json();
    for (const example of examples) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'metric-object'; button.dataset.id = example.id;
      button.setAttribute('aria-pressed', 'false');
      const image = document.createElement('img'); image.src = example.poster; image.alt = ''; image.loading = 'lazy';
      const text = document.createElement('span'); text.textContent = `${example.title} · ${example.dataset} / ${example.object_id}`;
      button.append(image, text); button.onclick = () => loadExample(example);
      $('#metric-objects').append(button);
    }
    for (const view of examples[0].views) {
      const option = document.createElement('option'); option.value = view.id; option.textContent = view.id.replaceAll('_', ' ');
      $('#metric-view').append(option);
    }
    render();
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        if (!selected) loadExample(examples[0]);
      }
    }, { threshold: 0.05 });
    observer.observe(panel);
  } catch (error) {
    $('#metric-loading').textContent = 'Benchmark examples are unavailable. Refresh to retry.';
    console.error(error);
  }
}
initialize();
