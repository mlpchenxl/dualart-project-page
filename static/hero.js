const video = document.querySelector('#hero-video');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let visible = true;

function syncPlayback() {
  if (!reducedMotion.matches && visible && !document.hidden) video.play().catch(() => {});
  else video.pause();
}
document.addEventListener('visibilitychange', syncPlayback);
reducedMotion.addEventListener('change', syncPlayback);
new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting;
  syncPlayback();
}).observe(video.closest('.hero'));
syncPlayback();
