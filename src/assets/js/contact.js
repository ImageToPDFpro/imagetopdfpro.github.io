/* Contact form: composes a pre-filled email in the visitor's mail app (no backend needed). */
const form = document.getElementById('contact-form');

if (form) {
  const error = document.getElementById('contact-error');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    const message = String(data.get('message') || '').trim();
    if (!name || !message) {
      error.hidden = false;
      form.querySelector(name ? '#contact-message' : '#contact-name').focus();
      return;
    }
    error.hidden = true;
    const subject = `[${document.title.split('|').pop().trim()}] ${data.get('topic')}`;
    const body = `${message}\n\n-- \n${name}\nPage: ${document.referrer || location.href}\nBrowser: ${navigator.userAgent}`;
    location.href = `mailto:${form.dataset.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  });
}
