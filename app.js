(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const CHANNELS = {
    global: { title: 'REALMS-WIDE', label: 'WORLD', symbol: '✧', placeholder: 'say hi to all worlds…', empty: 'a little place between worlds ♡' },
    game: { title: 'CURRENT GAME', label: 'GAME', symbol: '♜', placeholder: 'say something here…', empty: 'no messages in this world yet' },
    buddy: { title: 'API BUDDY', label: 'BUDDY', symbol: '☼', placeholder: 'say hello to your buddy…', empty: 'add your API details in ⚙ to wake your buddy ♡' }
  };
  const PREFS_KEY = 'orphicCommunicatorPrefs_v1';
  const GUEST_NAME_KEY = 'orphicCommunicatorGuestName_v1';
  const GUEST_ID_KEY = 'orphicCommunicatorGuestId_v1';
  const DM_CACHE_KEY = 'orphicCommunicatorDMs_v1';
  const HISTORY_KEY = 'orphicCommunicatorLocalHistory_v1';
  let me = null;
  let bootstrap = null;
  let socket = null;
  let active = 'global';
  let visible = new Set(['global', 'game', 'buddy']);
  let dmList = [];
  let dmByPartner = new Map();
  let gameConversations = new Map();
  let channelConversations = new Map();
  let messageCache = new Map();
  let messageLoaded = new Set();
  let joining = new Set();
  let unreadByConversation = new Map();
  let currentGame = 'island-of-nurn';
  let popupMode = new URLSearchParams(location.search).get('window') === 'popup';
  let toastTimer = null;
  let buddyApiKey = '';
  let prefs = { endpoint: 'https://api.openai.com/v1/chat/completions', model: '', showTimestamps: true };
  let callState = null;
  let callSerial = 0;

  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      prefs = { ...prefs, ...saved };
    } catch (_) {}
  }
  function savePrefs() {
    // Do not store the Buddy API key in localStorage.
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
  }
  function loadLocalState() {
    // Browser-local convenience only: no account, no server-side database, and no promise of cross-device history.
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
      for (const [id, list] of Object.entries(saved)) {
        if (Array.isArray(list)) messageCache.set(String(id), list.slice(-80).map(normalizeMessage));
      }
    } catch (_) {}
    try {
      const savedDMs = JSON.parse(localStorage.getItem(DM_CACHE_KEY) || '[]');
      if (Array.isArray(savedDMs)) dmList = savedDMs.filter(d => d && d.id && d.partnerId && d.username).slice(0, 100);
      dmByPartner = new Map(dmList.map(dm => [String(dm.partnerId), { id: String(dm.id), kind: 'dm', key: 'dm:' + dm.partnerId, partnerId: String(dm.partnerId), username: dm.username }]));
    } catch (_) {}
  }
  function persistHistory() {
    try {
      const entries = [...messageCache.entries()].slice(-20);
      const snapshot = Object.fromEntries(entries.map(([id, list]) => [id, list.slice(-60)]));
      localStorage.setItem(HISTORY_KEY, JSON.stringify(snapshot));
    } catch (_) { /* Browser storage may be unavailable or full; live chat still works. */ }
  }
  function persistDmList() {
    try { localStorage.setItem(DM_CACHE_KEY, JSON.stringify(dmList.slice(0, 100))); } catch (_) {}
  }
  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function showToast(message) {
    let el = $('toast');
    if (!el) {
      el = document.createElement('div'); el.id = 'toast'; el.className = 'toast-mini'; document.body.appendChild(el);
    }
    el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }
  function setConnection(state, label) {
    const dot = $('connectionDot');
    dot.classList.toggle('offline', state === 'offline');
    dot.classList.toggle('connecting', state === 'connecting');
    $('connectionStatus').textContent = label || state.toUpperCase();
    dot.title = label || state;
  }
  function escapeText(s) { return String(s == null ? '' : s); }
  function shortName(name) {
    const s = String(name || 'friend').replace(/[^A-Za-z0-9]+/g, ' ').trim();
    const parts = s.split(/\s+/).filter(Boolean);
    const candidate = parts.length > 1 ? parts.map(p => p[0]).join('') : (parts[0] || 'FRIEND');
    return candidate.toUpperCase().slice(0, 7) || 'FRIEND';
  }
  function isDm(key) { return typeof key === 'string' && key.startsWith('dm:'); }
  function partnerIdFromKey(key) { return key.slice(3); }
  function getDm(partnerId) { return dmByPartner.get(String(partnerId)) || null; }
  function getChannelConversation(key) {
    if (key === 'global') return channelConversations.get('global') || null;
    if (key === 'buddy') return channelConversations.get('buddy') || null;
    if (key === 'game') return gameConversations.get(currentGame) || null;
    if (isDm(key)) return getDm(partnerIdFromKey(key));
    return null;
  }
  function channelInfo(key) {
    if (CHANNELS[key]) return CHANNELS[key];
    if (isDm(key)) {
      const dm = getDm(partnerIdFromKey(key));
      if (!dm) return null;
      return { title: 'DM · ' + dm.username, label: shortName(dm.username), symbol: '♡', placeholder: 'whisper to ' + dm.username + '…', empty: 'your private conversation starts here ♡', dm };
    }
    return null;
  }
  function normalizeMessage(msg) {
    return { ...msg, id: String(msg.id), conversationId: String(msg.conversationId), senderId: msg.senderId == null ? null : String(msg.senderId), text: String(msg.text || '') };
  }
  function ensureMessageList(conversationId) {
    const id = String(conversationId);
    if (!messageCache.has(id)) messageCache.set(id, []);
    return messageCache.get(id);
  }
  function pushMessage(message) {
    const m = normalizeMessage(message);
    const list = ensureMessageList(m.conversationId);
    if (list.some(existing => String(existing.id) === m.id)) return false;
    list.push(m);
    if (list.length > 200) list.splice(0, list.length - 200);
    messageCache.delete(String(m.conversationId));
    messageCache.set(String(m.conversationId), list);
    persistHistory();
    return true;
  }
  async function ensureConversation(key) {
    let conversation = getChannelConversation(key);
    if (conversation) return conversation;
    if (key === 'game') {
      const data = await api('/api/games/' + encodeURIComponent(currentGame));
      conversation = { ...data, kind: 'game', key: 'game', gameSlug: currentGame, username: null };
      gameConversations.set(currentGame, conversation);
      return conversation;
    }
    return null;
  }
  async function joinConversation(conversationId) {
    if (!socket || !socket.connected || !conversationId) return;
    const id = String(conversationId);
    if (joining.has(id)) return;
    joining.add(id);
    socket.emit('conversation:join', { conversationId: id }, result => {
      joining.delete(id);
      if (result && !result.ok) console.warn('Conversation subscription failed:', result.error);
    });
  }
  async function refreshSubscriptions() {
    if (!socket || !socket.connected) return;
    for (const key of visible) {
      try {
        const conversation = await ensureConversation(key);
        if (conversation) await joinConversation(conversation.id);
      } catch (_) {}
    }
  }
  async function loadConversation(key, { force = false } = {}) {
    const conversation = await ensureConversation(key);
    if (!conversation) return null;
    if (!force && messageLoaded.has(String(conversation.id))) return conversation;
    const data = await api(`/api/conversations/${encodeURIComponent(conversation.id)}/messages`);
    const existing = ensureMessageList(conversation.id);
    const merged = new Map(existing.map(message => [String(message.id), normalizeMessage(message)]));
    for (const message of (data.messages || []).map(normalizeMessage)) merged.set(String(message.id), message);
    const combined = [...merged.values()].sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0)).slice(-200);
    messageCache.set(String(conversation.id), combined);
    persistHistory();
    messageLoaded.add(String(conversation.id));
    await joinConversation(conversation.id);
    return conversation;
  }
  function setGuest(user) {
    me = user;
    $('headerUser').textContent = user && user.username ? user.username : 'GUEST';
    $('headerUser').title = 'Guest identity for this browser. No account or password.';
    $('app').classList.remove('hidden');
  }
  async function enterApp(user) {
    setGuest(user);
    bootstrap = await api('/api/bootstrap');
    me = bootstrap.user;
    setGuest(me);
    try { localStorage.setItem(GUEST_NAME_KEY, me.username); } catch (_) {}
    channelConversations.set('global', { id: String(bootstrap.globalConversationId), kind: 'global', key: 'global' });
    channelConversations.set('buddy', { id: String(bootstrap.buddyConversationId), kind: 'buddy', key: 'buddy' });
    // Merge server-known DMs with browser-local shortcuts, so an idle/restarted free instance
    // does not make the tabs vanish. The server will reconstruct the room from its guest IDs.
    const byPartner = new Map(dmList.map(dm => [String(dm.partnerId), { ...dm }]));
    for (const dm of (bootstrap.dms || [])) byPartner.set(String(dm.partnerId), { ...dm });
    dmList = [...byPartner.values()].slice(0, 100);
    dmByPartner = new Map(dmList.map(dm => [String(dm.partnerId), { id: String(dm.id), kind: 'dm', key: 'dm:' + dm.partnerId, partnerId: String(dm.partnerId), username: dm.username }]));
    persistDmList();
    const qGame = new URLSearchParams(location.search).get('game');
    currentGame = bootstrap.games.some(g => g.slug === qGame) ? qGame : 'island-of-nurn';
    $('gameSelect').value = currentGame;
    $('app').classList.remove('hidden');
    active = 'global'; visible = new Set(['global', 'game', 'buddy']);
    connectSocket();
    render();
    try { await loadConversation('global', { force: true }); render(); } catch (error) { showToast(error.message); }
    ensureConversation('game').then(() => refreshSubscriptions()).catch(() => {});
  }
  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ withCredentials: true, transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 800, reconnectionDelayMax: 8000 });
    socket.on('connect', () => {
      setConnection('online', 'ONLINE');
      refreshSubscriptions();
    });
    socket.on('disconnect', () => { joining.clear(); setConnection('offline', 'RECONNECTING'); });
    socket.on('connect_error', error => {
      setConnection('offline', 'OFFLINE');
      if (error && /guest identity/i.test(error.message || '')) showToast('GUEST SESSION NEEDS REFRESH · RELOAD THIS PAGE');
    });
    socket.on('dm:updated', payload => {
      refreshDmListSilently().then(() => {
        const name = payload && payload.username ? payload.username : 'a guest';
        showToast('PRIVATE CHAT · ' + name);
        renderTabs();
      });
    });
    socket.on('message:new', message => {
      const added = pushMessage(message);
      if (!added) return;
      const activeConversation = getChannelConversation(active);
      if (activeConversation && String(activeConversation.id) === String(message.conversationId)) renderMessages();
      else {
        const id = String(message.conversationId);
        unreadByConversation.set(id, (unreadByConversation.get(id) || 0) + 1);
        const isBuddy = active === 'buddy' && String(channelConversations.get('buddy')?.id) === id;
        if (!isBuddy) showToast('NEW MESSAGE · ' + (message.username || 'ORPHIC REALMS'));
        renderTabs();
      }
      if (message.role !== 'assistant') refreshDmListSilently();
    });
    socket.on('call:incoming', incomingCall);
    socket.on('call:accepted', acceptedCall);
    socket.on('call:signal', handleCallSignal);
    socket.on('call:ended', data => {
      if (!callState || String(data.callId) !== String(callState.callId)) return;
      const reason = data.reason;
      finishCallLocal(false);
      showToast(reason === 'no-answer' ? 'NO ANSWER' : reason === 'declined' ? 'CALL DECLINED' : 'CALL ENDED');
    });
  }
  async function refreshDmListSilently() {
    try {
      const result = await api('/api/dms');
      const merged = new Map(dmList.map(dm => [String(dm.partnerId), { ...dm }]));
      for (const dm of (result.dms || [])) merged.set(String(dm.partnerId), { ...dm });
      dmList = [...merged.values()].slice(0, 100);
      dmByPartner = new Map(dmList.map(dm => [String(dm.partnerId), { id: String(dm.id), kind: 'dm', key: 'dm:' + dm.partnerId, partnerId: String(dm.partnerId), username: dm.username }]));
      persistDmList();
      renderTabs();
    } catch (_) {}
  }
  function makeTab(key) {
    const info = channelInfo(key);
    if (!info) return null;
    const conversation = getChannelConversation(key);
    const unread = conversation ? (unreadByConversation.get(String(conversation.id)) || 0) : 0;
    const tab = document.createElement('div');
    tab.className = 'tab' + (key === active ? ' active' : '');
    tab.dataset.channel = key;
    const select = document.createElement('button'); select.type = 'button'; select.className = 'tab-select';
    select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(key === active)); select.setAttribute('aria-label', 'Switch to ' + info.title); select.title = info.title;
    const symbol = document.createElement('span'); symbol.className = 'tab-symbol'; symbol.textContent = info.symbol;
    const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = info.label + (unread ? ` ·${unread > 9 ? '9+' : unread}` : '');
    select.append(symbol, label); select.addEventListener('click', () => setActive(key));
    const close = document.createElement('button'); close.type = 'button'; close.className = 'tab-close'; close.textContent = '×'; close.title = 'Close tab (history is kept)'; close.setAttribute('aria-label', 'Close ' + info.title + ' tab');
    close.addEventListener('click', event => { event.stopPropagation(); closeChannel(key); });
    tab.append(select, close); return tab;
  }
  function renderTabs() {
    const tabs = $('channelTabs'); tabs.textContent = '';
    for (const key of visible) { const tab = makeTab(key); if (tab) tabs.appendChild(tab); }
    renderMenu();
  }
  function addMenuHeading(menu, label) { const h = document.createElement('div'); h.className = 'menu-heading'; h.textContent = label; menu.appendChild(h); }
  function addMenuOption(menu, symbol, label, action, title) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'menu-option'; button.setAttribute('role', 'menuitem'); button.title = title || label;
    const s = document.createElement('span'); s.className = 'menu-symbol'; s.textContent = symbol;
    const l = document.createElement('span'); l.textContent = label; button.append(s, l); button.addEventListener('click', action); menu.appendChild(button);
  }
  function renderMenu() {
    const menu = $('channelMenu'); menu.textContent = '';
    const baseKeys = ['global', 'game', 'buddy'];
    const closedBase = baseKeys.filter(key => !visible.has(key));
    const closedDms = dmList.filter(dm => !visible.has('dm:' + dm.partnerId));
    if (closedBase.length) {
      addMenuHeading(menu, 'OPEN CHANNEL');
      closedBase.forEach(key => addMenuOption(menu, CHANNELS[key].symbol, CHANNELS[key].label, () => { closeMenu(); visible.add(key); setActive(key); }, CHANNELS[key].title));
    }
    if (closedDms.length) {
      if (menu.childElementCount) menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-divider' }));
      addMenuHeading(menu, 'PRIVATE CHATS');
      closedDms.forEach(dm => addMenuOption(menu, '♡', shortName(dm.username) + ' · ' + dm.username, () => {
        closeMenu(); const key = 'dm:' + dm.partnerId; visible.add(key); setActive(key);
      }, 'Open private chat with ' + dm.username));
    }
    if (menu.childElementCount) menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-divider' }));
    addMenuOption(menu, '+', 'NEW PRIVATE CHAT…', () => { closeMenu(); openNewDm(); }, 'Start a DM with an online guest');
    addMenuOption(menu, '⚙', 'OPTIONS / SETTINGS', () => { closeMenu(); openSettings(); }, 'Open settings');
  }
  function closeMenu() { $('channelMenu').classList.add('hidden'); $('addChannelBtn').setAttribute('aria-expanded', 'false'); }
  async function setActive(key) {
    if (!channelInfo(key) && !CHANNELS[key]) return;
    visible.add(key); active = key;
    const conversation = getChannelConversation(key);
    if (conversation) unreadByConversation.delete(String(conversation.id));
    render();
    try { await loadConversation(key, { force: true }); }
    catch (error) { showToast(error.message); }
    render(); refreshSubscriptions();
    if (!$('messageInput').disabled) $('messageInput').focus({ preventScroll: true });
  }
  function closeChannel(key) {
    if (!visible.has(key)) return;
    const old = [...visible]; visible.delete(key);
    const conversation = getChannelConversation(key);
    if (conversation && socket && socket.connected) socket.emit('conversation:leave', { conversationId: String(conversation.id) });
    if (active === key) {
      const idx = old.indexOf(key);
      active = old.slice(idx + 1).find(k => visible.has(k)) || old.slice(0, idx).reverse().find(k => visible.has(k)) || null;
    }
    closeMenu(); render();
    if (active) setActive(active);
  }
  function openOverlay(id) {
    $(id).classList.remove('hidden');
    const input = $(id).querySelector('input:not([type=checkbox])');
    if (input) setTimeout(() => input.focus({ preventScroll: true }), 25);
  }
  function closeOverlay(id) {
    if (id === 'callOverlay') { endCall(); return; }
    $(id).classList.add('hidden');
  }
  function openSettings() {
    $('displayName').value = me && me.username ? me.username : (localStorage.getItem(GUEST_NAME_KEY) || '');
    $('buddyEndpoint').value = prefs.endpoint || 'https://api.openai.com/v1/chat/completions';
    $('buddyModel').value = prefs.model || '';
    $('buddyKey').value = buddyApiKey;
    $('showTimestamps').checked = prefs.showTimestamps !== false;
    openOverlay('settingsOverlay');
  }
  async function openNewDm() {
    $('dmError').textContent = '';
    $('newDmName').innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = 'Loading online players…';
    $('newDmName').appendChild(placeholder);
    openOverlay('newDmOverlay');
    await loadPlayers();
  }
  async function loadPlayers() {
    const select = $('newDmName');
    const prior = select.value;
    select.innerHTML = '';
    const loading = document.createElement('option'); loading.value = ''; loading.textContent = 'Looking for online guests…'; select.appendChild(loading);
    $('refreshPlayersBtn').disabled = true;
    try {
      const result = await api('/api/players');
      select.innerHTML = '';
      if (!result.players || !result.players.length) {
        const none = document.createElement('option'); none.value = ''; none.textContent = 'Nobody else is online yet'; select.appendChild(none); select.disabled = true;
      } else {
        select.disabled = false;
        const prompt = document.createElement('option'); prompt.value = ''; prompt.textContent = 'Choose a player…'; select.appendChild(prompt);
        for (const player of result.players) {
          const option = document.createElement('option'); option.value = player.id; option.textContent = player.username; select.appendChild(option);
        }
        if (prior && result.players.some(player => String(player.id) === prior)) select.value = prior;
      }
    } catch (error) {
      select.innerHTML = '';
      const failed = document.createElement('option'); failed.value = ''; failed.textContent = 'Could not load players · refresh'; select.appendChild(failed); select.disabled = true;
      $('dmError').textContent = error.message;
    } finally { $('refreshPlayersBtn').disabled = false; }
  }
  function render() {
    renderTabs();
    const info = active ? channelInfo(active) : null;
    $('roomIcon').textContent = info ? info.symbol : '✿';
    $('roomTitle').textContent = info ? info.title : 'NO CHANNEL OPEN';
    $('gameSelect').classList.toggle('hidden', active !== 'game');
    $('callTools').classList.toggle('hidden', !isDm(active));
    $('messageInput').placeholder = info ? info.placeholder : 'open a channel with +';
    $('messageInput').disabled = !info;
    $('sendBtn').disabled = !info;
    renderMessages();
  }
  function renderMessages() {
    const pane = $('messages'); pane.textContent = '';
    const info = active ? channelInfo(active) : null;
    const conversation = active ? getChannelConversation(active) : null;
    if (!info) {
      const hint = document.createElement('div'); hint.className = 'empty-hint'; hint.textContent = 'all quiet here ♡  use + to open a channel'; pane.appendChild(hint); return;
    }
    if (!conversation) {
      const hint = document.createElement('div'); hint.className = 'empty-hint'; hint.textContent = 'opening this little room…'; pane.appendChild(hint); return;
    }
    const list = ensureMessageList(conversation.id);
    if (!list.length) {
      const hint = document.createElement('div'); hint.className = 'empty-hint';
      hint.textContent = (active === 'buddy' && !buddyApiKey) ? 'open ⚙ options to connect your personal API Buddy ♡' : info.empty;
      pane.appendChild(hint);
    }
    for (const m of list) {
      const row = document.createElement('div'); row.className = 'msg' + (String(m.senderId) === String(me && me.id) ? ' mine' : '');
      const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = m.role === 'assistant' ? '☼' : (String(m.username || '✿').slice(0, 1).toUpperCase());
      const body = document.createElement('div'); body.className = 'msgbody';
      const meta = document.createElement('div'); meta.className = 'msgmeta';
      const name = document.createElement('span'); name.textContent = (m.role === 'assistant' ? 'API Buddy' : (m.username || 'Former user')); meta.append(name);
      if (prefs.showTimestamps && m.time) { const time = document.createElement('span'); time.textContent = m.time; meta.append(time); }
      const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = m.text;
      body.append(meta, bubble); row.append(avatar, body); pane.appendChild(row);
    }
    pane.scrollTop = pane.scrollHeight;
  }
  function renderCallUI() {
    if (!callState) return;
    $('callTitle').textContent = (callState.mode === 'video' ? 'VIDEO CALL' : 'VOICE CALL') + ' · ' + (callState.incoming && !callState.accepted ? 'INCOMING' : 'ORPHIC');
    $('callContact').textContent = callState.peerUsername || 'Friend';
    $('remoteNameplate').textContent = callState.peerUsername || 'FRIEND';
    $('videoStage').classList.toggle('hidden', callState.mode !== 'video');
    $('audioCard').classList.toggle('hidden', callState.mode === 'video');
    $('callCamToggle').classList.toggle('hidden', callState.mode !== 'video');
    $('incomingActions').classList.toggle('hidden', !(callState.incoming && !callState.accepted));
    $('activeCallControls').classList.toggle('hidden', callState.incoming && !callState.accepted);
    $('callStatus').textContent = callState.status || 'CONNECTING…';
    $('videoStageStatus').textContent = callState.status || 'CONNECTING…';
    $('stageLive').textContent = callState.pc && callState.pc.connectionState === 'connected' ? 'LIVE' : 'CONNECTING';
  }
  function getCallId() { return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `${Date.now()}-${++callSerial}-${Math.random().toString(36).slice(2)}`; }
  async function getUserMediaForMode(mode) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Camera/microphone access needs a modern browser on HTTPS or localhost.');
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false });
    } catch (error) {
      if (error.name === 'NotAllowedError') throw new Error('Permission denied. Allow the microphone' + (mode === 'video' ? ' and camera' : '') + ' in your browser, then try again.');
      if (error.name === 'NotFoundError') throw new Error('No compatible microphone' + (mode === 'video' ? ' or camera' : '') + ' was found.');
      if (error.name === 'NotReadableError') throw new Error('Your microphone or camera may already be in use by another app.');
      throw new Error('Could not access the microphone/camera. Check browser permissions and try again.');
    }
  }
  async function makePeerConnection(state) {
    const config = await api('/api/rtc-config');
    if (callState !== state) throw new Error('Call has ended.');
    const pc = new RTCPeerConnection({ iceServers: config.iceServers || [] });
    state.pc = pc;
    for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
    pc.onicecandidate = event => {
      if (event.candidate && callState === state && socket && socket.connected) {
        socket.emit('call:signal', { callId: state.callId, type: 'candidate', data: event.candidate.toJSON() });
      }
    };
    pc.ontrack = event => {
      if (callState !== state) return;
      const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      if (state.mode === 'video') {
        $('remoteVideo').srcObject = stream;
        $('videoStage').classList.add('remote-connected');
        $('placeholderTitle').textContent = 'CONNECTED';
        $('placeholderMessage').textContent = 'Your conversation is live.';
        $('remoteVideo').play().catch(() => {});
      } else {
        $('remoteAudio').srcObject = stream;
        $('remoteAudio').play().catch(() => {});
      }
      state.status = 'CONNECTED'; renderCallUI();
    };
    pc.onconnectionstatechange = () => {
      if (callState !== state) return;
      if (pc.connectionState === 'connected') state.status = 'CONNECTED';
      else if (pc.connectionState === 'connecting') state.status = 'CONNECTING…';
      else if (pc.connectionState === 'disconnected') state.status = 'CONNECTION INTERRUPTED';
      else if (pc.connectionState === 'failed') state.status = 'CONNECTION FAILED · TRY AGAIN';
      renderCallUI();
    };
    pc.oniceconnectionstatechange = () => {
      if (callState === state && pc.iceConnectionState === 'failed') showToast('CALL NETWORK FAILED · A TURN RELAY MAY BE NEEDED');
    };
    state.pendingCandidates = state.pendingCandidates || [];
    return pc;
  }
  function openCallWindow(state) {
    callState = state;
    $('remoteVideo').srcObject = null; $('localVideo').srcObject = null; $('remoteAudio').srcObject = null;
    $('videoStage').classList.remove('remote-connected'); $('videoStage').classList.add('camera-off');
    $('callMicToggle').classList.remove('toggled'); $('callCamToggle').classList.remove('toggled');
    $('callMicToggle').setAttribute('aria-pressed', 'false'); $('callCamToggle').setAttribute('aria-pressed', 'false');
    $('micLabel').textContent = 'MIC OFF'; $('camLabel').textContent = 'CAM OFF';
    $('placeholderArt').textContent = '♡'; $('placeholderTitle').textContent = state.incoming ? 'INCOMING CALL' : 'CALLING…';
    $('placeholderMessage').textContent = state.incoming ? 'Accept to connect your microphone' + (state.mode === 'video' ? ' and camera.' : '.') : 'Waiting for the other person to answer.';
    $('callNote').textContent = 'Your microphone/camera will only activate after you start or accept a call.';
    openOverlay('callOverlay'); renderCallUI();
  }
  async function startCall(mode) {
    if (!socket || !socket.connected) { showToast('CHAT SERVER IS OFFLINE · PLEASE WAIT'); return; }
    if (!isDm(active)) { showToast('OPEN A PRIVATE CHAT FIRST'); return; }
    if (callState) { showToast('FINISH THE CURRENT CALL FIRST'); return; }
    const dm = getDm(partnerIdFromKey(active));
    const conversation = getChannelConversation(active);
    if (!dm || !conversation) { showToast('PRIVATE CHAT IS STILL OPENING'); return; }
    const state = { callId: getCallId(), conversationId: String(conversation.id), peerUserId: String(dm.partnerId), peerUsername: dm.username, mode, incoming: false, accepted: false, localStream: null, pc: null, pendingCandidates: [], invited: false, status: 'CALLING…', muted: false, cameraOff: false };
    openCallWindow(state);
    socket.emit('call:invite', { callId: state.callId, conversationId: state.conversationId, toUserId: state.peerUserId, mode }, async result => {
      if (callState !== state) return;
      if (!result || !result.ok) { showToast(result?.error || 'Could not start this call.'); finishCallLocal(false); return; }
      state.invited = true;
      if (!state.accepted) {
        state.status = 'RINGING…';
        $('callNote').textContent = 'Ringing ' + state.peerUsername + '… your devices are still off until they answer.';
        renderCallUI();
      }
    });
  }
  function incomingCall(payload) {
    if (callState) {
      socket.emit('call:decline', { callId: payload.callId });
      return;
    }
    const userId = String(payload.fromUserId);
    let dm = getDm(userId);
    if (!dm) {
      // The caller must already have a DM relationship. Retrieve it through the normal API list if needed.
      refreshDmListSilently().then(() => {
        const updated = getDm(userId);
        if (!updated) { socket.emit('call:decline', { callId: payload.callId }); return; }
        acceptIncomingCallSetup(payload, updated);
      });
      return;
    }
    acceptIncomingCallSetup(payload, dm);
  }
  function acceptIncomingCallSetup(payload, dm) {
    if (callState) { socket.emit('call:decline', { callId: payload.callId }); return; }
    const state = { callId: String(payload.callId), conversationId: String(payload.conversationId), peerUserId: String(payload.fromUserId), peerUsername: payload.fromUsername || dm.username, mode: payload.mode === 'video' ? 'video' : 'audio', incoming: true, accepted: false, localStream: null, pc: null, pendingCandidates: [], invited: true, status: 'INCOMING CALL', muted: false, cameraOff: false };
    callState = state;
    const dmKey = 'dm:' + state.peerUserId;
    visible.add(dmKey); active = dmKey;
    render();
    loadConversation(dmKey, { force: true }).catch(() => {});
    openCallWindow(state);
    $('callNote').textContent = state.peerUsername + ' is calling. Accept to enable your microphone' + (state.mode === 'video' ? ' and camera.' : '.') + ' You can decline at any time.';
    renderCallUI();
  }
  async function acceptCall() {
    const state = callState;
    if (!state || !state.incoming || state.accepted) return;
    $('acceptCallBtn').disabled = true;
    state.status = 'REQUESTING DEVICE PERMISSION…'; renderCallUI();
    try {
      state.localStream = await getUserMediaForMode(state.mode);
      if (callState !== state) { stopStream(state.localStream); return; }
      if (state.mode === 'video') $('localVideo').srcObject = state.localStream;
      state.accepted = true;
      await makePeerConnection(state);
      socket.emit('call:accept', { callId: state.callId }, result => {
        if (callState !== state) return;
        if (!result || !result.ok) { showToast(result?.error || 'Call invitation expired.'); finishCallLocal(false); return; }
        state.status = 'CONNECTING…';
        $('callNote').textContent = 'Call accepted. Connecting your devices…';
        updateCallControlLabels(); renderCallUI();
      });
    } catch (error) {
      state.status = 'DEVICE ACCESS FAILED'; $('callNote').textContent = error.message; renderCallUI(); showToast(error.message);
      socket.emit('call:decline', { callId: state.callId });
      setTimeout(() => { if (callState === state) finishCallLocal(false); }, 900);
    } finally { $('acceptCallBtn').disabled = false; }
  }
  async function acceptedCall(payload) {
    const state = callState;
    if (!state || state.incoming || String(payload.callId) !== String(state.callId)) return;
    try {
      state.accepted = true; state.status = 'REQUESTING DEVICE PERMISSION…'; renderCallUI();
      state.localStream = await getUserMediaForMode(state.mode);
      if (callState !== state) { stopStream(state.localStream); return; }
      if (state.mode === 'video') $('localVideo').srcObject = state.localStream;
      await makePeerConnection(state);
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      if (!socket || !socket.connected) throw new Error('Connection to the call server was lost.');
      socket.emit('call:signal', { callId: state.callId, type: 'offer', data: state.pc.localDescription });
      state.status = 'CONNECTING…'; $('callNote').textContent = 'Connecting directly to ' + state.peerUsername + '…';
      updateCallControlLabels(); renderCallUI();
    } catch (error) {
      showToast(error.message || 'Could not connect the call.');
      finishCallLocal(true);
    }
  }
  async function handleCallSignal(payload) {
    const state = callState;
    if (!state || String(payload.callId) !== String(state.callId)) return;
    try {
      if (!state.pc) {
        if (!state.localStream) return;
        await makePeerConnection(state);
      }
      if (payload.type === 'offer') {
        await state.pc.setRemoteDescription(new RTCSessionDescription(payload.data));
        for (const candidate of state.pendingCandidates.splice(0)) await state.pc.addIceCandidate(new RTCIceCandidate(candidate));
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);
        socket.emit('call:signal', { callId: state.callId, type: 'answer', data: state.pc.localDescription });
      } else if (payload.type === 'answer') {
        await state.pc.setRemoteDescription(new RTCSessionDescription(payload.data));
        for (const candidate of state.pendingCandidates.splice(0)) await state.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else if (payload.type === 'candidate' && payload.data) {
        const candidate = new RTCIceCandidate(payload.data);
        if (state.pc.remoteDescription && state.pc.remoteDescription.type) await state.pc.addIceCandidate(candidate);
        else state.pendingCandidates.push(payload.data);
      }
    } catch (error) {
      console.warn('Call negotiation error:', error.message);
      if (state.pc && state.pc.connectionState === 'failed') showToast('CALL CONNECTION FAILED · A TURN RELAY MAY BE NEEDED');
    }
  }
  function updateCallControlLabels() {
    const state = callState;
    if (!state || !state.localStream) return;
    const micTrack = state.localStream.getAudioTracks()[0];
    const videoTrack = state.localStream.getVideoTracks()[0];
    const micOn = Boolean(micTrack && micTrack.enabled);
    const camOn = Boolean(videoTrack && videoTrack.enabled);
    $('callMicToggle').classList.toggle('toggled', micOn);
    $('callMicToggle').setAttribute('aria-pressed', String(micOn));
    $('micLabel').textContent = micOn ? 'MIC ON' : 'MIC MUTED';
    $('callCamToggle').classList.toggle('toggled', camOn);
    $('callCamToggle').setAttribute('aria-pressed', String(camOn));
    $('camLabel').textContent = camOn ? 'CAM ON' : 'CAM OFF';
    $('videoStage').classList.toggle('camera-off', !camOn);
  }
  function toggleCallMic() {
    if (!callState || !callState.localStream) return;
    const track = callState.localStream.getAudioTracks()[0];
    if (!track) return showToast('NO MICROPHONE TRACK');
    track.enabled = !track.enabled; updateCallControlLabels();
  }
  function toggleCallCamera() {
    if (!callState || !callState.localStream) return;
    const track = callState.localStream.getVideoTracks()[0];
    if (!track) return showToast('NO CAMERA TRACK');
    track.enabled = !track.enabled; updateCallControlLabels();
  }
  function stopStream(stream) { if (stream) for (const track of stream.getTracks()) { try { track.stop(); } catch (_) {} } }
  function finishCallLocal(notifyRemote) {
    const state = callState;
    if (!state) { $('callOverlay').classList.add('hidden'); return; }
    callState = null;
    if (notifyRemote && state.invited && socket && socket.connected) socket.emit('call:end', { callId: state.callId });
    if (state.pc) { try { state.pc.ontrack = null; state.pc.onicecandidate = null; state.pc.close(); } catch (_) {} }
    stopStream(state.localStream);
    $('localVideo').srcObject = null; $('remoteVideo').srcObject = null; $('remoteAudio').srcObject = null;
    $('callOverlay').classList.add('hidden');
  }
  function endCall() { finishCallLocal(true); }
  function declineCall() {
    if (!callState) return;
    if (socket && socket.connected) socket.emit('call:decline', { callId: callState.callId });
    finishCallLocal(false);
  }

  $('addChannelBtn').addEventListener('click', () => {
    const menu = $('channelMenu'); const willOpen = menu.classList.contains('hidden'); menu.classList.toggle('hidden', !willOpen);
    $('addChannelBtn').setAttribute('aria-expanded', String(willOpen)); renderMenu();
  });
  document.addEventListener('click', event => { if (!$('channelMenu').contains(event.target) && event.target !== $('addChannelBtn')) closeMenu(); });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeOverlay(button.dataset.close)));
  document.querySelectorAll('.overlay').forEach(overlay => overlay.addEventListener('click', event => { if (event.target === overlay) closeOverlay(overlay.id); }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { ['settingsOverlay', 'newDmOverlay', 'callOverlay'].forEach(closeOverlay); closeMenu(); } });
  $('gameSelect').addEventListener('change', async () => {
    const old = gameConversations.get(currentGame);
    currentGame = $('gameSelect').value;
    if (old && socket && socket.connected) socket.emit('conversation:leave', { conversationId: String(old.id) });
    if (active === 'game') { try { await setActive('game'); } catch (_) {} }
    else refreshSubscriptions();
  });
  $('settingsBtn').addEventListener('click', openSettings);
  $('saveSettingsBtn').addEventListener('click', async () => {
    prefs.endpoint = $('buddyEndpoint').value.trim() || 'https://api.openai.com/v1/chat/completions';
    prefs.model = $('buddyModel').value.trim();
    prefs.showTimestamps = $('showTimestamps').checked;
    buddyApiKey = $('buddyKey').value.trim();
    const requestedName = $('displayName').value.trim();
    if (requestedName && me && requestedName !== me.username) {
      try {
        const result = await api('/api/guest/profile', { method: 'POST', body: JSON.stringify({ username: requestedName }) });
        me = result.user; setGuest(me); localStorage.setItem(GUEST_NAME_KEY, me.username);
        await refreshDmListSilently();
      } catch (error) { showToast(error.message); return; }
    }
    savePrefs(); closeOverlay('settingsOverlay'); render();
    showToast(buddyApiKey ? 'OPTIONS SAVED · BUDDY KEY HELD IN THIS PAGE' : 'OPTIONS SAVED');
  });
  $('refreshPlayersBtn').addEventListener('click', loadPlayers);
  $('newDmForm').addEventListener('submit', async event => {
    event.preventDefault();
    const partnerId = $('newDmName').value.trim(); if (!partnerId) return;
    $('dmError').textContent = '';
    const submit = $('newDmForm').querySelector('button[type=submit]'); submit.disabled = true;
    try {
      const data = await api('/api/dms', { method: 'POST', body: JSON.stringify({ partnerId }) });
      const c = data.conversation;
      const dm = { id: String(c.id), kind: 'dm', key: 'dm:' + c.partnerId, partnerId: String(c.partnerId), username: c.username };
      dmByPartner.set(dm.partnerId, dm);
      dmList = [dm, ...dmList.filter(item => String(item.partnerId) !== dm.partnerId)].slice(0, 100);
      persistDmList();
      closeOverlay('newDmOverlay'); visible.add(dm.key); setActive(dm.key); showToast('PRIVATE CHAT READY');
    } catch (error) { $('dmError').textContent = error.message; }
    finally { submit.disabled = false; }
  });
  $('audioCallBtn').addEventListener('click', () => startCall('audio'));
  $('videoCallBtn').addEventListener('click', () => startCall('video'));
  $('acceptCallBtn').addEventListener('click', acceptCall);
  $('declineCallBtn').addEventListener('click', declineCall);
  $('callMicToggle').addEventListener('click', toggleCallMic);
  $('callCamToggle').addEventListener('click', toggleCallCamera);
  $('endCallPreviewBtn').addEventListener('click', endCall);
  $('composer').addEventListener('submit', async event => {
    event.preventDefault();
    const text = $('messageInput').value.trim();
    if (!text || !active) return;
    const conversation = getChannelConversation(active);
    if (!conversation) { showToast('THIS CHANNEL IS STILL OPENING'); return; }
    $('sendBtn').disabled = true;
    try {
      if (active === 'buddy') {
        if (!buddyApiKey || !prefs.model) { openSettings(); showToast('ADD YOUR API KEY AND MODEL IN OPTIONS'); return; }
        const result = await api('/api/buddy/chat', { method: 'POST', body: JSON.stringify({ conversationId: String(conversation.id), text, apiKey: buddyApiKey, endpoint: prefs.endpoint, model: prefs.model }) });
        result.messages.forEach(pushMessage);
        messageLoaded.add(String(conversation.id));
        $('messageInput').value = ''; renderMessages();
      } else {
        if (!socket || !socket.connected) throw new Error('Chat is offline. Wait for it to reconnect, then try again.');
        const result = await new Promise((resolve, reject) => socket.emit('message:send', { conversationId: String(conversation.id), text }, result => {
          if (!result || !result.ok) reject(new Error(result?.error || 'Message did not send.'));
          else resolve(result);
        }));
        if (result.message) { pushMessage(result.message); renderMessages(); }
        $('messageInput').value = '';
      }
    } catch (error) { showToast(error.message); }
    finally { $('sendBtn').disabled = !active; }
  });
  $('messageInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('composer').requestSubmit(); } });
  $('popoutBtn').addEventListener('click', () => {
    try {
      const url = new URL(location.href); url.searchParams.set('window', 'popup'); url.searchParams.set('game', currentGame);
      const win = window.open(url.toString(), 'orphicCommunicator', 'popup=yes,width=350,height=500,resizable=yes,scrollbars=no,toolbar=no,location=no,menubar=no,status=no');
      if (win) win.focus(); else showToast('POPUP BLOCKED · ALLOW POPUPS FOR THIS SITE');
    } catch (_) { showToast('COULD NOT OPEN POPUP HERE'); }
  });
  window.addEventListener('beforeunload', () => { if (callState) finishCallLocal(true); });

  // Initial boot: create/reconnect an anonymous guest. No registration, password, or account.
  loadPrefs();
  loadLocalState();
  $('buddyEndpoint').value = prefs.endpoint;
  $('buddyModel').value = prefs.model;
  $('showTimestamps').checked = prefs.showTimestamps;
  if (popupMode) { document.title = 'Orphic Communicator'; $('popoutBtn').title = 'Open another communicator window'; }
  (async () => {
    setConnection('connecting', 'CONNECTING');
    try {
      let preferredName = '';
      try { preferredName = localStorage.getItem(GUEST_NAME_KEY) || ''; } catch (_) {}
      const result = await api('/api/guest', { method: 'POST', body: JSON.stringify({ username: preferredName }) });
      let previousGuestId = '';
      try { previousGuestId = localStorage.getItem(GUEST_ID_KEY) || ''; } catch (_) {}
      if (previousGuestId && previousGuestId !== result.user.id) {
        // Cookie was cleared/rotated: don't expose the previous guest's DM or Buddy cache to this new guest.
        dmList = []; dmByPartner.clear();
        for (const key of [...messageCache.keys()]) if (key.startsWith('dm:') || key.startsWith('buddy:')) messageCache.delete(key);
        persistDmList(); persistHistory();
      }
      try { localStorage.setItem(GUEST_ID_KEY, result.user.id); } catch (_) {}
      await enterApp(result.user);
    } catch (error) {
      setConnection('offline', 'OFFLINE');
      showToast(error.message || 'Could not start the guest session. Reload to try again.');
    }
  })();
})();
