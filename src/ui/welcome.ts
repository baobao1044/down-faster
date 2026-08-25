import { loadSettings, saveSettings } from '../shared/settings';
import { applyI18n } from '../shared/i18n';
import { byId, on } from './dom';
import { initA11y } from './a11y';

const autoEl = byId<HTMLInputElement>('auto');
const doneEl = byId<HTMLButtonElement>('done');

void (async () => {
  initA11y();
  applyI18n();
  autoEl.checked = (await loadSettings()).autoMode;
})();

on(autoEl, 'change', () => {
  void saveSettings({ autoMode: autoEl.checked });
});

on(doneEl, 'click', () => {
  void saveSettings({ onboarded: true }).then(() => window.close());
});
