// StreamGrid Multi-Screenshare Mesh Client

const socket = io();

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// Application State
let roomId = '';
let myId = '';
let localStream = null;

// Map of remote peers: peerId -> { pc, stream, tileEl }
const peers = new Map();

// DOM Elements
const roomModal = document.getElementById('roomModal');
const inputRoomId = document.getElementById('inputRoomId');
const btnJoinRoom = document.getElementById('btnJoinRoom');
const btnRandomRoom = document.getElementById('btnRandomRoom');
const displayRoomId = document.getElementById('displayRoomId');
const memberCountText = document.getElementById('memberCountText');
const btnCopyLink = document.getElementById('btnCopyLink');

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

// Auto populate room code from URL params
window.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
        inputRoomId.value = roomParam;
        joinRoom();
    } else {
        inputRoomId.value = generateRandomRoomId();
    }
});

btnRandomRoom.addEventListener('click', () => {
    inputRoomId.value = generateRandomRoomId();
});

function generateRandomRoomId() {
    const nouns = ['stream', 'grid', 'sala', 'duo', 'play', 'live', 'amigos'];
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    return `${randomNoun}-${randomNum}`;
}

// Join Room Handler
btnJoinRoom.addEventListener('click', joinRoom);
inputRoomId.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinRoom();
});

function joinRoom() {
    roomId = inputRoomId.value.trim().toLowerCase();
    if (!roomId) return alert('Por favor, informe um código de sala!');

    const newUrl = `${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
    window.history.pushState({ path: newUrl }, '', newUrl);

    displayRoomId.textContent = roomId;
    roomModal.style.setProperty('display', 'none', 'important');
    roomModal.classList.add('hidden');
    roomModal.hidden = true;

    socket.emit('join-room', { roomId });
}


// Socket Events
socket.on('room-users', ({ users, socketId }) => {
    myId = socketId;
    console.log('[Socket] Connected. My ID:', myId, 'Other users:', users);
    
    // Create peer connection objects for existing users
    users.forEach(peerId => {
        getOrCreatePeerConnection(peerId);
    });
});

socket.on('user-joined', ({ socketId, memberCount }) => {
    console.log('[Socket] User joined:', socketId);
    getOrCreatePeerConnection(socketId);
    updateMemberCount(memberCount);
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

// Targeted WebRTC Signal Receiver
socket.on('signal', async ({ senderId, signal }) => {
    console.log('[WebRTC] Received signal from:', senderId, signal.type || 'ICE');
    const pc = getOrCreatePeerConnection(senderId);

    try {
        if (signal.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));

            // If I am broadcasting, add my tracks to this peer connection
            if (localStream) {
                addLocalTracksToPC(pc);
            }

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('signal', { targetId: senderId, signal: pc.localDescription });

        } else if (signal.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
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

    const peerObj = {
        pc,
        stream: new MediaStream(),
        tileEl: null
    };
    peers.set(peerId, peerObj);

    // ICE Candidate
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', {
                targetId: peerId,
                signal: { candidate: event.candidate }
            });
        }
    };

    // Remote Track Received -> Render Tile in Grid
    pc.ontrack = (event) => {
        console.log('[WebRTC] Received track from:', peerId, event.track.kind);
        peerObj.stream.addTrack(event.track);

        if (!peerObj.tileEl) {
            peerObj.tileEl = createStreamTile(peerId, peerObj.stream, `Participante ${peerId.substr(0, 5)}`, false);
            streamGrid.appendChild(peerObj.tileEl);
        }
        updateGridState();
    };

    return pc;
}

function removePeerConnection(peerId) {
    if (peers.has(peerId)) {
        const peerObj = peers.get(peerId);
        if (peerObj.pc) peerObj.pc.close();
        if (peerObj.tileEl) peerObj.tileEl.remove();
        peers.delete(peerId);
        updateGridState();
    }
}

function removeStreamTile(peerId) {
    if (peers.has(peerId)) {
        const peerObj = peers.get(peerId);
        if (peerObj.tileEl) {
            peerObj.tileEl.remove();
            peerObj.tileEl = null;
        }
        peerObj.stream = new MediaStream();
        updateGridState();
    }
}

function addLocalTracksToPC(pc) {
    if (!pc || !localStream) return;
    const senders = pc.getSenders();
    localStream.getTracks().forEach(track => {
        const exists = senders.some(s => s.track && s.track.id === track.id);
        if (!exists) {
            pc.addTrack(track, localStream);
        }
    });
}

// Start Screen Capture
btnStartShare.addEventListener('click', startScreenShare);
btnStartShareBig.addEventListener('click', startScreenShare);

async function startScreenShare() {
    try {
        const constraints = {
            video: {
                width: { ideal: 1920, max: 1920 },
                height: { ideal: 1080, max: 1080 },
                frameRate: { ideal: 60, max: 60 },
                displaySurface: 'monitor'
            },
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        };

        localStream = await navigator.mediaDevices.getDisplayMedia(constraints);

        // Add Local Tile preview in Grid
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

        // Add tracks & send offer to all active peers in room
        for (const [peerId, peerObj] of peers.entries()) {
            addLocalTracksToPC(peerObj.pc);
            const offer = await peerObj.pc.createOffer();
            await peerObj.pc.setLocalDescription(offer);
            socket.emit('signal', { targetId: peerId, signal: peerObj.pc.localDescription });
        }

        socket.emit('stream-state', { roomId, state: 'started' });

    } catch (err) {
        console.error('[Capture] Error getting display media:', err);
        if (err.name !== 'NotAllowedError') {
            alert('Não foi possível iniciar o compartilhamento de tela: ' + err.message);
        }
    }
}

// Stop Screen Share
btnStopShare.addEventListener('click', stopScreenShare);

function stopScreenShare() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
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
        muteBtn.style.width = '28px';
        muteBtn.style.height = '28px';
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

        muteBtn.addEventListener('click', () => {
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
    fsBtn.style.width = '28px';
    fsBtn.style.height = '28px';
    fsBtn.title = 'Expandir Vídeo';
    fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
    fsBtn.addEventListener('click', () => {
        if (video.requestFullscreen) video.requestFullscreen();
    });
    controlsOverlay.appendChild(fsBtn);

    tile.appendChild(video);
    tile.appendChild(headerBadge);
    tile.appendChild(controlsOverlay);

    return tile;
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
    const inviteUrl = window.location.href;
    navigator.clipboard.writeText(inviteUrl).then(() => {
        const origText = btnCopyLink.innerHTML;
        btnCopyLink.innerHTML = '<i class="fa-solid fa-check"></i> Copiado!';
        setTimeout(() => {
            btnCopyLink.innerHTML = origText;
        }, 2000);
    });
});

// Fullscreen App
btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
    } else {
        if (document.exitFullscreen) document.exitFullscreen();
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
audioGuideModal.addEventListener('click', (e) => {
    if (e.target === audioGuideModal) {
        audioGuideModal.hidden = true;
        audioGuideModal.style.display = 'none';
    }
});
