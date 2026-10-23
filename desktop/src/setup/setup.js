'use strict';
/* Setup and settings window. Rendered from the schema the app sends; talks to it only through window.astroviabin. */

const api = window.astroviabin;
const $ = selector => document.querySelector(selector);

let model = null;        // { mode, schema, values, platform, version, status, passwordProtection }
let values = {};
let checks = {};         // id -> { ok, message }
let problems = {};       // id -> message (validation)
let stepIndex = 0;
let confirmPassword = '';
let saved = false;
let checkTimer = null;

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
}

function steps() {
  const list = [];
  if (model.mode === 'setup') list.push({ id: 'welcome', title: 'Welcome' });
  for (const group of model.schema) list.push({ id: group.id, title: group.title, group });
  list.push({ id: 'review', title: model.mode === 'setup' ? 'Review and start' : 'Review and save' });
  return list;
}

function groupProblems(group) {
  return group.settings.some(setting => problems[setting.id] || (checks[setting.id] && !checks[setting.id].ok && setting.required));
}

function renderSteps() {
  const nav = $('#steps');
  nav.replaceChildren(...steps().map((step, index) => {
    const state = step.group ? (groupProblems(step.group) ? 'problem' : index < stepIndex ? 'done' : '') : index < stepIndex ? 'done' : '';
    return el('button', {
      type: 'button', class: 'step', 'data-state': state, 'aria-current': index === stepIndex ? 'step' : null,
      onclick: () => goTo(index),
    }, el('span', { class: 'badge', text: state === 'done' ? '✓' : state === 'problem' ? '!' : String(index + 1) }), step.title);
  }));
}

// ----------------------------------------------------------------------------------------------
// Settings

function checkLine(id) {
  const result = checks[id];
  if (!result || !result.message) return null;
  const level = result.ok ? 'ok' : 'bad';
  return el('div', { class: `check ${level}`, role: result.ok ? null : 'status', text: `${result.ok ? '✓' : '✗'} ${result.message}` });
}

function update(id, value) {
  values[id] = value;
  delete problems[id];
  scheduleCheck();
}

function settingCard(setting) {
  const id = `field-${setting.id}`;
  const card = el('div', { class: 'setting', 'data-setting': setting.id });
  const value = values[setting.id];
  let control;

  if (setting.type === 'bool') {
    control = el('label', { class: 'toggle' },
      el('input', { type: 'checkbox', id, checked: Boolean(value), onchange: event => { update(setting.id, event.target.checked); render(); } }),
      setting.label);
    card.append(control);
  } else {
    card.append(el('label', { class: 'title', for: id, text: setting.label }));
    if (setting.type === 'select') {
      control = el('select', { id, onchange: event => update(setting.id, event.target.value) },
        setting.options.map(option => el('option', { value: option.value, selected: option.value === value, text: option.label })));
      card.append(control);
    } else if (setting.type === 'password') {
      control = el('input', { type: 'password', id, value: value || '', autocomplete: 'new-password', 'aria-invalid': problems[setting.id] ? 'true' : null,
        oninput: event => update(setting.id, event.target.value) });
      const confirm = el('input', { type: 'password', id: `${id}-confirm`, value: confirmPassword, autocomplete: 'new-password', placeholder: 'Repeat the password',
        oninput: event => { confirmPassword = event.target.value; delete problems.confirm; } });
      const show = el('button', { type: 'button', class: 'button ghost small', onclick: () => {
        const type = control.type === 'password' ? 'text' : 'password';
        control.type = type; confirm.type = type; show.textContent = type === 'password' ? 'Show' : 'Hide';
      } }, 'Show');
      card.append(el('div', { class: 'row' }, control, show), el('div', { class: 'row', style: 'margin-top:8px' }, confirm));
      if (problems.confirm) card.append(el('div', { class: 'error', text: problems.confirm }));
    } else {
      control = el('input', {
        type: setting.type === 'number' ? 'number' : 'text', id, value: value ?? '', min: setting.min, max: setting.max, step: setting.step,
        spellcheck: 'false', 'aria-invalid': problems[setting.id] ? 'true' : null,
        oninput: event => update(setting.id, setting.type === 'number' ? event.target.value : event.target.value.trim()),
      });
      if (setting.type === 'dir' || setting.type === 'file') {
        const browse = el('button', { type: 'button', class: 'button ghost small', onclick: async () => {
          const picked = await api.pick({ kind: setting.type, current: values[setting.id], title: setting.label });
          if (picked) { update(setting.id, picked); control.value = picked; runChecks(); }
        } }, 'Browse…');
        card.append(el('div', { class: 'row' }, control, browse));
      } else {
        card.append(control);
      }
    }
  }
  if (problems[setting.id]) card.append(el('div', { class: 'error', text: problems[setting.id] }));
  if (setting.help) card.append(el('p', { class: 'help', text: setting.help }));
  const line = checkLine(setting.id);
  if (line) card.append(line);
  return card;
}

// ----------------------------------------------------------------------------------------------
// Pages

function welcomePage() {
  return [
    el('h2', { text: 'Welcome to AstroviaBin' }),
    el('p', { class: 'lead', text: 'AstroviaBin is your private library for astrophotography: photos and FITS, local plate solving, sky annotations, albums, stacking and transient search. It runs as a small server on this computer and you use it in your web browser.' }),
    el('div', { class: 'cards' },
      el('div', { class: 'card' }, el('h3', { text: 'Nothing runs yet' }), el('p', { text: 'The server starts only when you finish this setup. You can change every setting later from the tray icon → Settings.' })),
      el('div', { class: 'card' }, el('h3', { text: 'Your files stay yours' }), el('p', { text: 'Images are stored in folders you choose. Existing folders and databases are used as they are: nothing is moved, overwritten or deleted.' })),
      el('div', { class: 'card' }, el('h3', { text: 'Private by default' }), el('p', { text: 'Plate solving runs locally. Only sky coordinates are ever sent to online catalogues, and you can turn that off.' })),
      el('div', { class: 'card' }, el('h3', { text: 'Lives in the tray' }), el('p', { text: 'Look for the AstroviaBin icon in the system tray: open the web interface, start or stop the server, open your folders and logs.' })),
    ),
    model.platform === 'win32' ? el('div', { class: 'callout', text: 'On Windows, local plate solving needs Astrometry.net installed separately (for example in WSL or with the ANSVR package), because Astrometry.net has no native Windows build. Everything else works out of the box.' }) : null,
    el('p', { class: 'help', text: 'This takes about two minutes. Each step explains what the settings do.' }),
  ];
}

function groupPage(group) {
  return [el('h2', { text: group.title }), el('p', { class: 'lead', text: group.description }), ...group.settings.map(settingCard)];
}

function display(setting) {
  const value = values[setting.id];
  if (setting.type === 'password') return value ? '•'.repeat(10) : '(not set)';
  if (setting.type === 'bool') return value ? 'Yes' : 'No';
  if (setting.type === 'select') return (setting.options.find(option => option.value === value) || {}).label || value;
  return value === '' || value === undefined ? '(not set)' : String(value);
}

function reviewPage() {
  const rows = [];
  for (const group of model.schema) {
    rows.push(el('tr', {}, el('th', { colspan: '2', text: group.title })));
    for (const setting of group.settings) {
      const result = checks[setting.id];
      rows.push(el('tr', {},
        el('td', { text: setting.label }),
        el('td', { class: 'value' }, display(setting),
          problems[setting.id] ? el('div', { class: 'error', text: problems[setting.id] }) : null,
          result && result.message ? el('div', { class: `check ${result.ok ? 'ok' : 'bad'}`, text: `${result.ok ? '✓' : '✗'} ${result.message}` }) : null)));
    }
  }
  const blocking = Object.keys(problems).length;
  const warnings = Object.values(checks).filter(result => !result.ok).length;
  return [
    el('h2', { text: model.mode === 'setup' ? 'Review and start' : 'Review and save' }),
    el('p', { class: 'lead', text: model.mode === 'setup'
      ? 'Check your choices. When you press "Save and start", the settings are saved, the folders are created if needed and the server starts. AstroviaBin then opens in your browser.'
      : 'Saving restarts the server when a change needs it (your browser tabs reconnect automatically).' }),
    blocking ? el('div', { class: 'callout', text: `${blocking} setting${blocking === 1 ? ' needs' : 's need'} attention before saving.` }) : null,
    !blocking && warnings ? el('div', { class: 'callout', text: `${warnings} check${warnings === 1 ? '' : 's'} reported a problem (✗). You can still continue; the related features will be unavailable until it is fixed.` }) : null,
    el('p', { class: 'help', text: `Administrator password: ${model.passwordProtection}.` }),
    el('table', { class: 'review' }, el('tbody', {}, rows)),
  ];
}

function finishedPage() {
  const status = model.status || {};
  return [
    el('h2', { text: model.mode !== 'setup' ? 'Settings saved' : status.status === 'running' ? 'AstroviaBin is running' : status.status === 'error' ? 'AstroviaBin could not start' : 'AstroviaBin is starting…' }),
    el('p', { class: 'lead', text: status.status === 'running'
      ? `AstroviaBin is running. Open it at http://localhost:${values.port} and sign in as "${values.adminUser}".`
      : status.message || 'Starting the server…' }),
    el('div', { class: 'cards' },
      el('div', { class: 'card' }, el('h3', { text: 'Tray icon' }), el('p', { text: 'AstroviaBin keeps running in the system tray when this window is closed. Right-click the icon for every option.' })),
      el('div', { class: 'card' }, el('h3', { text: 'Other devices' }), el('p', { text: values.host === '0.0.0.0'
        ? `Other devices on your network can open http://<this computer's address>:${values.port}.`
        : 'Only this computer can open AstroviaBin. Allow your network in Settings → Server if you need it.' })),
    ),
    status.status === 'running' ? el('button', { type: 'button', class: 'button primary', onclick: () => api.openExternal(`http://localhost:${values.port}`) }, 'Open AstroviaBin') : null,
  ];
}

function render() {
  const all = steps();
  const step = all[stepIndex];
  const panel = $('#panel');
  panel.replaceChildren(...(saved ? finishedPage() : step.id === 'welcome' ? welcomePage() : step.id === 'review' ? reviewPage() : groupPage(step.group)).filter(Boolean));
  renderSteps();
  const last = stepIndex === all.length - 1;
  $('#back').disabled = stepIndex === 0 || saved;
  $('#back').hidden = saved;
  $('#check').hidden = saved || step.id === 'welcome';
  $('#next').textContent = saved ? 'Close window' : last ? (model.mode === 'setup' ? 'Save and start' : 'Save') : 'Next';
  $('#footer-note').textContent = saved ? '' : `Step ${stepIndex + 1} of ${all.length}`;
}

// ----------------------------------------------------------------------------------------------
// Validation, checks, navigation

function validateGroup(group) {
  let ok = true;
  for (const setting of group.settings) {
    const value = values[setting.id];
    if (setting.required && (value === '' || value === undefined || value === null)) { problems[setting.id] = 'Required.'; ok = false; }
    if (setting.type === 'number' && value !== '' && value !== undefined) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < setting.min || number > setting.max) { problems[setting.id] = `Enter a number from ${setting.min} to ${setting.max}.`; ok = false; }
    }
    if (setting.minLength && String(value || '').length < setting.minLength) { problems[setting.id] = `At least ${setting.minLength} characters.`; ok = false; }
    if (setting.type === 'password' && passwordChanged() && confirmPassword !== value) { problems.confirm = 'The two passwords do not match.'; ok = false; }
  }
  if (group.id === 'solving' && values.plateSolvingEnabled && !values.solveField) { problems.solveField = 'Set the solve-field program, or disable plate solving.'; ok = false; }
  return ok;
}

function passwordChanged() {
  return model.mode === 'setup' || values.adminPassword !== model.values.adminPassword;
}

function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runChecks, 600);
}

async function runChecks() {
  const pythonCard = document.querySelector('[data-setting="pythonPath"]');
  if (pythonCard && values.pythonPath && !(checks.pythonPath && checks.pythonPath.ok)) {
    pythonCard.querySelector('.check')?.remove();
    pythonCard.append(el('div', { class: 'check warn', text: '… Checking the analysis packages (the first check after installing can take a few minutes).' }));
  }
  checks = await api.check(values);
  // Keep focus and typing undisturbed: only redraw the check lines.
  for (const [id, result] of Object.entries(checks)) {
    const card = document.querySelector(`[data-setting="${id}"]`);
    if (!card) continue;
    card.querySelector('.check')?.remove();
    const line = checkLine(id);
    if (line) card.append(line);
  }
  renderSteps();
}

function goTo(index) {
  if (saved) return;
  stepIndex = Math.max(0, Math.min(index, steps().length - 1));
  render();
  $('#panel').scrollTop = 0;
  $('#panel').focus();
  runChecks();
}

async function next() {
  if (saved) { api.close(); return; }
  const all = steps();
  const step = all[stepIndex];
  if (step.group && !validateGroup(step.group)) { render(); return; }
  if (stepIndex < all.length - 1) { goTo(stepIndex + 1); return; }

  // Final step: validate everything, then save.
  let firstProblem = -1;
  all.forEach((candidate, index) => { if (candidate.group && !validateGroup(candidate.group) && firstProblem < 0) firstProblem = index; });
  if (firstProblem >= 0) { stepIndex = firstProblem; render(); return; }
  $('#next').disabled = true;
  const result = await api.save(values);
  $('#next').disabled = false;
  if (!result.ok) {
    problems = result.problems;
    const index = all.findIndex(candidate => candidate.group && candidate.group.settings.some(setting => problems[setting.id]));
    stepIndex = index >= 0 ? index : stepIndex;
    render();
    return;
  }
  saved = true;
  render();
}

function showStatus(status) {
  model.status = status;
  const box = $('#status');
  box.hidden = !status || !status.status || (model.mode === 'setup' && !saved);
  box.dataset.status = status.status;
  $('#status-text').textContent = status.message || status.status;
  if (saved) render();
}

async function init() {
  model = await api.state();
  values = { ...model.values };
  document.title = model.mode === 'setup' ? 'AstroviaBin setup' : 'AstroviaBin settings';
  $('#subtitle').textContent = `${model.mode === 'setup' ? 'First-time setup' : 'Settings'} · v${model.version}`;
  $('#back').addEventListener('click', () => goTo(stepIndex - 1));
  $('#next').addEventListener('click', next);
  $('#check').addEventListener('click', runChecks);
  api.onStatus(showStatus);
  showStatus(model.status);
  render();
  runChecks();
}

init();
