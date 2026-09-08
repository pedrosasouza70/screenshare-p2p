if (typeof Neutralino !== 'undefined') {
    try { Neutralino.init(); } catch(e) {}
}

const SERVER_URL = (window.location.protocol.startsWith('http') && !window.location.hostname.includes('localhost') && window.location.hostname !== '127.0.0.1')
    ? window.location.origin
    : 'https://screenshare-p2p.onrender.com';

const socket = io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
});

// STUN + TURN servers for high NAT/CGNAT penetration (essential for Brazilian fiber ISPs)
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        // Free TURN relay (Metered.ca Open Relay) — fallback when STUN fails behind symmetric NAT/CGNAT
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 4
};

// Application State
const STORAGE_KEY = 'streamgrid_last_room';
const CLIENT_ID_KEY = 'streamgrid_client_id';

let clientId = '';
try {
    clientId = localStorage.getItem(CLIENT_ID_KEY);
    if (!clientId) {
        clientId = 'c_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        localStorage.setItem(CLIENT_ID_KEY, clientId);
    }
} catch(e) {
    clientId = 'c_' + Math.random().toString(36).substr(2, 9);
}

let roomId = '';
let myId = '';
let localStream = null;

// Map of remote peers: peerId -> { pc, stream, tileEl, iceCandidateQueue, isRemoteDescriptionSet }
const peers = new Map();

// DOM Elements - Room Modal & Views
const roomModal = document.getElementById('roomModal');
const roomErrorBanner = document.getElementById('roomErrorBanner');
const btnCloseRoomModal = document.getElementById('btnCloseRoomModal');
const btnCancelRoomModal = document.getElementById('btnCancelRoomModal');
const roomChoiceCancelContainer = document.getElementById('roomChoiceCancelContainer');

// Subviews
const roomViewChoice = document.getElementById('roomViewChoice');
const roomViewCreate = document.getElementById('roomViewCreate');
const roomViewJoin = document.getElementById('roomViewJoin');

// Choice View Elements
const btnChooseCreate = document.getElementById('btnChooseCreate');
const btnChooseJoin = document.getElementById('btnChooseJoin');

// Create View Elements
const inputCreateRoomId = document.getElementById('inputCreateRoomId');
const inputCreateRoomPassword = document.getElementById('inputCreateRoomPassword');
const btnRandomRoom = document.getElementById('btnRandomRoom');
const btnGenerateRandomQuick = document.getElementById('btnGenerateRandomQuick');
const btnToggleCreatePass = document.getElementById('btnToggleCreatePass');
const createRoomStatusIndicator = document.getElementById('createRoomStatusIndicator');
const btnConfirmCreate = document.getElementById('btnConfirmCreate');
const btnBackFromCreate = document.getElementById('btnBackFromCreate');

// Join View Elements
const inputJoinRoomId = document.getElementById('inputJoinRoomId');
const inputJoinRoomPassword = document.getElementById('inputJoinRoomPassword');
const btnToggleJoinPass = document.getElementById('btnToggleJoinPass');
const joinRoomStatusIndicator = document.getElementById('joinRoomStatusIndicator');
const joinPasswordHint = document.getElementById('joinPasswordHint');
const btnConfirmJoin = document.getElementById('btnConfirmJoin');
const btnBackFromJoin = document.getElementById('btnBackFromJoin');

// Header Info & Actions
const btnChangeRoom = document.getElementById('btnChangeRoom');
const displayRoomId = document.getElementById('displayRoomId');
const memberCountText = document.getElementById('memberCountText');
const btnCopyLink = document.getElementById('btnCopyLink');

let currentRoomPassword = '';

const streamGrid = document.getElementById('streamGrid');
const emptyGridPlaceholder = document.getElementById('emptyGridPlaceholder');
const activeStreamsText = document.getElementById('activeStreamsText');

const btnStartShare = document.getElementById('btnStartShare');
const btnStartShareBig = document.getElementById('btnStartShareBig');
const btnStopShare = document.getElementById('btnStopShare');

const audioGuideModal = document.getElementById('audioGuideModal');
const btnAudioGuide = document.getElementById('btnAudioGuide');
const btnCloseAudioGuide = document.getElementById('btnCloseAudioGuide');
const btnFullscreen = document.getElementById('btnFullscreen');
const btnThemeToggle = document.getElementById('btnThemeToggle');
const THEME_KEY = 'streamgrid_theme';

// Theme Management (Light / Dark)
function initTheme() {
    let savedTheme = null;
    try { savedTheme = localStorage.getItem(THEME_KEY); } catch(e) {}
    
    if (!savedTheme) {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        savedTheme = prefersDark ? 'dark' : 'light';
    }
    applyTheme(savedTheme);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch(e) {}
    
    if (btnThemeToggle) {
        if (theme === 'dark') {
            btnThemeToggle.innerHTML = '<i class="fa-solid fa-sun"></i>';
            btnThemeToggle.title = 'Mudar para Tema Claro';
        } else {
            btnThemeToggle.innerHTML = '<i class="fa-solid fa-moon"></i>';
            btnThemeToggle.title = 'Mudar para Tema Escuro';
        }
    }
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
}

if (btnThemeToggle) {
    btnThemeToggle.addEventListener('click', toggleTheme);
}
initTheme();

// Error Banner Helpers
function showRoomError(msg) {
    if (!roomErrorBanner) return;
    roomErrorBanner.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <span>${msg}</span>`;
    roomErrorBanner.style.display = 'flex';
    roomErrorBanner.hidden = false;
}

function clearRoomError() {
    if (!roomErrorBanner) return;
    roomErrorBanner.innerHTML = '';
    roomErrorBanner.style.display = 'none';
    roomErrorBanner.hidden = true;
}

// Password Visibility Toggle Helpers
function setupPasswordToggle(btn, input) {
    if (!btn || !input) return;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.innerHTML = isPassword 
            ? '<i class="fa-solid fa-eye-slash"></i>' 
            : '<i class="fa-solid fa-eye"></i>';
    });
}
setupPasswordToggle(btnToggleCreatePass, inputCreateRoomPassword);
setupPasswordToggle(btnToggleJoinPass, inputJoinRoomPassword);

// Cryptographically Secure Unique Room Generator (e.g. grid-m8kp-7x9v - 850+ billion combinations)
function generateRandomRoomId() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let code = '';
    const array = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(array);
    } else {
        for (let i = 0; i < 8; i++) array[i] = Math.floor(Math.random() * 256);
    }
    for (let i = 0; i < 8; i++) {
        code += chars[array[i] % chars.length];
    }
    return `grid-${code.slice(0, 4)}-${code.slice(4)}`;
}

// Subview Switcher
function switchRoomView(viewName) {
    clearRoomError();
    if (roomViewChoice) {
        roomViewChoice.style.display = (viewName === 'choice') ? 'block' : 'none';
        roomViewChoice.hidden = (viewName !== 'choice');
    }
    if (roomViewCreate) {
        roomViewCreate.style.display = (viewName === 'create') ? 'block' : 'none';
        roomViewCreate.hidden = (viewName !== 'create');
    }
    if (roomViewJoin) {
        roomViewJoin.style.display = (viewName === 'join') ? 'block' : 'none';
        roomViewJoin.hidden = (viewName !== 'join');
    }

    if (viewName === 'choice') {
        updateRoomModalCloseButton();
    } else if (viewName === 'create') {
        if (inputCreateRoomId && !inputCreateRoomId.value.trim()) {
            rollRandomCreateRoom();
        } else if (inputCreateRoomId) {
            checkCreateRoomStatus(inputCreateRoomId.value);
        }
        setTimeout(() => {
            if (inputCreateRoomId) {
                inputCreateRoomId.focus();
                inputCreateRoomId.select();
            }
        }, 50);
    } else if (viewName === 'join') {
        if (inputJoinRoomId) checkJoinRoomStatus(inputJoinRoomId.value);
        setTimeout(() => {
            if (inputJoinRoomId) {
                inputJoinRoomId.focus();
                if (inputJoinRoomId.value) inputJoinRoomId.select();
            }
        }, 50);
    }
}

// Real-time Room Existence Checker for Create View
let checkCreateTimeout = null;
function checkCreateRoomStatus(roomIdToCheck) {
    if (!createRoomStatusIndicator) return;
    const cleanId = (roomIdToCheck || '').trim().toLowerCase();
    if (!cleanId || cleanId.length < 3) {
        createRoomStatusIndicator.textContent = '';
        createRoomStatusIndicator.className = 'room-status-indicator';
        return;
    }

    if (socket && socket.connected) {
        socket.emit('check-room', { roomId: cleanId }, (res) => {
            if (!res) return;
            if (res.exists) {
                createRoomStatusIndicator.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Sala já existe (${res.memberCount} online)`;
                createRoomStatusIndicator.className = 'room-status-indicator active';
            } else {
                createRoomStatusIndicator.innerHTML = `<i class="fa-solid fa-sparkles"></i> Código disponível!`;
                createRoomStatusIndicator.className = 'room-status-indicator new';
            }
        });
    }
}

// Real-time Room Existence Checker for Join View
let checkJoinTimeout = null;
function checkJoinRoomStatus(roomIdToCheck) {
    if (!joinRoomStatusIndicator) return;
    const cleanId = (roomIdToCheck || '').trim().toLowerCase();
    if (!cleanId || cleanId.length < 3) {
        joinRoomStatusIndicator.textContent = '';
        joinRoomStatusIndicator.className = 'room-status-indicator';
        if (joinPasswordHint) {
            joinPasswordHint.textContent = '';
            joinPasswordHint.className = 'password-hint';
        }
        return;
    }

    if (socket && socket.connected) {
        socket.emit('check-room', { roomId: cleanId }, (res) => {
            if (!res) return;
            if (res.exists) {
                const count = res.memberCount;
                const lockBadge = res.hasPassword ? ' &bull; <i class="fa-solid fa-lock" title="Protegida por senha"></i> Com senha' : '';
                joinRoomStatusIndicator.innerHTML = `<i class="fa-solid fa-circle-check"></i> Sala ativa (${count} ${count === 1 ? 'pessoa' : 'pessoas'})${lockBadge}`;
                joinRoomStatusIndicator.className = 'room-status-indicator active';
                if (joinPasswordHint) {
                    if (res.hasPassword) {
                        joinPasswordHint.innerHTML = '<i class="fa-solid fa-lock"></i> Requer senha';
                        joinPasswordHint.className = 'password-hint required';
                    } else {
                        joinPasswordHint.innerHTML = 'Sem senha (Pública)';
                        joinPasswordHint.className = 'password-hint optional';
                    }
                }
            } else {
                joinRoomStatusIndicator.innerHTML = `<i class="fa-solid fa-circle-info"></i> Sala vazia (será criada ao entrar)`;
                joinRoomStatusIndicator.className = 'room-status-indicator new';
                if (joinPasswordHint) {
                    joinPasswordHint.innerHTML = 'Opcional (Deixe em branco p/ pública)';
                    joinPasswordHint.className = 'password-hint optional';
                }
            }
        });
    }
}

function rollRandomCreateRoom() {
    clearRoomError();
    const uniqueId = generateRandomRoomId();
    if (inputCreateRoomId) {
        inputCreateRoomId.value = uniqueId;
        checkCreateRoomStatus(uniqueId);
    }
}

// Choice View Listeners
if (btnChooseCreate) {
    btnChooseCreate.addEventListener('click', () => switchRoomView('create'));
}
if (btnChooseJoin) {
    btnChooseJoin.addEventListener('click', () => switchRoomView('join'));
}

// Create View Listeners
if (btnRandomRoom) {
    btnRandomRoom.addEventListener('click', rollRandomCreateRoom);
}
if (btnGenerateRandomQuick) {
    btnGenerateRandomQuick.addEventListener('click', rollRandomCreateRoom);
}
if (inputCreateRoomId) {
    inputCreateRoomId.addEventListener('input', () => {
        clearRoomError();
        clearTimeout(checkCreateTimeout);
        checkCreateTimeout = setTimeout(() => {
            checkCreateRoomStatus(inputCreateRoomId.value);
        }, 250);
    });
    inputCreateRoomId.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleConfirmCreate();
    });
}
if (inputCreateRoomPassword) {
    inputCreateRoomPassword.addEventListener('input', clearRoomError);
    inputCreateRoomPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleConfirmCreate();
    });
}
if (btnConfirmCreate) {
    btnConfirmCreate.addEventListener('click', handleConfirmCreate);
}
if (btnBackFromCreate) {
    btnBackFromCreate.addEventListener('click', () => switchRoomView('choice'));
}

// Join View Listeners
if (inputJoinRoomId) {
    inputJoinRoomId.addEventListener('input', () => {
        clearRoomError();
        clearTimeout(checkJoinTimeout);
        checkJoinTimeout = setTimeout(() => {
            checkJoinRoomStatus(inputJoinRoomId.value);
        }, 250);
    });
    inputJoinRoomId.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleConfirmJoin();
    });
}
if (inputJoinRoomPassword) {
    inputJoinRoomPassword.addEventListener('input', clearRoomError);
    inputJoinRoomPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleConfirmJoin();
    });
}
if (btnConfirmJoin) {
    btnConfirmJoin.addEventListener('click', handleConfirmJoin);
}
if (btnBackFromJoin) {
    btnBackFromJoin.addEventListener('click', () => switchRoomView('choice'));
}

function handleConfirmCreate() {
    clearRoomError();
    const newRoomId = (inputCreateRoomId ? inputCreateRoomId.value.trim().toLowerCase() : '') || generateRandomRoomId();
    if (inputCreateRoomId) inputCreateRoomId.value = newRoomId;
    const pass = (inputCreateRoomPassword ? inputCreateRoomPassword.value.trim() : '');
    joinRoom(newRoomId, pass);
}

function handleConfirmJoin() {
    clearRoomError();
    const newRoomId = (inputJoinRoomId ? inputJoinRoomId.value.trim().toLowerCase() : '');
    if (!newRoomId) {
        showRoomError('Por favor, informe o código da sala para entrar.');
        if (inputJoinRoomId) inputJoinRoomId.focus();
        return;
    }
    const pass = (inputJoinRoomPassword ? inputJoinRoomPassword.value.trim() : '');
    joinRoom(newRoomId, pass);
}

// Auto populate room code from URL params or localStorage
window.addEventListener('DOMContentLoaded', () => {
    initTheme();
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    const passParam = urlParams.get('pass');
    
    if (passParam) {
        if (inputCreateRoomPassword) inputCreateRoomPassword.value = passParam;
        if (inputJoinRoomPassword) inputJoinRoomPassword.value = passParam;
    }

    let savedRoom = null;
    try { savedRoom = localStorage.getItem(STORAGE_KEY); } catch(e) {}

    if (roomParam) {
        const clean = roomParam.trim().toLowerCase();
        if (inputJoinRoomId) inputJoinRoomId.value = clean;
        joinRoom(clean, passParam || '');
    } else if (savedRoom) {
        const clean = savedRoom.trim().toLowerCase();
        if (inputJoinRoomId) inputJoinRoomId.value = clean;
        joinRoom(clean);
    } else {
        openRoomModal('choice');
    }
});

function cleanupRoomState() {
    console.log('[Room] Cleaning up previous room peer connections and stream tiles...');
    
    // 1. Stop local screen share if active
    if (localStream) {
        stopScreenShare();
    }

    // 2. Terminate and cleanup all active WebRTC peer connections from old room
    for (const [peerId, peerObj] of peers.entries()) {
        try {
            if (peerObj.stream) {
                peerObj.stream.getTracks().forEach(track => track.stop());
            }
            if (peerObj.pc) {
                peerObj.pc.close();
            }
            if (peerObj.tileEl) {
                peerObj.tileEl.remove();
            }
        } catch (e) {
            console.warn('[Room] Error closing peer:', peerId, e);
        }
    }
    peers.clear();

    // 3. Remove all remote stream tiles from DOM
    const remoteTiles = streamGrid.querySelectorAll('.stream-tile:not(#localStreamTile)');
    remoteTiles.forEach(tile => tile.remove());

    // 4. Reset participant count and grid state
    updateMemberCount(1);
    updateGridState();
}

function joinRoom(targetRoomId, targetPass = '') {
    clearRoomError();
    const newRoomId = (targetRoomId || '').trim().toLowerCase() || generateRandomRoomId();
    currentRoomPassword = (targetPass || '').trim();

    // If switching rooms, close all previous connections cleanly
    if (roomId && roomId !== newRoomId) {
        cleanupRoomState();
    }

    roomId = newRoomId;

    // Persist room in localStorage
    try { localStorage.setItem(STORAGE_KEY, roomId); } catch(e) {}

    // Update browser URL query parameter if running on Web
    if (window.location.protocol.startsWith('http') && window.history.pushState) {
        try {
            const newUrl = `${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
            window.history.pushState({ path: newUrl }, '', newUrl);
        } catch(e) {}
    }

    displayRoomId.textContent = roomId;
    roomModal.style.display = 'none';
    roomModal.classList.add('hidden');
    roomModal.hidden = true;
    updateRoomModalCloseButton();

    if (socket) {
        socket.emit('join-room', { roomId, clientId, password: currentRoomPassword });
    }
}

// Room Modal Open / Close Helpers
function openRoomModal(initialView = 'choice') {
    clearRoomError();
    updateRoomModalCloseButton();
    switchRoomView(initialView);
    roomModal.style.removeProperty('display');
    roomModal.style.display = 'flex';
    roomModal.classList.remove('hidden');
    roomModal.hidden = false;
}

function updateRoomModalCloseButton() {
    const canClose = Boolean(roomId);
    if (btnCloseRoomModal) {
        btnCloseRoomModal.style.display = canClose ? 'flex' : 'none';
    }
    if (btnCancelRoomModal) {
        btnCancelRoomModal.style.display = canClose ? 'inline-flex' : 'none';
    }
    if (roomChoiceCancelContainer) {
        roomChoiceCancelContainer.style.display = canClose ? 'block' : 'none';
    }
}

function closeRoomModal() {
    if (!roomId) return; // Cannot close if not connected to any room yet
    clearRoomError();
    roomModal.style.display = 'none';
    roomModal.classList.add('hidden');
    roomModal.hidden = true;
}

if (btnCloseRoomModal) {
    btnCloseRoomModal.addEventListener('click', closeRoomModal);
}
if (btnCancelRoomModal) {
    btnCancelRoomModal.addEventListener('click', closeRoomModal);
}

// Close room modal on backdrop click if already connected to a room
roomModal.addEventListener('click', (e) => {
    if (e.target === roomModal && roomId) {
        closeRoomModal();
    }
});

// Change Room Button Handler
if (btnChangeRoom) {
    btnChangeRoom.addEventListener('click', () => {
        openRoomModal('choice');
    });
}

// Socket Lifecycle Events
socket.on('connect', () => {
    myId = socket.id;
    console.log('[Socket] Connected to server. Socket ID:', myId);
    if (roomId) {
        console.log('[Socket] Joining room on connect:', roomId);
        socket.emit('join-room', { roomId, clientId, password: currentRoomPassword });
    }
});

socket.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected from server:', reason);
});

// Authentication and Room Error Handler
socket.on('join-error', ({ error, message }) => {
    console.warn('[Auth] Join error:', error, message);
    if (error === 'invalid_password') {
        openRoomModal('join');
        if (inputJoinRoomId) inputJoinRoomId.value = roomId;
        showRoomError(message || 'Senha incorreta para esta sala.');
        if (inputJoinRoomPassword) {
            inputJoinRoomPassword.focus();
            inputJoinRoomPassword.select();
        }
    } else {
        showRoomError(message || 'Erro ao entrar na sala.');
    }
});

// Socket Events
socket.on('room-users', async ({ users, activeStreams, socketId, memberCount, hasPassword }) => {
    myId = socketId;
    console.log('[Socket] Joined room. My ID:', myId, 'Other users:', users, 'Active streams:', activeStreams);

    // Sync member count immediately for the joiner
    updateMemberCount(memberCount || (users.length + 1));

    if (hasPassword) {
        displayRoomId.innerHTML = `${roomId} <i class="fa-solid fa-lock" style="font-size:0.75rem;margin-left:4px;" title="Sala protegida por senha"></i>`;
    } else {
        displayRoomId.textContent = roomId;
    }

    // Initialize peer connections for existing users
    users.forEach(peerId => {
        getOrCreatePeerConnection(peerId);
    });

    // If I am currently sharing screen, send offer with my tracks to all peers
    if (localStream) {
        for (const [peerId, peerObj] of peers.entries()) {
            addLocalTracksToPC(peerObj.pc);
            sendOffer(peerId);
        }
    }
});

socket.on('user-joined', async ({ socketId, memberCount }) => {
    console.log('[Socket] User joined:', socketId);
    const pc = getOrCreatePeerConnection(socketId);
    updateMemberCount(memberCount);

    // Sincronização Automática (Late-Joiner Sync):
    // Se eu já estiver compartilhando a tela, envio oferta com minha transmissão ao novo usuário!
    if (localStream) {
        addLocalTracksToPC(pc);
        sendOffer(socketId);
    }
});

socket.on('user-left', ({ socketId, memberCount }) => {
    console.log('[Socket] User left:', socketId);
    removePeerConnection(socketId);
    updateMemberCount(memberCount);
});

socket.on('room-status', ({ memberCount }) => {
    updateMemberCount(memberCount);
});

function updateMemberCount(count) {
    memberCountText.textContent = `${count} ${count === 1 ? 'Participante' : 'Participantes'}`;
}

// Perfect Negotiation Offer Dispatcher (Avoids Glare / Dual-Offer collisions)
async function sendOffer(peerId) {
    const peerObj = peers.get(peerId);
    if (!peerObj || !peerObj.pc) return;
    const pc = peerObj.pc;

    try {
        peerObj.makingOffer = true;
        let offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return;
        offer = new RTCSessionDescription({
            type: offer.type,
            sdp: optimizeSDP(offer.sdp)
        });
        await pc.setLocalDescription(offer);
        socket.emit('signal', { targetId: peerId, signal: pc.localDescription });
    } catch (err) {
        console.error('[WebRTC] Error sending offer to peer:', peerId, err);
    } finally {
        peerObj.makingOffer = false;
    }
}

// Targeted WebRTC Signal Receiver with Perfect Negotiation & Candidate Queueing
socket.on('signal', async ({ senderId, signal }) => {
    const pc = getOrCreatePeerConnection(senderId);
    const peerObj = peers.get(senderId);
    if (!peerObj) return;

    try {
        if (signal.type === 'offer') {
            // Check for offer collision (glare)
            const offerCollision = Boolean(peerObj.makingOffer || pc.signalingState !== 'stable');
            peerObj.ignoreOffer = !peerObj.isPolite && offerCollision;

            if (peerObj.ignoreOffer) {
                console.warn('[WebRTC] Glare collision: Impolite peer ignoring offer from:', senderId);
                return;
            }

            if (offerCollision) {
                console.log('[WebRTC] Glare collision: Polite peer rolling back for:', senderId);
                try {
                    await pc.setLocalDescription({ type: 'rollback' });
                } catch (e) {
                    console.warn('[WebRTC] Rollback error:', e);
                }
            }

            peerObj.isRemoteDescriptionSet = false;
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            peerObj.isRemoteDescriptionSet = true;

            // Flush buffered candidates
            while (peerObj.iceCandidateQueue.length > 0) {
                const cand = peerObj.iceCandidateQueue.shift();
                try { await pc.addIceCandidate(cand); } catch(e) {}
            }

            // If I am broadcasting, ensure my tracks are attached to this peer connection
            if (localStream) {
                addLocalTracksToPC(pc);
            }

            let answer = await pc.createAnswer();
            answer = new RTCSessionDescription({
                type: answer.type,
                sdp: optimizeSDP(answer.sdp)
            });
            await pc.setLocalDescription(answer);
            socket.emit('signal', { targetId: senderId, signal: pc.localDescription });

        } else if (signal.type === 'answer') {
            if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal));
                peerObj.isRemoteDescriptionSet = true;
                // Flush buffered candidates
                while (peerObj.iceCandidateQueue.length > 0) {
                    const cand = peerObj.iceCandidateQueue.shift();
                    try { await pc.addIceCandidate(cand); } catch(e) {}
                }
            }
        } else if (signal.candidate) {
            const candidate = new RTCIceCandidate(signal.candidate);
            if (pc.remoteDescription && pc.remoteDescription.type && peerObj && peerObj.isRemoteDescriptionSet) {
                try {
                    await pc.addIceCandidate(candidate);
                } catch (err) {
                    console.warn('[WebRTC] Candidate error:', err);
                }
            } else if (peerObj) {
                // Buffer candidate until remote description is processed
                peerObj.iceCandidateQueue.push(candidate);
            }
        }
    } catch (err) {
        console.error('[WebRTC] Signal handling error:', err);
    }
});

// Broadcast Stream State Changes
socket.on('stream-state', ({ senderId, state }) => {
    if (state === 'stopped') {
        removeStreamTile(senderId);
    }
});

// PeerConnection Factory
function getOrCreatePeerConnection(peerId) {
    if (peers.has(peerId)) {
        return peers.get(peerId).pc;
    }

    console.log('[WebRTC] Initializing PeerConnection for:', peerId);
    const pc = new RTCPeerConnection(rtcConfig);

    // Polite Peer Pattern: Deterministic tie-breaker to resolve double-offer glare
    const isPolite = Boolean(myId && peerId && myId < peerId);

    const peerObj = {
        pc,
        stream: new MediaStream(),
        tileEl: null,
        iceCandidateQueue: [],
        isRemoteDescriptionSet: false,
        isPolite,
        makingOffer: false,
        ignoreOffer: false
    };
    peers.set(peerId, peerObj);

    // ICE Candidate Handler
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', {
                targetId: peerId,
                signal: { candidate: event.candidate }
            });
        }
    };

    // Remote Track Received -> Render & Paint Tile in Grid
    pc.ontrack = (event) => {
        console.log('[WebRTC] Received track from:', peerId, event.track.kind, event.track.id);

        // Remove old track of the same kind from peerObj.stream (without calling .stop() on remote tracks)
        peerObj.stream.getTracks().filter(t => t.kind === event.track.kind).forEach(oldTrack => {
            if (oldTrack.id !== event.track.id) {
                try { peerObj.stream.removeTrack(oldTrack); } catch (e) {}
            }
        });

        if (!peerObj.stream.getTracks().some(t => t.id === event.track.id)) {
            peerObj.stream.addTrack(event.track);
        }

        // Only create visual tile in grid if we actually have a video track (prevents audio-only black screens)
        const hasVideo = peerObj.stream.getVideoTracks().length > 0;
        if (!peerObj.tileEl && hasVideo) {
            peerObj.tileEl = createStreamTile(peerId, peerObj.stream, `Participante ${peerId.substr(0, 5)}`, false);
            streamGrid.appendChild(peerObj.tileEl);
        }

        if (peerObj.tileEl) {
            const videoEl = peerObj.tileEl.querySelector('video');
            if (videoEl) {
                // ALWAYS re-assign srcObject so Chromium/WebKit binds the newly arrived video decoder
                videoEl.srcObject = peerObj.stream;
                videoEl.play().catch(e => {
                    console.warn('[Playback] Autoplay blocked, playing muted for mobile:', e);
                    videoEl.muted = true;
                    videoEl.play().catch(err => console.error('[Playback] Video play failed completely:', err));
                    showTapToUnmuteBadge(peerObj.tileEl, videoEl);
                });
            }
        }

        event.track.onunmute = () => {
            console.log('[WebRTC] Track unmuted from:', peerId, event.track.kind);
            if (peerObj.tileEl) {
                const videoEl = peerObj.tileEl.querySelector('video');
                if (videoEl) {
                    videoEl.srcObject = peerObj.stream;
                    videoEl.play().catch(e => {});
                }
            }
        };

        event.track.onended = () => {
            console.log('[WebRTC] Remote track ended:', peerId, event.track.kind);
            if (event.track.kind === 'video') {
                removeStreamTile(peerId);
            }
        };

        updateGridState();
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[WebRTC] ICE state (${peerId}):`, pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            // Attempt ICE restart if needed
            if (pc.restartIce) pc.restartIce();
        }
    };

    return pc;
}


// Prioritize Hardware Accelerated H.264 Codec if present in SDP
function prioritizeH264(sdp) {
    if (!sdp || typeof sdp !== 'string') return sdp;
    const lines = sdp.split('\r\n');
    const mVideoIndex = lines.findIndex(l => l.startsWith('m=video'));
    if (mVideoIndex === -1) return sdp;

    const h264Payloads = [];
    for (const line of lines) {
        if (line.startsWith('a=rtpmap:') && line.toLowerCase().includes('h264/90000')) {
            const parts = line.split(' ')[0].split(':');
            if (parts[1]) {
                h264Payloads.push(parts[1]);
            }
        }
    }

    if (h264Payloads.length === 0) return sdp;

    const mVideoParts = lines[mVideoIndex].split(' ');
    const header = mVideoParts.slice(0, 3);
    const currentPayloads = mVideoParts.slice(3);

    const reordered = [
        ...h264Payloads.filter(pt => currentPayloads.includes(pt)),
        ...currentPayloads.filter(pt => !h264Payloads.includes(pt))
    ];

    lines[mVideoIndex] = [...header, ...reordered].join(' ');
    return lines.join('\r\n');
}

// SDP Optimization Helper (Unlocks Smooth 1080p60 Bitrate & Stereo Audio without Freezes)
function optimizeSDP(sdp) {
    sdp = prioritizeH264(sdp);
    let lines = sdp.split('\r\n');
    let newLines = [];

    for (let line of lines) {
        newLines.push(line);

        // Opus Stereo with efficient bitrate (128kbps — clear game audio without wasting bandwidth)
        if (line.startsWith('a=fmtp:') && line.includes('opus/48000')) {
            newLines[newLines.length - 1] = line + ';stereo=1;sprop-stereo=1;maxaveragebitrate=128000';
        }

        // Balanced 1080p60 Bitrate Tuning: start at 3.5 Mbps, adapt up to 6 Mbps max with 1.8 Mbps floor
        // Prevents saturation and bufferbloat when 2+ streams run concurrently on residential networks
        if (line.startsWith('a=fmtp:') && (line.toLowerCase().includes('h264') || line.toLowerCase().includes('vp8') || line.toLowerCase().includes('vp9'))) {
            if (!line.includes('x-google-max-bitrate')) {
                newLines[newLines.length - 1] = line + ';x-google-min-bitrate=1800;x-google-start-bitrate=3500;x-google-max-bitrate=6000';
            }
        }

        // 6000 Kbps max bitrate gives crystal clear 1080p 60FPS without choking multi-stream bandwidth
        if (line.startsWith('m=video')) {
            newLines.push('b=AS:6000');
            newLines.push('b=TIAS:6000000');
        }
    }
    return newLines.join('\r\n');
}

function removePeerConnection(peerId) {
    if (peers.has(peerId)) {
        const peerObj = peers.get(peerId);
        if (peerObj.stream) {
            peerObj.stream.getTracks().forEach(track => track.stop());
        }
        if (peerObj.pc) peerObj.pc.close();
        if (peerObj.tileEl) {
            const videoEl = peerObj.tileEl.querySelector('video');
            if (videoEl) videoEl.srcObject = null;
            peerObj.tileEl.remove();
        }
        peers.delete(peerId);
        updateGridState();
    }
}

function removeStreamTile(peerId) {
    if (peers.has(peerId)) {
        const peerObj = peers.get(peerId);
        if (peerObj.tileEl) {
            const videoEl = peerObj.tileEl.querySelector('video');
            if (videoEl) videoEl.srcObject = null;
            peerObj.tileEl.remove();
            peerObj.tileEl = null;
        }
        if (peerObj.stream) {
            peerObj.stream.getTracks().forEach(t => t.stop());
        }
        peerObj.stream = new MediaStream();
        updateGridState();
    }
}

function addLocalTracksToPC(pc) {
    if (!pc || !localStream) return;
    const senders = pc.getSenders();
    localStream.getTracks().forEach(track => {
        const existingSender = senders.find(s => s.track && (s.track.id === track.id || s.track.kind === track.kind));
        if (existingSender) {
            if (existingSender.track !== track) {
                try { existingSender.replaceTrack(track); } catch (e) {}
            }
            configureSenderParams(existingSender, track.kind);
        } else {
            const sender = pc.addTrack(track, localStream);
            configureSenderParams(sender, track.kind);
        }
    });
}

function configureSenderParams(sender, kind) {
    if (kind === 'video' && sender && typeof sender.getParameters === 'function') {
        try {
            const params = sender.getParameters();
            // NEVER sacrifice 1080p resolution - keep text and game pixels razor-sharp
            params.degradationPreference = 'maintain-resolution';
            if (params.encodings && params.encodings[0]) {
                params.encodings[0].maxBitrate = 6000000;
                params.encodings[0].maxFramerate = 60;
            }
            sender.setParameters(params).catch(() => {});
        } catch (e) {}
    }
}

// ========== Adaptive Bitrate Quality Monitor (getStats) ==========
let qualityMonitorInterval = null;

function startQualityMonitor() {
    if (qualityMonitorInterval) return;
    console.log('[QoS] ▶ Quality monitor started');

    qualityMonitorInterval = setInterval(async () => {
        if (!localStream) { stopQualityMonitor(); return; }

        for (const [peerId, peerObj] of peers.entries()) {
            if (!peerObj.pc || peerObj.pc.connectionState === 'closed') continue;
            try {
                const stats = await peerObj.pc.getStats();
                let availableBitrate = null;
                let qualityLimitation = 'none';
                let actualFps = 0;
                let rtt = 0;
                let bytesSent = 0;

                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        if (report.availableOutgoingBitrate != null) {
                            availableBitrate = report.availableOutgoingBitrate;
                        }
                        if (report.currentRoundTripTime != null) {
                            rtt = report.currentRoundTripTime;
                        }
                    }
                    if (report.type === 'outbound-rtp' && report.kind === 'video') {
                        actualFps = report.framesPerSecond || 0;
                        qualityLimitation = report.qualityLimitationReason || 'none';
                        bytesSent = report.bytesSent || 0;
                    }
                });

                // Only adapt if we have bandwidth data from the browser
                if (availableBitrate === null) continue;

                const videoSender = peerObj.pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (!videoSender) continue;

                const params = videoSender.getParameters();
                if (!params.encodings || !params.encodings[0]) continue;

                const current = params.encodings[0].maxBitrate || 6000000;
                let targetBitrate;

                if (availableBitrate < 1200000) {
                    // Critical: below 1.2 Mbps — emergency floor
                    targetBitrate = 800000;
                } else if (availableBitrate < 2500000) {
                    // Low: use 65% of available to leave headroom
                    targetBitrate = Math.floor(availableBitrate * 0.65);
                } else if (availableBitrate < 5000000) {
                    // Medium: use 75% of available
                    targetBitrate = Math.floor(availableBitrate * 0.75);
                } else {
                    // Good bandwidth: cap at 6 Mbps ceiling
                    targetBitrate = 6000000;
                }

                // Smooth ramp: move 30% toward target per cycle (avoids oscillation)
                const smoothed = Math.floor(current + (targetBitrate - current) * 0.3);
                const clamped = Math.max(800000, Math.min(6000000, smoothed));

                // Only apply if change is meaningful (> 100kbps difference)
                if (Math.abs(clamped - current) > 100000) {
                    params.encodings[0].maxBitrate = clamped;
                    videoSender.setParameters(params).catch(() => {});
                    console.log(
                        `[QoS] ${peerId.slice(0,6)}: ` +
                        `bitrate ${(current/1e6).toFixed(1)}→${(clamped/1e6).toFixed(1)} Mbps | ` +
                        `available: ${(availableBitrate/1e6).toFixed(1)} Mbps | ` +
                        `fps: ${actualFps} | limit: ${qualityLimitation} | ` +
                        `rtt: ${(rtt*1000).toFixed(0)}ms`
                    );
                }
            } catch (e) { /* peer may have disconnected mid-stats */ }
        }
    }, 4000); // Poll every 4 seconds
}

function stopQualityMonitor() {
    if (qualityMonitorInterval) {
        clearInterval(qualityMonitorInterval);
        qualityMonitorInterval = null;
        console.log('[QoS] ■ Quality monitor stopped');
    }
}

// Start Screen Capture
btnStartShare.addEventListener('click', startScreenShare);
btnStartShareBig.addEventListener('click', startScreenShare);

async function startScreenShare() {
    try {
        const videoConstraints = {
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
            frameRate: { ideal: 60, max: 60 }
        };

        // --- Step 1: Detect VB-Audio CABLE Output ---
        let cableOutputId = null;
        try {
            let devices = await navigator.mediaDevices.enumerateDevices();

            // If labels are empty, request mic permission to reveal device names
            const hasEmptyLabels = devices.some(d => d.deviceId && d.label === '');
            if (hasEmptyLabels) {
                console.log('[Audio] Device labels hidden, requesting mic permission...');
                try {
                    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    tempStream.getTracks().forEach(t => t.stop());
                    devices = await navigator.mediaDevices.enumerateDevices();
                } catch (permErr) {
                    console.warn('[Audio] Mic permission denied:', permErr.message);
                }
            }

            // Search for VB-Cable Output with multiple name patterns
            const cableOutput = devices.find(d => {
                if (d.kind !== 'audioinput') return false;
                const label = d.label.toLowerCase();
                return label.includes('cable output') ||
                       (label.includes('vb-audio') && label.includes('cable')) ||
                       (label.includes('virtual cable') && !label.includes('16ch'));
            });

            if (cableOutput) {
                cableOutputId = cableOutput.deviceId;
                console.log('[Audio] ✅ VB-Cable detected:', cableOutput.label);
            } else {
                // Log all audio inputs for debugging
                const audioInputs = devices.filter(d => d.kind === 'audioinput');
                console.log('[Audio] VB-Cable not found. Available audio inputs:', 
                    audioInputs.map(d => d.label || d.deviceId).join(', '));
            }
        } catch (e) {
            console.warn('[Audio] Device enumeration failed:', e);
        }

        // Also check localStorage for a saved preference
        if (!cableOutputId) {
            const savedId = localStorage.getItem('streamgrid_cable_device');
            if (savedId) {
                cableOutputId = savedId;
                console.log('[Audio] Using saved CABLE device from localStorage');
            }
        }

        // --- Step 2: Capture screen ---
        let screenStream;

        // ALWAYS capture video-only first (avoids getDisplayMedia audio bug with VB-Cable)
        // This ensures the picker only shows ONCE regardless of audio device
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: videoConstraints,
                audio: false
            });
        } catch (err) {
            if (err.name === 'NotAllowedError') return;
            throw err;
        }

        // --- Step 3: Capture audio separately ---
        let audioTrack = null;

        if (cableOutputId) {
            // VB-Cable mode: capture from CABLE Output (isolated, no Discord)
            try {
                const audioStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        deviceId: { exact: cableOutputId },
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                        channelCount: 2,
                        sampleRate: 48000
                    }
                });
                audioTrack = audioStream.getAudioTracks()[0];
                // Save device ID for next time
                localStorage.setItem('streamgrid_cable_device', cableOutputId);
                console.log('[Audio] ✅ Capturing isolated audio from VB-Cable');
            } catch (audioErr) {
                console.warn('[Audio] VB-Cable capture failed:', audioErr.message);
                // Clear saved preference if device no longer works
                localStorage.removeItem('streamgrid_cable_device');
            }
        }

        // If no VB-Cable audio, try to get system audio by re-capturing WITH audio
        // But only if we DON'T have VB-Cable as default (to avoid the picker bug)
        if (!audioTrack && !cableOutputId) {
            try {
                // Stop the video-only stream and re-capture with audio
                const videoOnlyTrack = screenStream.getVideoTracks()[0];
                const displayId = videoOnlyTrack.getSettings().displaySurface;
                screenStream.getTracks().forEach(t => t.stop());

                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: videoConstraints,
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false
                    }
                });
                // Check if we actually got audio
                if (screenStream.getAudioTracks().length > 0) {
                    audioTrack = screenStream.getAudioTracks()[0];
                    console.log('[Audio] ✅ System audio captured via getDisplayMedia');
                }
            } catch (reErr) {
                if (reErr.name === 'NotAllowedError') return;
                console.warn('[Audio] System audio fallback failed:', reErr.message);
                // Re-capture video-only as last resort
                try {
                    screenStream = await navigator.mediaDevices.getDisplayMedia({
                        video: videoConstraints,
                        audio: false
                    });
                } catch (lastErr) {
                    if (lastErr.name === 'NotAllowedError') return;
                    throw lastErr;
                }
            }
        }

        // --- Step 4: Build final stream ---
        const videoTrack = screenStream.getVideoTracks()[0];
        if (videoTrack && 'contentHint' in videoTrack) {
            videoTrack.contentHint = 'motion';
            console.log('[WebRTC] videoTrack contentHint set to "motion" for fluid 60FPS gaming');
        }

        if (audioTrack && !screenStream.getAudioTracks().includes(audioTrack)) {
            // Merge video from screen + audio from CABLE
            localStream = new MediaStream([videoTrack, audioTrack]);
        } else {
            localStream = screenStream;
        }

        // --- Step 5: Add Local Tile preview in Grid ---
        const localTile = createStreamTile('local', localStream, 'Você (Sua Tela)', true);
        localTile.id = 'localStreamTile';
        streamGrid.appendChild(localTile);

        btnStartShare.hidden = true;
        btnStopShare.hidden = false;
        updateGridState();

        // Detect user clicking native "Stop sharing" bar
        localStream.getVideoTracks()[0].onended = () => {
            stopScreenShare();
        };

        // --- Step 6: Send stream to all peers ---
        for (const [peerId, peerObj] of peers.entries()) {
            addLocalTracksToPC(peerObj.pc);
            sendOffer(peerId);
        }

        socket.emit('stream-state', { roomId, state: 'started' });
        startQualityMonitor();

        // Log audio status
        const finalAudioTracks = localStream.getAudioTracks();
        console.log(`[Capture] ✅ Sharing started | Video: yes | Audio: ${finalAudioTracks.length > 0 ? 'yes (' + finalAudioTracks[0].label + ')' : 'no'}`);

    } catch (err) {
        console.error('[Capture] Error getting display media:', err);
        if (err.name !== 'NotAllowedError') {
            alert('Não foi possível iniciar o compartilhamento: ' + err.message);
        }
    }
}


// Stop Screen Share
btnStopShare.addEventListener('click', stopScreenShare);

function stopScreenShare() {
    stopQualityMonitor();

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    // Clean up transceivers/senders across all active peer connections
    for (const [peerId, peerObj] of peers.entries()) {
        if (peerObj && peerObj.pc) {
            peerObj.pc.getSenders().forEach(sender => {
                try {
                    peerObj.pc.removeTrack(sender);
                } catch (e) {}
            });
            // Renegotiate so peers drop the remote tile cleanly
            sendOffer(peerId);
        }
    }

    const localTile = document.getElementById('localStreamTile');
    if (localTile) localTile.remove();

    btnStartShare.hidden = false;
    btnStopShare.hidden = true;
    updateGridState();

    socket.emit('stream-state', { roomId, state: 'stopped' });
}

// Create UI Stream Tile for Video Grid
function createStreamTile(id, stream, labelText, isMuted) {
    const tile = document.createElement('div');
    tile.className = 'stream-tile';
    tile.dataset.peerId = id;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.muted = isMuted; // Mute local preview to prevent acoustic feedback
    video.srcObject = stream;

    // Tile Header Badge (Live + Name)
    const headerBadge = document.createElement('div');
    headerBadge.className = 'tile-header-badge';
    headerBadge.innerHTML = `
        <span class="live-dot"></span>
        <span class="user-name">${labelText}</span>
    `;

    // Tile Controls Overlay (Mute + Volume + Fullscreen)
    const controlsOverlay = document.createElement('div');
    controlsOverlay.className = 'tile-controls-overlay';

    if (!isMuted) {
        const muteBtn = document.createElement('button');
        muteBtn.className = 'btn-icon';
        muteBtn.style.width = '32px';
        muteBtn.style.height = '32px';
        muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '1';
        slider.step = '0.05';
        slider.value = '1';

        slider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            video.volume = val;
            muteBtn.innerHTML = val === 0 ? '<i class="fa-solid fa-volume-xmark"></i>' : '<i class="fa-solid fa-volume-high"></i>';
        });

        muteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (video.volume > 0) {
                video.volume = 0;
                slider.value = '0';
                muteBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
            } else {
                video.volume = 1;
                slider.value = '1';
                muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
            }
        });

        controlsOverlay.appendChild(muteBtn);
        controlsOverlay.appendChild(slider);
    }

    const fsBtn = document.createElement('button');
    fsBtn.className = 'btn-icon';
    fsBtn.style.width = '32px';
    fsBtn.style.height = '32px';
    fsBtn.title = 'Tela Cheia';
    fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
    fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTileFullscreen(tile, video);
    });
    controlsOverlay.appendChild(fsBtn);

    // Double tap/click to fullscreen
    tile.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        toggleTileFullscreen(tile, video);
    });

    tile.appendChild(video);
    tile.appendChild(headerBadge);
    tile.appendChild(controlsOverlay);

    return tile;
}

// Universal Fullscreen Handler for Mobile & Desktop
function toggleTileFullscreen(tile, video) {
    if (!tile) return;

    // 1. If currently in pseudo-fullscreen, exit it
    if (tile.classList.contains('pseudo-fullscreen')) {
        tile.classList.remove('pseudo-fullscreen');
        const exitBtn = tile.querySelector('.btn-exit-pseudo-fs');
        if (exitBtn) exitBtn.remove();
        return;
    }

    // 2. If native document fullscreen is active, exit it
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
        return;
    }

    // 3. iOS Safari native video player fullscreen
    if (video && typeof video.webkitEnterFullscreen === 'function') {
        try {
            video.webkitEnterFullscreen();
            return;
        } catch (e) {
            console.warn('[FS] iOS webkitEnterFullscreen error, using pseudo:', e);
        }
    }

    // 4. Standard Element Fullscreen (Android Chrome, PC)
    const req = tile.requestFullscreen || tile.webkitRequestFullscreen || tile.mozRequestFullScreen || tile.msRequestFullscreen;
    if (req) {
        req.call(tile).catch(err => {
            console.warn('[FS] Native requestFullscreen rejected, falling back to pseudo:', err);
            enterPseudoFullscreen(tile);
        });
    } else {
        // 5. Fallback: Pseudo-fullscreen
        enterPseudoFullscreen(tile);
    }
}

function enterPseudoFullscreen(tile) {
    tile.classList.add('pseudo-fullscreen');
    if (!tile.querySelector('.btn-exit-pseudo-fs')) {
        const exitBtn = document.createElement('button');
        exitBtn.className = 'btn-exit-pseudo-fs';
        exitBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        exitBtn.title = 'Sair da Tela Cheia';
        exitBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            tile.classList.remove('pseudo-fullscreen');
            exitBtn.remove();
        });
        tile.appendChild(exitBtn);
    }
}

// Show Tap-to-Unmute for mobile browsers that block autoplay with sound
function showTapToUnmuteBadge(tile, video) {
    if (!tile || tile.querySelector('.tap-unmute-badge')) return;
    const badge = document.createElement('div');
    badge.className = 'tap-unmute-badge';
    badge.innerHTML = '<i class="fa-solid fa-volume-xmark"></i> Toque para ativar o som';
    badge.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(15, 18, 26, 0.9);
        color: #fff;
        padding: 10px 18px;
        border-radius: 24px;
        font-size: 0.85rem;
        font-weight: 600;
        border: 1px solid var(--border);
        box-shadow: 0 4px 18px rgba(0,0,0,0.5);
        cursor: pointer;
        z-index: 15;
    `;
    const unmute = (e) => {
        e.stopPropagation();
        video.muted = false;
        video.play().catch(() => {});
        badge.remove();
        const muteBtn = tile.querySelector('.tile-controls-overlay .btn-icon');
        if (muteBtn) muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
    };
    badge.addEventListener('click', unmute);
    tile.addEventListener('click', unmute, { once: true });
    tile.appendChild(badge);
}

// Update Grid Layout State
function updateGridState() {
    const tiles = streamGrid.querySelectorAll('.stream-tile');
    const count = tiles.length;

    emptyGridPlaceholder.hidden = (count > 0);
    activeStreamsText.textContent = `${count} ${count === 1 ? 'Transmissão Ativa' : 'Transmissões Ativas'}`;
    streamGrid.dataset.count = count;
}

// Copy Invite Link
btnCopyLink.addEventListener('click', () => {
    let inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
    if (currentRoomPassword) {
        inviteUrl += `&pass=${encodeURIComponent(currentRoomPassword)}`;
    }
    navigator.clipboard.writeText(inviteUrl).then(() => {
        const origText = btnCopyLink.innerHTML;
        btnCopyLink.innerHTML = '<i class="fa-solid fa-check"></i> Link Copiado!';
        setTimeout(() => {
            btnCopyLink.innerHTML = origText;
        }, 2000);
    }).catch(() => {
        // Fallback for mobile if clipboard API requires focus
        prompt('Copie o link abaixo:', inviteUrl);
    });
});

// Fullscreen App
btnFullscreen.addEventListener('click', () => {
    // If there is an active stream, fullscreen that stream first
    const tiles = streamGrid.querySelectorAll('.stream-tile');
    if (tiles.length > 0) {
        const firstTile = tiles[0];
        const video = firstTile.querySelector('video');
        toggleTileFullscreen(firstTile, video);
        return;
    }

    // Fallback: document fullscreen
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        const reqDocFs = document.documentElement.requestFullscreen || 
                         document.documentElement.webkitRequestFullscreen ||
                         document.documentElement.mozRequestFullScreen;
        if (reqDocFs) {
            try { reqDocFs.call(document.documentElement).catch(() => {}); } catch(e) {}
        }
    } else {
        const exitDocFs = document.exitFullscreen || document.webkitExitFullscreen;
        if (exitDocFs) {
            try { exitDocFs.call(document).catch(() => {}); } catch(e) {}
        }
    }
});

// Audio Guide Modal
btnAudioGuide.addEventListener('click', () => {
    audioGuideModal.hidden = false;
    audioGuideModal.style.display = 'flex';
});
btnCloseAudioGuide.addEventListener('click', () => {
    audioGuideModal.hidden = true;
    audioGuideModal.style.display = 'none';
});

// Close modal on outside click or ESC key
audioGuideModal.addEventListener('click', (e) => {
    if (e.target === audioGuideModal) {
        audioGuideModal.hidden = true;
        audioGuideModal.style.display = 'none';
    }
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (!roomModal.hidden && roomModal.style.display !== 'none') {
            if (roomViewChoice && roomViewChoice.style.display === 'none') {
                switchRoomView('choice');
            } else if (roomId) {
                closeRoomModal();
            }
        }
        if (!audioGuideModal.hidden && audioGuideModal.style.display !== 'none') {
            audioGuideModal.hidden = true;
            audioGuideModal.style.display = 'none';
        }
    }
});



