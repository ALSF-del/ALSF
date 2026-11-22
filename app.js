// =========================================================================
// INITIALISATION SUPABASE & VARIABLES GLOBALES
// =========================================================================
let sb = null;
const isConfigured = SUPABASE_URL.startsWith('http') && !SUPABASE_KEY.includes('COLLE_');

if (isConfigured) {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  document.getElementById('netStatusText').textContent = 'EN LIGNE';
} else {
  document.getElementById('netStatusText').textContent = 'CLÉS MANQUANTES';
  document.getElementById('netDot').style.background = '#ffb800';
}

let currentUser = JSON.parse(localStorage.getItem('alsf_profile') || 'null');
let membersCache = [];
let map = null;
let mapMarkers = {};
let myLat = null, myLng = null;
let currentGeoMode = 'gps';
let watchId = null;
let wakeLockSentinel = null;
let silentAudioCtx = null;

const CAT_ORDER = { 'ALPHA': 1, 'BETA': 2, 'GAMMA': 3, 'DELTA': 4 };
const CAT_LABEL = { 'ALPHA': 'ALPHA', 'BETA': 'BÊTA', 'GAMMA': 'GAMMA', 'DELTA': 'DELTA' };

function formatGrade(cat, num) {
  return `${CAT_LABEL[cat] || cat} ${num}`;
}

// =========================================================================
// NAVIGATION ENTRE ONGLETS
// =========================================================================
function switchTab(tabId, btn) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  if (btn) btn.classList.add('active');

  if (tabId === 'mapTab') {
    setTimeout(() => {
      initMap();
      map.invalidateSize();
    }, 100);
  }
  if (tabId === 'commsTab') {
    const box = document.getElementById('chatBox');
    box.scrollTop = box.scrollHeight;
  }
}

// =========================================================================
// PROFILS, CONNEXION & TRANSFERT DE COMPTE
// =========================================================================
function openAuthModal() {
  document.getElementById('authModal').classList.remove('hidden');
}

function updateProfileUI() {
  const badge = document.getElementById('currentUserBadge');
  const summary = document.getElementById('profileSummary');
  if (!currentUser) {
    badge.textContent = 'Non identifié';
    summary.innerHTML = '<em>Aucun profil actif sur ce navigateur.</em>';
    openAuthModal();
  } else {
    const g = formatGrade(currentUser.category, currentUser.rank_number);
    badge.textContent = `${currentUser.pseudo} [${g}]`;
    summary.innerHTML = `
      <div><strong>Opérateur :</strong> <span style="color:var(--green)">${currentUser.pseudo}</span></div>
      <div style="margin-top:4px;"><strong>Grade ALSF :</strong> <span class="rank-badge rank-${currentUser.category}">${g}</span></div>
      <div style="margin-top:4px; font-size:0.8rem; color:var(--text-muted);">Code : ${currentUser.invite_code || 'Fondateur'}</div>
    `;
  }
}

async function registerOrLogin() {
  const pseudo = document.getElementById('authPseudo').value.trim();
  const category = document.getElementById('authCategory').value;
  const rank_number = parseInt(document.getElementById('authRank').value, 10);
  const invite_code = document.getElementById('authInvite').value.trim();
  const errBox = document.getElementById('authError');
  errBox.textContent = '';

  if (!pseudo || rank_number < 1) {
    errBox.textContent = 'Pseudo et numéro de grade valide requis.';
    return;
  }

  if (!sb) {
    currentUser = { pseudo, category, rank_number, invite_code };
    localStorage.setItem('alsf_profile', JSON.stringify(currentUser));
    document.getElementById('authModal').classList.add('hidden');
    updateProfileUI();
    return;
  }

  const { data: existing } = await sb.from('members').select('*').eq('pseudo', pseudo).maybeSingle();
  if (existing) {
    currentUser = existing;
    localStorage.setItem('alsf_profile', JSON.stringify(currentUser));
    document.getElementById('authModal').classList.add('hidden');
    updateProfileUI();
    return;
  }

  if (membersCache.length > 0 && invite_code) {
    const { data: inv } = await sb.from('invites').select('*').eq('code', invite_code).eq('used', false).maybeSingle();
    if (!inv) {
      errBox.textContent = 'Code d\'invitation invalide ou déjà utilisé.';
      return;
    }
    await sb.from('invites').update({ used: true, used_by: pseudo }).eq('code', invite_code);
  }

  const { data, error } = await sb.from('members').insert([{ pseudo, category, rank_number, invite_code }]).select().single();
  if (error) {
    errBox.textContent = 'Ce rang exact ou ce pseudo est déjà occupé dans l\'ALSF.';
    return;
  }

  currentUser = data;
  localStorage.setItem('alsf_profile', JSON.stringify(currentUser));
  document.getElementById('authModal').classList.add('hidden');
  updateProfileUI();
  loadMembers();
}

function generateTransferLink() {
  if (!currentUser) return alert('Connecte-toi d\'abord.');
  const payload = { user: currentUser, exp: Date.now() + 10 * 60 * 1000 };
  const encoded = btoa(encodeURIComponent(JSON.stringify(payload)));
  const url = `${window.location.origin}${window.location.pathname}?transfer=${encoded}`;
  document.getElementById('transferOutput').value = url;
}

function checkTransferParam() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('transfer');
  if (!token) return;
  try {
    const decoded = JSON.parse(decodeURIComponent(atob(token)));
    if (Date.now() > decoded.exp) {
      alert('Ce lien de transfert a expiré (limite de 10 minutes dépassée).');
    } else {
      const checkCode = prompt(`Restauration du profil ${decoded.user.pseudo}.\nSaisis ton code d'invitation (ou laisse vide si aucun) :`);
      if (checkCode !== null && checkCode.trim() === (decoded.user.invite_code || '')) {
        currentUser = decoded.user;
        localStorage.setItem('alsf_profile', JSON.stringify(currentUser));
        alert(`Profil ${currentUser.pseudo} restauré avec succès !`);
      } else {
        alert('Code d\'invitation incorrect. Transfert annulé.');
      }
    }
  } catch (e) {}
  window.history.replaceState({}, document.title, window.location.pathname);
}

// =========================================================================
// CLASSEMENT & EFFECTIFS ALSF
// =========================================================================
async function loadMembers() {
  if (!sb) return;
  const { data } = await sb.from('members').select('*');
  if (!data) return;

  membersCache = data.sort((a, b) => {
    if (CAT_ORDER[a.category] !== CAT_ORDER[b.category]) {
      return CAT_ORDER[a.category] - CAT_ORDER[b.category];
    }
    return a.rank_number - b.rank_number;
  });

  document.getElementById('statTotal').textContent = membersCache.length;
  document.getElementById('statAlpha').textContent = membersCache.filter(m => m.category === 'ALPHA').length;

  const listEl = document.getElementById('rosterList');
  const adminEl = document.getElementById('adminMembersList');
  listEl.innerHTML = '';
  adminEl.innerHTML = '';

  if (membersCache.length === 0) {
    listEl.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">Aucun membre enregistré.</p>';
    return;
  }

  membersCache.forEach(m => {
    const g = formatGrade(m.category, m.rank_number);
    listEl.innerHTML += `
      <div class="member-row">
        <strong>${m.pseudo}</strong>
        <span class="rank-badge rank-${m.category}">${g}</span>
      </div>
    `;
    adminEl.innerHTML += `
      <div class="member-row">
        <div><strong>${m.pseudo}</strong> <span class="rank-badge rank-${m.category}">${g}</span></div>
        <button class="btn btn-danger btn-sm" onclick="removeMember('${m.id}', '${m.pseudo}')">Exclure</button>
      </div>
    `;
  });
}

async function addMember() {
  if (!sb) return alert('Configure d\'abord tes clés Supabase.');
  const pseudo = document.getElementById('newMemberPseudo').value.trim();
  const category = document.getElementById('newMemberCat').value;
  const rank_number = parseInt(document.getElementById('newMemberRank').value, 10);
  const fb = document.getElementById('rosterFeedback');

  if (!pseudo || rank_number < 1) {
    fb.style.color = 'var(--danger)';
    fb.textContent = 'Pseudo et numéro valide obligatoires.';
    return;
  }

  const { error } = await sb.from('members').insert([{ pseudo, category, rank_number }]);
  if (error) {
    fb.style.color = 'var(--danger)';
    fb.textContent = `Impossible : le rang ${formatGrade(category, rank_number)} ou ce pseudo est déjà pris.`;
  } else {
    fb.style.color = 'var(--green)';
    fb.textContent = `${pseudo} enregistré au rang ${formatGrade(category, rank_number)}.`;
    document.getElementById('newMemberPseudo').value = '';
    loadMembers();
  }
}

async function removeMember(id, pseudo) {
  if (!confirm(`Exclure ${pseudo} et libérer son grade ALSF ?`)) return;
  await sb.from('members').delete().eq('id', id);
  await sb.from('locations').delete().eq('pseudo', pseudo);
  loadMembers();
  loadLocations();
}
// =========================================================================
// CODES D'INVITATION (ADMIN)
// =========================================================================
async function generateInviteCode() {
  if (!sb) return;
  const code = 'ALSF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const creator = currentUser ? currentUser.pseudo : 'Commandement';
  await sb.from('invites').insert([{ code, created_by: creator }]);
  loadInvites();
}

async function loadInvites() {
  if (!sb) return;
  const { data } = await sb.from('invites').select('*').order('created_at', { ascending: false }).limit(10);
  const el = document.getElementById('invitesList');
  if (!data || data.length === 0) {
    el.innerHTML = '<small style="color:var(--text-muted);">Aucun code généré.</small>';
    return;
  }
  el.innerHTML = data.map(i => `
    <div class="member-row" style="font-size:0.8rem;">
      <strong style="color:${i.used ? 'var(--text-muted)' : 'var(--green)'};">${i.code}</strong>
      <span>${i.used ? `Utilisé par ${i.used_by}` : 'Disponible'}</span>
    </div>
  `).join('');
}

// =========================================================================
// CARTE TACTIQUE, 3 MODES GPS & SCREEN WAKE LOCK
// =========================================================================
function initMap() {
  if (map) return;
  map = L.map('map').setView([48.8566, 2.3522], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: 'ALSF Radar'
  }).addTo(map);

  map.on('click', (e) => {
    if (currentGeoMode === 'manual') {
      updateMyCoords(e.latlng.lat, e.latlng.lng, 'manual');
    }
  });

  setLocationMode('gps');
  loadLocations();
}

function setLocationMode(mode) {
  currentGeoMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.getElementById(`modeBtn-${mode}`);
  if (activeBtn) activeBtn.classList.add('active');

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  const info = document.getElementById('geoStatusInfo');

  if (mode === 'gps') {
    info.textContent = 'Mode 1 : Acquisition GPS haute précision en cours...';
    startSilentKeepAlive();
    if ('geolocation' in navigator) {
      watchId = navigator.geolocation.watchPosition(
        pos => {
          info.textContent = `GPS actif (±${Math.round(pos.coords.accuracy)} m)`;
          updateMyCoords(pos.coords.latitude, pos.coords.longitude, 'gps');
        },
        () => {
          info.textContent = 'GPS bloqué ou indisponible. Passe en mode Wi-Fi ou Manuel.';
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    }
  } else if (mode === 'wifi') {
    info.textContent = 'Mode 2 : Localisation via réseau Wi-Fi / IP en cours...';
    fetchWifiLocation();
  } else if (mode === 'manual') {
    info.textContent = 'Mode 3 : Clique sur la carte pour placer ta balise.';
  }
}

async function fetchWifiLocation() {
  const info = document.getElementById('geoStatusInfo');
  try {
    const res = await fetch('https://geojs.io');
    const data = await res.json();
    if (data.latitude && data.longitude) {
      info.textContent = `Position réseau Wi-Fi détectée (${data.city || 'Zone locale'}).`;
      updateMyCoords(parseFloat(data.latitude), parseFloat(data.longitude), 'wifi');
    }
  } catch (e) {
    info.textContent = 'Position réseau indisponible. Utilise le mode Manuel.';
  }
}

function updateMyCoords(lat, lng, mode) {
  myLat = lat;
  myLng = lng;
  if (map) map.setView([lat, lng], Math.max(map.getZoom(), 13));
  syncMyLocation(mode);
}

async function syncMyLocation(mode = currentGeoMode) {
  if (!sb || !currentUser || myLat === null || myLng === null) return;
  const is_sharing = document.getElementById('shareLocationToggle').checked;
  const grade = formatGrade(currentUser.category, currentUser.rank_number);

  await sb.from('locations').upsert({
    pseudo: currentUser.pseudo,
    grade,
    lat: myLat,
    lng: myLng,
    mode,
    is_sharing,
    updated_at: new Date().toISOString()
  });
  loadLocations();
}
async function loadLocations() {
  if (!sb) return;
  const { data } = await sb.from('locations').select('*').eq('is_sharing', true);
  if (!data) return;

  document.getElementById('statOnline').textContent = data.length;
  if (!map) return;

  Object.values(mapMarkers).forEach(m => map.removeLayer(m));
  mapMarkers = {};

  data.forEach(loc => {
    const isMe = currentUser && loc.pseudo === currentUser.pseudo;
    const color = isMe ? '#00ff88' : '#00d4ff';
    const icon = L.divIcon({
      className: 'custom-pin',
      html: `<div style="width:16px;height:16px;background:${color};border:2px solid #05080a;border-radius:50%;box-shadow:0 0 12px ${color};"></div>`,
      iconSize: [16, 16]
    });
    const marker = L.marker([loc.lat, loc.lng], { icon }).addTo(map);
    marker.bindPopup(`<strong>${loc.pseudo}</strong><br/>Grade : ${loc.grade}<br/>Mode : ${loc.mode.toUpperCase()}`);
    mapMarkers[loc.pseudo] = marker;
  });
}

async function toggleWakeLock(enable) {
  const info = document.getElementById('geoStatusInfo');
  if (enable) {
    if ('wakeLock' in navigator) {
      try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        info.textContent = 'Screen Wake Lock ACTIVÉ : l\'écran restera allumé.';
        wakeLockSentinel.addEventListener('release', () => {
          document.getElementById('wakeLockToggle').checked = false;
        });
      } catch (err) {
        info.textContent = 'Wake Lock refusé par l\'appareil.';
        document.getElementById('wakeLockToggle').checked = false;
      }
    } else {
      info.textContent = 'Screen Wake Lock non supporté par ce navigateur.';
      document.getElementById('wakeLockToggle').checked = false;
    }
  } else {
    if (wakeLockSentinel) {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    }
    info.textContent = 'Screen Wake Lock DÉSACTIVÉ.';
  }
}

function startSilentKeepAlive() {
  try {
    if (!silentAudioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      silentAudioCtx = new AudioContext();
      const oscillator = silentAudioCtx.createOscillator();
      const gainNode = silentAudioCtx.createGain();
      gainNode.gain.value = 0.0001;
      oscillator.connect(gainNode);
      gainNode.connect(silentAudioCtx.destination);
      oscillator.start();
    }
  } catch (e) {}
}

// =========================================================================
// MESSAGERIE TEMPS RÉEL
// =========================================================================
function getActiveChannel() {
  const priv = document.getElementById('privateTarget').value.trim();
  if (priv && currentUser) {
    const pair = [currentUser.pseudo.toLowerCase(), priv.toLowerCase()].sort().join('_');
    return `dm_${pair}`;
  }
  return document.getElementById('chatChannel').value;
}

async function loadMessages() {
  if (!sb) return;
  const channel = getActiveChannel();
  const { data } = await sb.from('messages').select('*').eq('channel', channel).order('created_at', { ascending: true }).limit(80);
  const box = document.getElementById('chatBox');
  if (!data) return;

  document.getElementById('statMsgs').textContent = data.length;
  box.innerHTML = data.map(m => {
    const isMine = currentUser && m.sender_pseudo === currentUser.pseudo;
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="msg-item ${isMine ? 'mine' : ''}">
        <div class="msg-meta">
          <strong>${m.sender_pseudo} [${m.sender_grade}]</strong>
          <span>${time}</span>
        </div>
        <div class="msg-text">${escapeHTML(m.content)}</div>
      </div>
    `;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

async function sendMessage(e) {
  e.preventDefault();
  if (!sb || !currentUser) return alert('Identifie-toi d\'abord.');
  const input = document.getElementById('chatInput');
  const content = input.value.trim();
  if (!content) return;

  input.value = '';
  await sb.from('messages').insert([{
    sender_pseudo: currentUser.pseudo,
    sender_grade: formatGrade(currentUser.category, currentUser.rank_number),
    channel: getActiveChannel(),
    content
  }]);
  loadMessages();
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag]));
}

// =========================================================================
// BRIEFING INTERACTIF (AIDE) & DÉMARRAGE
// =========================================================================
let currentSlide = 0;
const slides = document.querySelectorAll('.briefing-slide');

function initBriefing() {
  const dotsEl = document.getElementById('slideDots');
  dotsEl.innerHTML = '';
  slides.forEach((_, idx) => {
    const d = document.createElement('span');
    d.className = `dot ${idx === 0 ? 'active' : ''}`;
    d.onclick = () => goToSlide(idx);
    dotsEl.appendChild(d);
  });
}

function goToSlide(idx) {
  currentSlide = (idx + slides.length) % slides.length;
  slides.forEach((s, i) => s.classList.toggle('active', i === currentSlide));
  document.querySelectorAll('#slideDots .dot').forEach((d, i) => d.classList.toggle('active', i === currentSlide));
}

function changeSlide(step) {
  goToSlide(currentSlide + step);
}

function subscribeRealtime() {
  if (!sb) return;
  sb.channel('alsf-hq-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'members' }, () => loadMembers())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => loadMessages())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'locations' }, () => loadLocations())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'invites' }, () => loadInvites())
    .subscribe();
}

window.addEventListener('DOMContentLoaded', () => {
  checkTransferParam();
  updateProfileUI();
  initBriefing();
  if (sb) {
    loadMembers();
    loadMessages();
    loadLocations();
    loadInvites();
    subscribeRealtime();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
});
