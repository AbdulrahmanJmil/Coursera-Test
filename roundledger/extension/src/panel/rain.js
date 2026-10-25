// Decorative glyph rain behind the header. Purely visual: it carries no data
// and is hidden from assistive technology and when reduced motion is requested.
export function startRain(canvas) {
  if (!canvas || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');
  const glyphs = '01ｱｲｳｴｵｶｷｸｹｺ<>/=+*';
  const size = 10;
  let cols = [];
  const resize = () => {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    cols = Array.from({ length: Math.ceil(canvas.width / size) }, () => Math.random() * -20);
  };
  resize();
  new ResizeObserver(resize).observe(canvas);
  let last = 0;
  const tick = (t) => {
    requestAnimationFrame(tick);
    if (document.hidden || t - last < 90) return;
    last = t;
    ctx.fillStyle = 'rgba(5, 8, 13, 0.35)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#34f08a';
    ctx.font = `${size}px monospace`;
    cols.forEach((y, i) => {
      if (y > 0) ctx.fillText(glyphs[(Math.random() * glyphs.length) | 0], i * size, y * size);
      cols[i] = y * size > canvas.height && Math.random() > 0.9 ? Math.random() * -10 : y + 1;
    });
  };
  requestAnimationFrame(tick);
}
