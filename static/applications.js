for (const carousel of document.querySelectorAll('.application-carousel')) {
  const track = carousel.querySelector('.application-track');
  const slides = [...track.querySelectorAll('.application-slide')];
  const buttons = [...carousel.querySelectorAll('.application-arrow')];
  const position = carousel.querySelector('.application-position');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let current = 0;
  let settleTimer;

  function select(index) {
    current = Math.max(0, Math.min(slides.length - 1, index));
    slides.forEach((slide, i) => {
      // Keep the outgoing playback position for a later visit.
      if (i !== current) slide.querySelector('video').pause();
    });
    buttons[0].disabled = current === 0;
    buttons[1].disabled = current === slides.length - 1;
    position.textContent = `${current + 1} / ${slides.length}`;
  }

  function center(index, behavior = reducedMotion.matches ? 'instant' : 'smooth') {
    select(index);
    const frame = track.getBoundingClientRect();
    const card = slides[current].getBoundingClientRect();
    track.scrollTo({ left: track.scrollLeft + card.left + card.width / 2 - frame.left - frame.width / 2, behavior });
  }

  buttons.forEach(button => button.addEventListener('click', () => center(current + Number(button.dataset.direction))));
  track.addEventListener('keydown', event => {
    // Preserve the native video player's keyboard controls.
    if (event.target !== track || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    center(current + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  track.addEventListener('scroll', () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const frame = track.getBoundingClientRect();
      const distances = slides.map(slide => {
        const card = slide.getBoundingClientRect();
        return Math.abs(card.left + card.width / 2 - frame.left - frame.width / 2);
      });
      select(distances.indexOf(Math.min(...distances)));
    }, 150);
  }, { passive: true });
  slides.forEach(slide => slide.querySelector('video').addEventListener('play', () => {
    slides.forEach(other => { if (other !== slide) other.querySelector('video').pause(); });
  }));
  new ResizeObserver(() => center(current, 'instant')).observe(track);
  select(0);
  carousel.querySelector('.application-navigation').hidden = false;
}
