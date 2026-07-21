(() => {
  'use strict';

  const CONFIG = { apiUrl: 'https://api.mueblesavenida.com' };
  const STORAGE_KEY = 'mis-tareas-session';
  const state = {
    session: loadSession(),
    folders: [],
    folder: null,
    tasks: [],
    loading: false,
    saveTimers: new Map(),
  };

  const $ = (selector) => document.querySelector(selector);

  function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, { ...options, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
    });
  }

  // Session ---------------------------------------------------------------

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null;
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    state.session = session;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function clearSession() {
    state.session = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    })[character]);
  }

  // API -------------------------------------------------------------------

  function api(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    if (state.session?.access_token) {
      headers.Authorization = `Bearer ${state.session.access_token}`;
    }

    return fetch(`${CONFIG.apiUrl}${path}`, { ...options, headers }).then(
      async (response) => {
        const body = await response.json().catch(() => ({}));

        if (!response.ok) {
          const error = new Error(
            body?.errors?.[0]?.message || `Error ${response.status}`,
          );
          error.status = response.status;
          throw error;
        }

        return body.data ?? body;
      },
    );
  }

  async function refreshToken() {
    if (!state.session?.refresh_token) return false;

    try {
      const data = await fetch(`${CONFIG.apiUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refresh_token: state.session.refresh_token,
          mode: 'json',
        }),
      }).then((response) => response.json());

      if (!data.data) return false;
      saveSession(data.data);
      return true;
    } catch {
      return false;
    }
  }

  async function withAuth(request) {
    try {
      return await request();
    } catch (error) {
      if (error.status === 401 && await refreshToken()) return request();

      if (error.status === 401) {
        clearSession();
        showLogin();
      }

      throw error;
    }
  }

  // UI helpers ------------------------------------------------------------

  function setBusy(button, busy, label = 'Cargando…') {
    if (!button) return;

    if (busy) {
      button.dataset.label = button.innerHTML;
      button.innerHTML = label;
      button.disabled = true;
    } else {
      button.innerHTML = button.dataset.label || button.innerHTML;
      button.disabled = false;
    }
  }

  function showLogin() {
    $('#login-view').hidden = false;
    $('#workspace-view').hidden = true;
    $('#email').focus();
  }

  function showWorkspace() {
    $('#login-view').hidden = true;
    $('#workspace-view').hidden = false;
    $('#user-email').textContent = state.session?.user?.email || '';
    route();
  }

  function notify(message, error = false) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast${error ? ' error' : ''}`;
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 3500);
  }

  function errorView(message) {
    return `<div class="empty-state">
      <strong>Algo no ha ido bien</strong>
      <span>${escapeHtml(message)}</span>
      <br>
      <button class="retry-button" data-action="retry">Reintentar</button>
    </div>`;
  }

  // Authentication --------------------------------------------------------

  async function login(event) {
    event.preventDefault();
    const form = event.target.closest('form');
    if (!form) return;

    const button = form.querySelector('button[type=submit]');
    const error = $('#login-error');
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;

    error.hidden = true;
    setBusy(button, true, 'Entrando…');

    if (!email || !password) {
      error.textContent = 'Rellena el correo y la contraseña.';
      error.hidden = false;
      setBusy(button, false);
      return;
    }

    try {
      const response = await fetchWithTimeout(`${CONFIG.apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, mode: 'json' }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw Object.assign(
          new Error(body?.errors?.[0]?.message || 'No se pudo iniciar sesión'),
          { status: response.status },
        );
      }

      if (!body.data?.access_token || !body.data?.refresh_token) {
        throw new Error('Directus no devolvió los tokens de sesión.');
      }

      saveSession({ ...body.data, user: { email } });
      showWorkspace();
    } catch (loginError) {
      console.error(loginError);
      const message = loginError?.name === 'AbortError'
        ? 'La API tardó demasiado en responder.'
        : loginError?.message || '';

      error.textContent = loginError?.status === 401 || message.includes('Invalid')
        ? 'El correo o la contraseña no son correctos.'
        : message === 'Failed to fetch' || message.includes('NetworkError')
          ? 'El navegador no puede conectar con la API. Revisa CORS y vuelve a cargar la página.'
          : `No se pudo iniciar sesión: ${message || 'Error desconocido'}`;
      error.hidden = false;
    } finally {
      setBusy(button, false);
    }
  }

  // Folders ----------------------------------------------------------------

  async function fetchFolders() {
    return withAuth(() => api(
      `/items/carpetas_tareas?fields=id,nombre,date_created&sort=-date_created&_refresh=${Date.now()}`,
    ));
  }

  async function loadFolders() {
    state.loading = true;
    renderFolders();

    try {
      state.folders = await fetchFolders();
      renderFolders();
    } catch (error) {
      $('#workspace-content').innerHTML = errorView(error.message);
    } finally {
      state.loading = false;
    }
  }

  function renderFolders() {
    const folderCards = state.loading
      ? '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'
      : state.folders.map(folderCard).join('');
    const addFolderCard = !state.loading && state.folders.length
      ? '<button class="add-card" data-action="new-folder">+ Añadir carpeta</button>'
      : '';
    const emptyState = !state.loading && !state.folders.length
      ? '<div class="empty-state"><strong>Aún no tienes carpetas</strong><span>Crea una para empezar a ordenar tus tareas.</span><br><button class="retry-button" data-action="new-folder">Crear mi primera carpeta</button></div>'
      : '';

    $('#workspace-content').innerHTML = `
      <div class="page-header">
        <div>
          <p class="eyebrow">TU ORGANIZACIÓN</p>
          <h2>Mis carpetas</h2>
          <p>Todo lo que tienes en marcha, en un mismo lugar.</p>
        </div>
        <button class="primary-button" data-action="new-folder">
          <span>+ Nueva carpeta</span>
        </button>
      </div>
      <p class="section-label">${state.folders.length ? 'CARPETAS ACTIVAS' : 'EMPIEZA POR AQUÍ'}</p>
      <div class="folder-grid">${folderCards}${addFolderCard}${emptyState}</div>
    `;
  }

  function folderCard(folder) {
    return `
      <article class="folder-card">
        <a class="folder-link" href="#folder/${encodeURIComponent(folder.id)}">
          <div class="folder-icon" aria-hidden="true"></div>
          <div class="folder-name">${escapeHtml(folder.nombre)}</div>
          <div class="folder-meta">Abrir carpeta →</div>
        </a>
        <div class="card-actions">
          <button class="mini-button" title="Renombrar" aria-label="Renombrar ${escapeHtml(folder.nombre)}" data-action="rename-folder" data-id="${folder.id}">✎</button>
        </div>
      </article>
    `;
  }

  async function createFolder() {
    const name = prompt('Nombre de la nueva carpeta:');
    if (!name?.trim()) return;

    try {
      const created = await withAuth(() => api('/items/carpetas_tareas', {
        method: 'POST',
        body: JSON.stringify({ nombre: name.trim() }),
      }));

      if (created?.id) {
        state.folders = [
          created,
          ...state.folders.filter((folder) => folder.id !== created.id),
        ];
        renderFolders();
      }

      notify('Carpeta creada');
      await loadFolders();
    } catch (error) {
      notify(error.message, true);
    }
  }

  async function renameFolder(id) {
    const folder = state.folders.find((item) => item.id === id);
    const name = prompt('Nuevo nombre:', folder?.nombre || '');
    if (!name?.trim() || name.trim() === folder?.nombre) return;

    try {
      await withAuth(() => api(`/items/carpetas_tareas/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ nombre: name.trim() }),
      }));
      notify('Carpeta renombrada');
      await loadFolders();
    } catch (error) {
      notify(error.message, true);
    }
  }

  // Tasks ------------------------------------------------------------------

  async function loadTasks() {
    state.loading = true;
    renderTasks();

    try {
      const [tasks, folders] = await Promise.all([
        withAuth(() => api(
          `/items/tareas?fields=id,titulo,descripcion,completada,date_created,carpeta&sort=-date_created&_refresh=${Date.now()}`,
        )),
        fetchFolders(),
      ]);

      state.folders = folders;
      const folderNames = new Map(
        folders.map((folder) => [String(folder.id), folder.nombre]),
      );

      state.tasks = tasks.map((task) => {
        const folderId = typeof task.carpeta === 'object'
          ? task.carpeta?.id
          : task.carpeta;

        return {
          ...task,
          folderId,
          folderName: typeof task.carpeta === 'object'
            ? task.carpeta?.nombre
            : folderNames.get(String(folderId)) || 'Sin carpeta',
        };
      });
      renderTasks();
    } catch (error) {
      $('#workspace-content').innerHTML = errorView(error.message);
    } finally {
      state.loading = false;
    }
  }

  function folderOptions(selected = '') {
    return state.folders.map((folder) => `
      <option value="${escapeHtml(folder.id)}" ${String(folder.id) === String(selected) ? 'selected' : ''}>
        ${escapeHtml(folder.nombre)}
      </option>
    `).join('');
  }

  function renderTasks() {
    const pending = state.tasks.filter((task) => !task.completada);
    const done = state.tasks.filter((task) => task.completada);
    const loadingState = state.loading
      ? '<section><div class="task-list"><div class="empty-state">Cargando tareas…</div></div></section>'
      : `
        <section>
          <h3 class="task-column-title"><span class="dot"></span>Pendientes <span class="count">${pending.length}</span></h3>
          <div class="task-list">
            ${pending.length ? pending.map(taskCard).join('') : '<div class="empty-state"><strong>Todo despejado</strong><span>No tienes tareas pendientes.</span></div>'}
          </div>
        </section>
        <section>
          <h3 class="task-column-title"><span class="dot green"></span>Completadas <span class="count">${done.length}</span></h3>
          <div class="task-list">
            ${done.length ? done.map(taskCard).join('') : '<div class="empty-state"><span>Aquí aparecerán tus tareas terminadas.</span></div>'}
          </div>
        </section>
      `;

    $('#workspace-content').innerHTML = `
      <div class="page-header">
        <div>
          <p class="eyebrow">TU ESPACIO PERSONAL</p>
          <h2>Mis tareas</h2>
          <p>Tus pendientes y tus logros, en un mismo lugar.</p>
        </div>
        <a class="secondary-button" href="#folders">Gestionar carpetas <span aria-hidden="true">↗</span></a>
      </div>
      <form id="new-task-form" class="new-task dashboard-new-task">
        <input class="new-task-input" name="title" placeholder="¿Qué necesitas hacer?" aria-label="Título de la nueva tarea" required />
        <select class="folder-select" name="folder" aria-label="Carpeta de la nueva tarea" ${state.folders.length ? '' : 'disabled'}>
          ${state.folders.length ? folderOptions() : '<option>No tienes carpetas</option>'}
        </select>
        <button class="primary-button" type="submit" ${state.folders.length ? '' : 'disabled'}>
          <span>Añadir tarea</span><span aria-hidden="true">↗</span>
        </button>
      </form>
      <p class="form-hint" ${state.folders.length ? 'hidden' : ''}>
        Crea una carpeta para poder añadir tareas. <a href="#folders">Gestionar carpetas</a>
      </p>
      <p class="section-label">${state.tasks.length ? 'TODAS TUS TAREAS' : 'EMPIEZA POR AQUÍ'}</p>
      <div class="task-columns">${loadingState}</div>
    `;
  }

  async function loadFolder(id) {
    state.folder = state.folders.find((folder) => String(folder.id) === String(id)) || {
      id,
      nombre: 'Carpeta',
    };
    state.loading = true;
    renderFolder();

    try {
      if (!state.folders.length) {
        state.folders = await fetchFolders();
        state.folder = state.folders.find((folder) => String(folder.id) === String(id)) || state.folder;
      }

      state.tasks = await withAuth(() => api(
        `/items/tareas?filter[carpeta][_eq]=${encodeURIComponent(id)}&fields=id,titulo,descripcion,completada,date_created&sort=-date_created`,
      ));
      renderFolder();
    } catch (error) {
      $('#workspace-content').innerHTML = errorView(error.message);
    } finally {
      state.loading = false;
    }
  }

  function renderFolder() {
    const pending = state.tasks.filter((task) => !task.completada);
    const done = state.tasks.filter((task) => task.completada);

    $('#workspace-content').innerHTML = `
      <a class="back-link" href="#folders">← Todas las carpetas</a>
      <div class="folder-heading">
        <div class="folder-icon" aria-hidden="true"></div>
        <div>
          <p class="eyebrow">CARPETA</p>
          <h2>${escapeHtml(state.folder.nombre)}</h2>
        </div>
      </div>
      <form id="new-task-form" class="new-task">
        <input class="new-task-input" name="title" placeholder="¿Qué necesitas hacer?" aria-label="Título de la nueva tarea" required />
        <button class="primary-button" type="submit"><span>Añadir tarea</span><span aria-hidden="true">↗</span></button>
      </form>
      <div class="task-columns">
        <section>
          <h3 class="task-column-title"><span class="dot"></span>Pendientes <span class="count">${pending.length}</span></h3>
          <div class="task-list">
            ${state.loading ? '<div class="empty-state">Cargando tareas…</div>' : pending.length ? pending.map(taskCard).join('') : '<div class="empty-state"><strong>Todo despejado</strong><span>No tienes tareas pendientes.</span></div>'}
          </div>
        </section>
        <section>
          <h3 class="task-column-title"><span class="dot green"></span>Completadas <span class="count">${done.length}</span></h3>
          <div class="task-list">
            ${state.loading ? '' : done.length ? done.map(taskCard).join('') : '<div class="empty-state"><span>Aquí aparecerán tus tareas terminadas.</span></div>'}
          </div>
        </section>
      </div>
    `;
  }

  function taskCard(task) {
    return `
      <article class="task-card ${task.completada ? 'done' : ''}" data-task-id="${task.id}">
        <div class="task-summary">
          <button class="complete-toggle" data-action="toggle-completed" type="button" aria-label="Marcar como ${task.completada ? 'pendiente' : 'completada'}">
            <span class="check-box" aria-hidden="true">${task.completada ? '✓' : ''}</span>
          </button>
          <button class="task-title-button" data-action="toggle-task" type="button" aria-expanded="false">
            <span>
              <span class="task-title">${escapeHtml(task.titulo)}</span>
              ${task.folderName ? `<small class="task-folder">${escapeHtml(task.folderName)}</small>` : ''}
            </span>
            <span class="chevron" aria-hidden="true">⌄</span>
          </button>
        </div>
        <div class="task-editor" hidden>
          <input data-field="titulo" value="${escapeHtml(task.titulo)}" aria-label="Título" />
          <textarea data-field="descripcion" placeholder="Añade una descripción…" aria-label="Descripción">${escapeHtml(task.descripcion || '')}</textarea>
          <div class="editor-footer">
            <span class="save-status" data-status>Guardado</span>
          </div>
        </div>
      </article>
    `;
  }

  async function createTask(form) {
    const title = form.title.value.trim();
    const folderId = form.elements.folder?.value || state.folder?.id;
    if (!title) return;

    if (!folderId) {
      notify('Crea una carpeta antes de añadir tareas', true);
      return;
    }

    const button = form.querySelector('button');
    setBusy(button, true, 'Añadiendo…');

    try {
      await withAuth(() => api('/items/tareas?fields=id', {
        method: 'POST',
        body: JSON.stringify({ titulo: title, carpeta: folderId }),
      }));
      form.reset();
      notify('Tarea añadida');

      if (location.hash.match(/^#folder\//)) {
        await loadFolder(folderId);
      } else {
        await loadTasks();
      }
    } catch (error) {
      notify(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  async function saveTask(taskId, patch, status) {
    clearTimeout(state.saveTimers.get(taskId));
    status.textContent = 'Guardando…';
    status.className = 'save-status saving';

    state.saveTimers.set(taskId, setTimeout(async () => {
      try {
        await withAuth(() => api(`/items/tareas/${taskId}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }));
        status.textContent = 'Guardado';
        status.className = 'save-status saved';
        setTimeout(() => {
          status.className = 'save-status';
        }, 1200);
      } catch (error) {
        status.textContent = 'Error al guardar';
        status.className = 'save-status error';
        notify('No se pudo guardar la tarea', true);
      }
    }, 550));
  }

  // Events and routing ----------------------------------------------------

  function refreshCurrentView() {
    if (location.hash.match(/^#folder\//)) {
      loadFolder(state.folder.id);
    } else {
      loadTasks();
    }
  }

  function route() {
    const match = location.hash.match(/^#folder\/(.+)$/);

    if (match) {
      loadFolder(decodeURIComponent(match[1]));
    } else if (location.hash === '#folders') {
      loadFolders();
    } else {
      loadTasks();
    }
  }

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'login-form') login(event);

    if (event.target.id === 'new-task-form') {
      event.preventDefault();
      createTask(event.target);
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

    if (action === 'new-folder') createFolder();
    if (action === 'rename-folder') renameFolder(target.dataset.id);
    if (action === 'retry') route();
    if (action === 'logout') {
      clearSession();
      showLogin();
    }
    if (action === 'toggle-completed') {
      const card = target.closest('.task-card');
      const completed = !card.classList.contains('done');
      const status = card.querySelector('[data-status]');

      card.classList.toggle('done', completed);
      card.querySelector('.check-box').textContent = completed ? '✓' : '';
      saveTask(card.dataset.taskId, { completada: completed }, status);
      setTimeout(refreshCurrentView, 700);
    }

    if (action === 'toggle-task') {
      const card = target.closest('.task-card');
      const editor = card.querySelector('.task-editor');
      const open = editor.hidden;

      editor.hidden = !open;
      card.classList.toggle('open', open);
      target.setAttribute('aria-expanded', open);

      if (open) editor.querySelector('[data-field=titulo]').focus();
    }
  });

  document.addEventListener('input', (event) => {
    const field = event.target.dataset.field;
    if (!field) return;

    const card = event.target.closest('.task-card');
    const status = card.querySelector('[data-status]');
    saveTask(card.dataset.taskId, { [field]: event.target.value }, status);
  });

  document.addEventListener('change', (event) => {
    if (event.target.dataset.field !== 'completada') return;

    const card = event.target.closest('.task-card');
    saveTask(
      card.dataset.taskId,
      { completada: event.target.checked },
      card.querySelector('[data-status]'),
    );
  });

  $('#toggle-password').addEventListener('click', () => {
    const input = $('#password');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  $('#logout-button').dataset.action = 'logout';
  window.addEventListener('hashchange', route);

  if (state.session?.refresh_token) {
    showWorkspace();
  } else {
    clearSession();
    showLogin();
  }
})();
