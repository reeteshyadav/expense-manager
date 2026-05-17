(function () {
  const TABLE = 'expenses';
  const SYNC_DEBOUNCE_MS = 800;
  const RETRY_BASE_MS = 5000;
  const RETRY_MAX_MS = 5 * 60 * 1000;

  let client = null;
  let session = null;
  let profile = null;
  let syncTimer = null;
  let syncing = false;
  let onSessionChange = () => {};
  let onStatus = () => {};
  let readAll = async () => [];
  let upsertLocal = async () => {};
  let markSynced = async () => {};
  let render = async () => {};

  function isConfigured() {
    const cfg = window.SUPABASE_CONFIG || {};
    return Boolean(
      window.supabase &&
      cfg.url &&
      cfg.anonKey &&
      !cfg.url.includes('YOUR_PROJECT_REF') &&
      !cfg.anonKey.includes('YOUR_PUBLIC_ANON_KEY')
    );
  }

  function setStatus(message, isError = false) {
    onStatus(message, isError);
  }

  function retryState() {
    try { return JSON.parse(localStorage.getItem('expense_sync_retry') || '{}'); }
    catch { return {}; }
  }

  function saveRetryState(state) {
    localStorage.setItem('expense_sync_retry', JSON.stringify(state));
  }

  function clearRetryState() {
    localStorage.removeItem('expense_sync_retry');
  }

  function nextRetryDelay() {
    const state = retryState();
    const attempts = Math.min(Number(state.attempts || 0) + 1, 8);
    const delay = Math.min(RETRY_BASE_MS * (2 ** (attempts - 1)), RETRY_MAX_MS);
    saveRetryState({ attempts, lastFailureAt: new Date().toISOString() });
    return delay;
  }

  function toRemote(row, userId) {
    return {
      id: row.id,
      user_id: userId,
      date: row.date,
      category: row.category,
      amount: Number(row.amount || 0),
      description: row.description || '',
      created_at: row.created_at || row.createdAtIso || new Date(row.createdAt || Date.now()).toISOString(),
      updated_at: row.updated_at,
      deleted: Boolean(row.deleted)
    };
  }

  function toLocal(row, synced = true) {
    return {
      id: row.id,
      date: row.date,
      category: row.category,
      amount: Number(row.amount || 0),
      description: row.description || '',
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted: Boolean(row.deleted),
      synced
    };
  }

  async function pushLocalChanges() {
    const rows = (await readAll({ includeDeleted: true }))
      .filter(row => row.id && row.synced === false);
    if (!rows.length || !session?.user?.id) return 0;

    const payload = rows.map(row => toRemote(row, session.user.id));
    const { error } = await client.from(TABLE).upsert(payload, { onConflict: 'id' });
    if (error) throw error;

    await Promise.all(rows.map(row => markSynced(row.id)));
    return rows.length;
  }

  async function pullRemoteChanges() {
    if (!session?.user?.id) return 0;
    const { data, error } = await client
      .from(TABLE)
      .select('id,user_id,date,category,amount,description,created_at,updated_at,deleted')
      .order('updated_at', { ascending: true });
    if (error) throw error;

    const localRows = await readAll({ includeDeleted: true });
    const localById = new Map(localRows.map(row => [row.id, row]));
    let changed = 0;

    for (const remoteRow of data || []) {
      const localRow = localById.get(remoteRow.id);
      if (!localRow) {
        await upsertLocal(toLocal(remoteRow, true));
        changed++;
        continue;
      }

      const localTime = Date.parse(localRow.updated_at || 0);
      const remoteTime = Date.parse(remoteRow.updated_at || 0);
      if (remoteTime > localTime) {
        await upsertLocal(toLocal(remoteRow, true));
        changed++;
      } else if (localTime > remoteTime && localRow.synced !== false) {
        await upsertLocal({ ...localRow, synced: false });
      }
    }
    return changed;
  }

  async function syncNow(reason = 'manual') {
    if (!client || !session?.user) {
      setStatus(isConfigured() ? 'Sign in to enable cloud sync' : 'Cloud sync not configured');
      return { pushed: 0, pulled: 0 };
    }
    if (!navigator.onLine) {
      setStatus('Offline. Changes will sync when internet returns.');
      return { pushed: 0, pulled: 0 };
    }
    if (syncing) return { pushed: 0, pulled: 0 };

    syncing = true;
    setStatus('Syncing...');
    try {
      const pulled = await pullRemoteChanges();
      const pushed = await pushLocalChanges();
      clearRetryState();
      setStatus(`Synced ${new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' })}`);
      if (pushed || pulled || reason === 'login') await render();
      return { pushed, pulled };
    } catch (error) {
      const delay = nextRetryDelay();
      setStatus(error.message || 'Cloud sync failed', true);
      window.setTimeout(() => queueSync('retry'), delay);
      return { pushed: 0, pulled: 0, error };
    } finally {
      syncing = false;
    }
  }

  async function loadProfile() {
    if (!client || !session?.user) {
      profile = null;
      return null;
    }

    const { data, error } = await client
      .from('user_profiles')
      .select('email,full_name,phone,disabled')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (error) throw error;
    profile = data || null;
    return profile;
  }

  function queueSync(reason = 'change') {
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => syncNow(reason), SYNC_DEBOUNCE_MS);
  }

  async function init(options) {
    readAll = options.readAll;
    upsertLocal = options.upsertLocal;
    markSynced = options.markSynced;
    render = options.render;
    onStatus = options.onStatus || onStatus;
    onSessionChange = options.onSessionChange || onSessionChange;

    if (!isConfigured()) {
      setStatus('Cloud sync not configured');
      onSessionChange(null);
      return null;
    }

    const cfg = window.SUPABASE_CONFIG;
    client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });

    const { data } = await client.auth.getSession();
    session = data.session || null;
    if (session) {
      try { await loadProfile(); } catch { profile = null; }
    }
    onSessionChange(session);
    setStatus(session ? 'Cloud sync ready' : 'Sign in to enable cloud sync');
    if (session) queueSync('restore');

    client.auth.onAuthStateChange(async (_event, newSession) => {
      session = newSession;
      if (session) {
        try { await loadProfile(); } catch { profile = null; }
      } else {
        profile = null;
      }
      onSessionChange(session);
      setStatus(session ? 'Cloud sync ready' : 'Signed out. Local data remains on this device.');
      if (session) queueSync('login');
    });

    window.addEventListener('online', () => queueSync('online'));
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') queueSync('visible');
    });

    return client;
  }

  async function signIn(email, password) {
    if (!client) throw new Error('Cloud sync is not configured');
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async function signOut() {
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) throw error;
  }

  async function updatePassword(password) {
    if (!client) throw new Error('Cloud sync is not configured');
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
  }

  window.cloudSync = {
    init,
    queueSync,
    syncNow,
    signIn,
    signOut,
    updatePassword,
    loadProfile,
    getSession: () => session,
    getProfile: () => profile,
    isConfigured
  };
})();
