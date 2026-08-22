if (typeof Neutralino !== 'undefined') {
    try { Neutralino.init(); } catch(e) {}
}

const SERVER_URL = (window.location.protocol.startsWith('http') && !window.location.hostname.includes('localhost') && window.location.hostname !== '127.0.0.1')
    ? window.location.origin
    : 'https://screenshare-p2p.onrender.com';
const socket = io(SERVER_URL);


// Redundant STUN server pool for high NAT/CGNAT penetration
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
    ],
    iceCandidatePoolSize: 10
};

// Application State
const STORAGE_KEY = 'streamgrid_last_room';
let roomId = '';
let myId = '';
let localStream = null;

// Map of remote peers: peerId -> { pc, stream, tileEl, iceCandidateQueue, isRemoteDescriptionSet }
const peers = new Map();

// DOM Elements
const roomModal = document.getElementById('roomModal');
const inputRoomId = document.getElementById('inputRoomId');
const btnJoinRoom = document.getElementById('btnJoinRoom');
const btnRandomRoom = document.getElementById('btnRandomRoom');
const btnChangeRoom = document.getElementById('btnChangeRoom');
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

// Auto populate room code from URL params or localStorage
window.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    const savedRoom = localStorage.getItem(STORAGE_KEY);

    if (roomParam) {
        inputRoomId.value = roomParam.trim().toLowerCase();
        joinRoom();
    } else if (savedRoom) {
        inputRoomId.value = savedRoom.trim().toLowerCase();
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

    // Persist room in localStorage
    localStorage.setItem(STORAGE_KEY, roomId);

    // Update browser URL query parameter if running on Web
    if (window.location.protocol.startsWith('http') && window.history.pushState) {
        const newUrl = `${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
        window.history.pushState({ path: newUrl }, '', newUrl);
    }

    displayRoomId.textContent = roomId;
    roomModal.style.setProperty('display', 'none', 'important');
    roomModal.classList.add('hidden');
    roomModal.hidden = true;

    socket.emit('join-room', { roomId });
}

// Change Room Button Handler
if (btnChangeRoom) {
    btnChangeRoom.addEventListener('click', () => {
        roomModal.style.removeProperty('display');
        roomModal.style.display = 'flex';
        roomModal.classList.remove('hidden');
        roomModal.hidden = false;
        inputRoomId.focus();
        inputRoomId.select();
    });
}

// Socket Events
socket.on('room-users', async ({ users, activeStreams, socketId }) => {
    myId = socketId;
    console.log('[Socket] Connected. My ID:', myId, 'Other users:', users, 'Active streams:', activeStreams);

    // Initialize peer connections for existing users
    users.forEach(peerId => {
        getOrCreatePeerConnection(peerId);
    });

    // If I am currently sharing screen, send offer with my tracks to all peers
    if (localStream) {
        for (const [peerId, peerObj] of peers.entries()) {
            addLocalTracksToPC(peerObj.pc);
            try {
                let offer = await peerObj.pc.createOffer();
                offer = new RTCSessionDescription({
                    type: offer.type,
                    sdp: optimizeSDP(offer.sdp)
                });
                await peerObj.pc.setLocalDescription(offer);
                socket.emit('signal', { targetId: peerId, signal: peerObj.pc.localDescription });
            } catch (e) {
                console.error('[WebRTC] Error sending offer to existing peer:', e);
            }
        }
    }
});

socket.on('user-joined', async ({ socketId, memberCount }) => {
    console.log('[Socket] User joined:', socketId);
    const pc = getOrCreatePeerConnection(socketId);
    updateMemberCount(memberCount);

    // Sincronização Automática (Late-Joiner Sync):
    // Se eu já estiver compartilhando a tela, negoceio imediatamente com o novo participante!
    if (localStream) {
        addLocalTracksToPC(pc);
        try {
            let offer = await pc.createOffer();
            offer = new RTCSessionDescription({
                type: offer.type,
                sdp: optimizeSDP(offer.sdp)
            });
            await pc.setLocalDescription(offer);
            socket.emit('signal', { targetId: socketId, signal: pc.localDescription });
        } catch (e) {
            console.error('[WebRTC] Error sending late-joiner offer:', e);
        }
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

// Targeted WebRTC Signal Receiver with Candidate Queueing
socket.on('signal', async ({ senderId, signal }) => {
    const pc = getOrCreatePeerConnection(senderId);
    const peerObj = peers.get(senderId);

    try {
        if (signal.type === 'offer') {
            if (peerObj) peerObj.isRemoteDescriptionSet = false;
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            if (peerObj) {
                peerObj.isRemoteDescriptionSet = true;
                // Flush buffered candidates
                while (peerObj.iceCandidateQueue.length > 0) {
                    const cand = peerObj.iceCandidateQueue.shift();
                    try { await pc.addIceCandidate(cand); } catch(e) {}
                }
            }

            // If I am broadcasting, attach my tracks to this peer connection
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
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            if (peerObj) {
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

    const peerObj = {
        pc,
        stream: new MediaStream(),
        tileEl: null,
        iceCandidateQueue: [],
        isRemoteDescriptionSet: false
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
        console.log('[WebRTC] Received track from:', peerId, event.track.kind);
        peerObj.stream.addTrack(event.track);

        if (!peerObj.tileEl) {
            peerObj.tileEl = createStreamTile(peerId, peerObj.stream, `Participante ${peerId.substr(0, 5)}`, false);
            streamGrid.appendChild(peerObj.tileEl);
        }

        const videoEl = peerObj.tileEl.querySelector('video');
        if (videoEl) {
            videoEl.srcObject = peerObj.stream;
            videoEl.play().catch(e => console.log('[Playback] Video play request:', e));
        }

        event.track.onunmute = () => {
            if (videoEl) {
                videoEl.play().catch(e => {});
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


// SDP Optimization Helper (Unlocks 8Mbps 1080p60 Bitrate & Stereo Audio)
function optimizeSDP(sdp) {
    let lines = sdp.split('\r\n');
    let newLines = [];

    for (let line of lines) {
        newLines.push(line);
        // Opus Stereo & High Bitrate Audio (320kbps)
        if (line.startsWith('a=fmtp:') && line.includes('opus/48000')) {
            newLines[newLines.length - 1] = line + ';stereo=1;sprop-stereo=1;maxaveragebitrate=320000';
        }
        // Inject Video Bitrate Booster (8000 Kbps max bitrate for crisp 1080p 60FPS)
        if (line.startsWith('m=video')) {
            newLines.push('b=AS:8000');
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
            let offer = await peerObj.pc.createOffer();
            offer = new RTCSessionDescription({
                type: offer.type,
                sdp: optimizeSDP(offer.sdp)
            });
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

// Process Audio Isolator (WASAPI Loopback without Discord)
const isolateAudioModal = document.getElementById('isolateAudioModal');
const btnIsolateAudio = document.getElementById('btnIsolateAudio');
const btnCloseIsolateModal = document.getElementById('btnCloseIsolateModal');
const processSelect = document.getElementById('processSelect');
const btnApplyAudioIsolation = document.getElementById('btnApplyAudioIsolation');
const btnRefreshProcesses = document.getElementById('btnRefreshProcesses');
const isolatorStatusText = document.getElementById('isolatorStatusText');

let isolatedAudioContext = null;
let isolatedAudioElement = null;
let isolatedAudioTrack = null;

async function loadProcessList() {
    processSelect.innerHTML = '<option value="">Carregando janelas ativas...</option>';
    try {
        const res = await fetch('http://127.0.0.1:8989/processes', { mode: 'cors' });
        const processes = await res.json();
        processSelect.innerHTML = '';

        if (processes.length === 0) {
            processSelect.innerHTML = '<option value="">Nenhum processo com janela encontrado</option>';
            return;
        }

        // Filter and sort window titles
        processes.sort((a, b) => a.title.localeCompare(b.title));
        processes.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.pid;
            opt.textContent = `${p.title} [${p.name}.exe]`;
            processSelect.appendChild(opt);
        });
    } catch (e) {
        processSelect.innerHTML = '<option value="">Audio Isolator não está ativo localmente</option>';
        console.log('[AudioIsolator] Could not reach http://127.0.0.1:8989');
    }
}

if (btnIsolateAudio) {
    btnIsolateAudio.addEventListener('click', () => {
        isolateAudioModal.hidden = false;
        isolateAudioModal.style.display = 'flex';
        loadProcessList();
    });
}

if (btnCloseIsolateModal) {
    btnCloseIsolateModal.addEventListener('click', () => {
        isolateAudioModal.hidden = true;
        isolateAudioModal.style.display = 'none';
    });
}

if (isolateAudioModal) {
    isolateAudioModal.addEventListener('click', (e) => {
        if (e.target === isolateAudioModal) {
            isolateAudioModal.hidden = true;
            isolateAudioModal.style.display = 'none';
        }
    });
}

if (btnRefreshProcesses) {
    btnRefreshProcesses.addEventListener('click', loadProcessList);
}

if (btnApplyAudioIsolation) {
    btnApplyAudioIsolation.addEventListener('click', async () => {
        const pid = processSelect.value;
        if (!pid) return alert('Por favor, selecione um processo da lista!');

        try {
            await fetch(`http://127.0.0.1:8989/select?pid=${pid}`);
            
            // Connect to isolated audio stream
            if (!isolatedAudioContext) {
                isolatedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (isolatedAudioContext.state === 'suspended') {
                await isolatedAudioContext.resume();
            }

            if (isolatedAudioElement) {
                isolatedAudioElement.pause();
                isolatedAudioElement.src = '';
            }

            isolatedAudioElement = new Audio();
            isolatedAudioElement.crossOrigin = 'anonymous';
            isolatedAudioElement.src = `http://127.0.0.1:8989/audio.wav?t=${Date.now()}`;
            isolatedAudioElement.autoplay = true;

            const source = isolatedAudioContext.createMediaElementSource(isolatedAudioElement);
            const destination = isolatedAudioContext.createMediaStreamDestination();
            source.connect(destination);

            isolatedAudioTrack = destination.stream.getAudioTracks()[0];

            // If local screen share is currently active, replace audio track
            if (localStream) {
                const oldAudioTrack = localStream.getAudioTracks()[0];
                if (oldAudioTrack) {
                    localStream.removeTrack(oldAudioTrack);
                    oldAudioTrack.stop();
                }
                localStream.addTrack(isolatedAudioTrack);

                // Replace sender track across all active peer connections
                for (const [peerId, peerObj] of peers.entries()) {
                    const sender = peerObj.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
                    if (sender) {
                        sender.replaceTrack(isolatedAudioTrack);
                    }
                }
            }

            isolatorStatusText.style.display = 'block';
            isolatorStatusText.textContent = `Áudio isolado com sucesso para o processo PID ${pid}! Som do Discord filtrado.`;

            setTimeout(() => {
                isolateAudioModal.hidden = true;
                isolateAudioModal.style.display = 'none';
            }, 1800);

        } catch (err) {
            console.error('[AudioIsolator] Error:', err);
            alert('Não foi possível conectar ao fluxo de áudio isolado: ' + err.message);
        }
    });
}

