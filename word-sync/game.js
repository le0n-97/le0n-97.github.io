'use strict';

const API_ORIGIN = 'https://squares-duel-oct15.not-n0el.chatgpt.site';
const ACCOUNT_KEY = 'squares-duel-account';
const ACCOUNT_TOKEN = /^sq_account_[0-9a-f]{64}$/;
const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const POLL_INTERVAL = 1250;

const $ = id => document.getElementById(id);
const query = new URLSearchParams(window.location.search);
const inviteEntry = query.has('room');
let account = null;
let accountGeneration = 0;
let authBusy = true;
let accountChecked = false;
let authMode = 'login';
let accountError = '';
let canRetryAccount = false;
let room = null;
let roomRevision = -1;
let roomGeneration = 0;
let roomBusy = false;
let stageKey = '';
let roomCodeToRestore = (query.get('room') ?? '').trim().toUpperCase();
let pollingTimer;
let toastTimer;

function hide(id, hidden) {
  $(id).classList.toggle('hidden', hidden);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4000);
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { token, body, simple = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = simple ? 'text/plain;charset=UTF-8' : 'application/json';
  let response;
  try {
    response = await fetch(API_ORIGIN + path, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(12000)
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('服务器连接超时，请重试。');
    throw new Error('无法连接服务器，请检查网络后重试。');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error || '服务器暂时不可用，请稍后重试。');
  return data;
}

function readSavedAccount() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? 'null');
    if (ACCOUNT_TOKEN.test(saved?.token) &&
        typeof saved.user?.username === 'string' &&
        typeof saved.expiresAt === 'number') {
      return saved;
    }
  } catch { /* Login still works when browser storage is disabled. */ }
  return null;
}

function saveAccount(session, previousToken) {
  try {
    if (session) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(session));
    else if (readSavedAccount()?.token === previousToken) localStorage.removeItem(ACCOUNT_KEY);
  } catch { /* The tab can keep a valid session in memory. */ }
}

function renderAccount() {
  hide('authForm', !accountChecked || !!account);
  hide('lobbyControls', !account);
  hide('authRetry', !canRetryAccount || authBusy);
  $('accountName').textContent = account?.user.username ?? '';
  $('authStatus').textContent = accountError ||
    (authBusy ? '正在处理账号请求…' : account ? '' : '使用 Squares 双人对决账号登录。');
  hide('authStatus', !$('authStatus').textContent);
  $('authSubmit').disabled = authBusy;
  $('authMode').disabled = authBusy;
  $('username').disabled = authBusy;
  $('password').disabled = authBusy;
  $('confirmPassword').disabled = authBusy;
  renderControls();
}

function setAuthMode(mode) {
  authMode = mode;
  const register = mode === 'register';
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  $('password').value = '';
  $('confirmPassword').value = '';
  $('confirmPassword').required = register;
  hide('confirmRow', !register);
  $('authSubmit').textContent = register ? '注册并登录' : '登录';
  $('authMode').textContent = register ? '已有账号？返回登录' : '注册账号';
}

function authExpired(token) {
  if (account?.token !== token) return;
  accountGeneration++;
  saveAccount(null, token);
  account = null;
  accountError = '登录已失效，请重新登录。';
  authBusy = false;
  clearRoom(true);
  renderAccount();
}

async function restoreAccount() {
  const generation = ++accountGeneration;
  const saved = readSavedAccount();
  authBusy = true;
  accountError = '';
  canRetryAccount = false;
  if (account && account.token !== saved?.token) {
    account = null;
    clearRoom(true);
  }
  renderAccount();
  try {
    if (!saved) return;
    const { user, expiresAt } = await request('/api/account', { token: saved.token });
    if (generation !== accountGeneration) return;
    if (!user) {
      saveAccount(null, saved.token);
      return;
    }
    account = { user, token: saved.token, expiresAt: expiresAt ?? saved.expiresAt };
  } catch (error) {
    if (generation !== accountGeneration) return;
    if (error.status === 401) saveAccount(null, saved.token);
    else {
      accountError = error.message;
      canRetryAccount = true;
    }
  } finally {
    if (generation === accountGeneration) {
      authBusy = false;
      accountChecked = true;
      renderAccount();
      if (account) void restoreRoom();
    }
  }
}

$('authForm').onsubmit = async event => {
  event.preventDefault();
  if (authBusy || account) return;
  const username = $('username').value.trim();
  const password = $('password').value;
  if (authMode === 'register' && password !== $('confirmPassword').value) {
    accountError = '两次输入的密码不一致。';
    renderAccount();
    return;
  }
  const generation = ++accountGeneration;
  authBusy = true;
  canRetryAccount = false;
  accountError = '';
  renderAccount();
  try {
    const data = await request('/api/account', {
      body: { action: authMode, username, password },
      simple: true
    });
    if (generation !== accountGeneration) return;
    if (!ACCOUNT_TOKEN.test(data.token) ||
        typeof data.user?.username !== 'string' ||
        typeof data.expiresAt !== 'number') {
      throw new Error('账号服务返回的信息不完整，请重试。');
    }
    account = { user: data.user, token: data.token, expiresAt: data.expiresAt };
    saveAccount(account);
    setAuthMode('login');
  } catch (error) {
    if (generation === accountGeneration) accountError = error.message;
  } finally {
    if (generation === accountGeneration) {
      authBusy = false;
      renderAccount();
      if (account) void restoreRoom();
    }
  }
};

$('authMode').onclick = () => {
  accountError = '';
  setAuthMode(authMode === 'login' ? 'register' : 'login');
  renderAccount();
  $('username').focus();
};

$('authRetry').onclick = () => void restoreAccount();
$('logout').onclick = async () => {
  if (!account || authBusy || roomBusy) return;
  const token = account.token;
  const generation = ++accountGeneration;
  authBusy = true;
  accountError = '';
  renderAccount();
  try {
    await request('/api/account', { token, body: { action: 'logout' } });
    if (generation !== accountGeneration) return;
    saveAccount(null, token);
    account = null;
    toast('已退出 Squares 账号。');
  } catch (error) {
    if (generation === accountGeneration) accountError = error.message;
  } finally {
    if (generation === accountGeneration) {
      authBusy = false;
      renderAccount();
    }
  }
};

window.addEventListener('storage', event => {
  if (event.key !== ACCOUNT_KEY && event.key !== null) return;
  if (readSavedAccount()?.token !== account?.token || authBusy) void restoreAccount();
});

function renderControls() {
  $('create').disabled = roomBusy || authBusy;
  $('join').disabled = roomBusy || authBusy;
  $('logout').disabled = roomBusy || authBusy;
  $('leave').disabled = roomBusy || authBusy;
  const start = $('start');
  if (start) start.disabled = roomBusy || room.players.length < 2;
  const next = $('next');
  if (next) next.disabled = roomBusy || room.players.length < 2;
  const submit = $('submitWord');
  if (submit) submit.disabled = roomBusy;
}

function setRoomNotice(message = '') {
  $('roomNotice').textContent = message;
  hide('roomNotice', !message);
}

function setUrlRoom(code) {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  window.history.replaceState(null, '', url);
}

function clearRoom(preserveCode = false) {
  roomGeneration++;
  clearTimeout(pollingTimer);
  room = null;
  roomRevision = -1;
  roomBusy = false;
  stageKey = '';
  $('stage').innerHTML = '';
  setRoomNotice();
  if (!preserveCode) {
    roomCodeToRestore = '';
    if (!inviteEntry) setUrlRoom('');
  }
  hide('room', true);
  hide('home', false);
  renderControls();
}

function applyRoom(data) {
  if (!data.room || !Number.isSafeInteger(data.revision)) {
    throw new Error('房间状态无法读取，请重试。');
  }
  const isNew = data.room.code !== room?.code;
  if (!isNew && data.revision <= roomRevision) return;
  room = data.room;
  roomRevision = data.revision;
  if (isNew) {
    roomGeneration++;
    roomCodeToRestore = room.code;
    $('roomCode').value = room.code;
    $('codeLabel').textContent = room.code;
    setUrlRoom(room.code);
    hide('home', true);
    hide('room', false);
    schedulePoll();
  }
  renderRoom();
}

function schedulePoll() {
  clearTimeout(pollingTimer);
  if (room) pollingTimer = setTimeout(pollRoom, POLL_INTERVAL);
}

function readRoom(code, token) {
  return request('/api/word-sync?code=' + encodeURIComponent(code), { token });
}

async function pollRoom() {
  if (!room || !account) return;
  const generation = roomGeneration;
  const token = account.token;
  try {
    if (!roomBusy) {
      const data = await readRoom(room.code, token);
      if (generation === roomGeneration && account?.token === token && !roomBusy) {
        applyRoom(data);
        setRoomNotice();
      }
    }
  } catch (error) {
    if (generation !== roomGeneration || account?.token !== token || roomBusy) return;
    if (error.status === 401) authExpired(token);
    else if ([403, 404, 410].includes(error.status)) {
      clearRoom();
      toast(error.message);
    } else {
      setRoomNotice('暂时无法同步房间，正在重试…');
    }
  } finally {
    if (generation === roomGeneration) schedulePoll();
  }
}

async function restoreRoom() {
  if (room || roomBusy || !account || !ROOM_CODE.test(roomCodeToRestore)) return;
  const token = account.token;
  const generation = roomGeneration;
  roomBusy = true;
  renderControls();
  try {
    const data = await readRoom(roomCodeToRestore, token);
    if (generation === roomGeneration && account?.token === token) applyRoom(data);
  } catch (error) {
    if (generation !== roomGeneration || account?.token !== token) return;
    if (error.status === 401) authExpired(token);
    else if (![403, 404, 410].includes(error.status)) toast(error.message);
  } finally {
    if (account?.token === token) {
      roomBusy = false;
      renderControls();
    }
  }
}

async function changeRoom(action, extra = {}) {
  if (roomBusy || authBusy || !account) return;
  const token = account.token;
  const generation = roomGeneration;
  roomBusy = true;
  renderControls();
  try {
    const data = await request('/api/word-sync', {
      token,
      body: { action, ...(room ? { code: room.code } : {}), ...extra }
    });
    if (generation !== roomGeneration || account?.token !== token) return;
    if (action === 'leave') {
      clearRoom();
      toast('已离开房间。');
    } else {
      applyRoom(data);
      setRoomNotice();
    }
  } catch (error) {
    if (generation !== roomGeneration || account?.token !== token) return;
    if (error.status === 401) authExpired(token);
    else toast(error.message);
  } finally {
    if (account?.token === token) {
      roomBusy = false;
      renderControls();
    }
  }
}

function renderRoom() {
  const host = room.meId === room.hostId;
  const me = room.players.find(player => player.id === room.meId);
  $('playerCount').textContent = room.players.length;
  $('players').innerHTML = room.players.map(player => {
    const role = player.id === room.hostId ? '房主' : '';
    const progress = room.phase === 'playing' ? (player.submitted ? '已提交' : '思考中') : '';
    return '<div class="player"><span class="avatar">' + escapeHtml(player.name.slice(0, 1)) +
      '</span><span>' + escapeHtml(player.name) + (player.id === room.meId ? '（你）' : '') +
      '</span><span class="tag">' + [role, progress].filter(Boolean).join(' · ') + '</span></div>';
  }).join('');

  const showHostControls = host && (room.phase === 'lobby' || room.phase === 'revealed');
  const stageVersion = [room.phase, room.round, showHostControls, me?.submitted].join(':');
  // Keep the input in the DOM while other players submit, including during IME composition.
  if (stageKey !== stageVersion) {
    stageKey = stageVersion;
    renderStage(host, me?.submitted);
  }
  $('roundCount').textContent = String(room.history.length).padStart(2, '0');
  $('history').innerHTML = room.history.length ? [...room.history].reverse().map(result => {
    const answers = result.results.map(answer => '<div class="answer"><small>' + escapeHtml(answer.name) +
      '</small>' + escapeHtml(answer.word) + '</div>').join('');
    return '<article class="round"><div class="round-title">第 ' + result.round + ' 回合' +
      (result.win ? ' · 默契达成 ✳' : '') + '</div><div class="answers">' + answers + '</div></article>';
  }).join('') : '<div class="empty">还没有揭晓的答案。</div>';
  renderControls();
}

function renderStage(host, submitted) {
  const title = $('roomTitle');
  const status = $('status');
  const stage = $('stage');
  title.textContent = '第 ' + room.round + ' 回合';
  switch (room.phase) {
    case 'lobby':
      title.textContent = '等待朋友加入';
      status.textContent = '至少两位玩家加入后，房主可以开始游戏。';
      stage.innerHTML = '<h2>人到齐了吗？</h2><p>把邀请链接发给朋友。开局后，已加入的玩家可以用同一账号回来。</p>' +
        (host ? '<button class="primary" id="start" type="button">开始游戏 <span>↗</span></button>' : '<p>等待房主开始游戏…</p>');
      if (host) $('start').onclick = () => void changeRoom('start');
      break;
    case 'playing':
      status.textContent = '所有人提交后一起揭晓。';
      if (submitted) {
        stage.innerHTML = '<h2>答案已收好</h2><p>等待其他朋友提交。</p>';
      } else {
        stage.innerHTML = '<h2>此刻，你想到什么词？</h2><p>提交后本回合无法修改。</p>' +
          '<form id="answerForm" class="answer-row"><input id="answer" aria-label="你的词语" maxlength="30" placeholder="写一个词语…" autocomplete="off" required>' +
          '<button id="submitWord" class="primary" type="submit">提交答案 ↗</button></form>';
        $('answerForm').onsubmit = event => {
          event.preventDefault();
          const word = $('answer').value.trim();
          if (word) void changeRoom('submit', { word, round: room.round });
        };
      }
      break;
    case 'revealed':
      status.textContent = '答案已揭晓。';
      stage.innerHTML = '<h2>还差一点默契</h2><p>看看彼此的答案，再试一次吧。</p>' +
        (host ? '<button id="next" class="primary" type="button">开始下一回合 <span>↗</span></button>' : '<p>等待房主开始下一回合…</p>');
      if (host) $('next').onclick = () => void changeRoom('next', { round: room.round });
      break;
    case 'won':
      title.textContent = '心有灵犀！';
      status.textContent = '你们写下了同一个词。';
      stage.innerHTML = '<h2>你们想到一起去了！</h2><p>游戏完成，可以在下面回顾每轮的回答。</p>';
      break;
  }
}

$('create').onclick = () => {
  if (!inviteEntry) void changeRoom('create');
};
$('joinForm').onsubmit = event => {
  event.preventDefault();
  const code = $('roomCode').value.trim().toUpperCase();
  if (ROOM_CODE.test(code)) void changeRoom('join', { code });
  else toast('请输入 6 位房间码。');
};
$('leave').onclick = () => void changeRoom('leave');
$('copy').onclick = async () => {
  if (!room) return;
  const code = room.code;
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  try {
    await navigator.clipboard.writeText(url.toString());
    toast('邀请链接已复制。');
  } catch {
    toast('请把房间码 ' + code + ' 发给朋友。');
  }
};

if (inviteEntry) {
  hide('create', true);
  hide('joinDivider', true);
  $('entryTitle').textContent = '加入朋友的房间';
  $('roomCode').value = roomCodeToRestore;
}
void restoreAccount();
