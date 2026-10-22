const contents = document.getElementById('page-contents');
const nav = document.getElementById('contents-nav');
const compact = matchMedia('(max-width: 1100px)');
const links = [...nav.querySelectorAll('.toc-link')];
const sections = links.map(link => document.getElementById(link.hash.slice(1)));

function fitContents() { contents.open = !compact.matches; }
fitContents();
compact.addEventListener('change', fitContents);

let scheduled = false;
function highlight() {
  scheduled = false;
  const threshold = window.innerHeight * 0.25;
  let current = 0;
  sections.forEach((section, index) => {
    if (section.getBoundingClientRect().top <= threshold) current = index;
  });
  if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) {
    current = links.length - 1;
  }
  links.forEach((link, index) => {
    if (index === current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}
function scheduleHighlight() {
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(highlight);
  }
}
window.addEventListener('scroll', scheduleHighlight, { passive: true });
window.addEventListener('resize', scheduleHighlight);
window.addEventListener('hashchange', scheduleHighlight);
scheduleHighlight();

nav.querySelectorAll('.toc-expand').forEach(button => {
  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', button.getAttribute('aria-label').replace(
      expanded ? 'Expand' : 'Collapse', expanded ? 'Collapse' : 'Expand'));
    document.getElementById(button.getAttribute('aria-controls')).hidden = !expanded;
  });
});
nav.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#"]');
  if (!link || !compact.matches) return;
  contents.open = false;
  const target = document.getElementById(link.hash.slice(1));
  target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && compact.matches && contents.open) {
    contents.open = false;
    contents.querySelector('summary').focus();
  }
});
