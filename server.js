const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback route to ensure index.html is always served
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});



// Store active rooms and members
const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`[+] Client connected: ${socket.id}`);

    socket.on('join-room', ({ roomId }) => {
        const cleanRoomId = (roomId || '').trim().toLowerCase();
        if (!cleanRoomId) return;

        let room = rooms.get(cleanRoomId);

        if (!room) {
            room = {
                members: new Set(),
                activeStreams: new Set()
            };
            rooms.set(cleanRoomId, room);
        }

        // Leave any previous room
        if (socket.roomId && socket.roomId !== cleanRoomId) {
            leaveCurrentRoom(socket);
        }

        socket.join(cleanRoomId);
        socket.roomId = cleanRoomId;
        room.members.add(socket.id);

        const otherUsers = Array.from(room.members).filter(id => id !== socket.id);
        const activeStreams = Array.from(room.activeStreams).filter(id => id !== socket.id);

        console.log(`[->] Socket ${socket.id} joined room "${cleanRoomId}" (Members: ${room.members.size})`);

        // Send existing room members and active streamers to new user
        socket.emit('room-users', {
            users: otherUsers,
            activeStreams: activeStreams,
            socketId: socket.id
        });

        // Notify existing members about new user
        socket.to(cleanRoomId).emit('user-joined', {
            socketId: socket.id,
            memberCount: room.members.size
        });

        // Broadcast updated room member count
        io.to(cleanRoomId).emit('room-status', {
            memberCount: room.members.size
        });
    });

    // Targeted WebRTC Signal Relay (Peer-to-Peer Mesh)
    socket.on('signal', ({ targetId, signal }) => {
        if (!targetId || !signal) return;
        io.to(targetId).emit('signal', {
            senderId: socket.id,
            signal
        });
    });

    // Broadcast stream state changes (started/stopped screen share)
    socket.on('stream-state', ({ roomId, state }) => {
        const cleanRoomId = (roomId || socket.roomId || '').trim().toLowerCase();
        const room = rooms.get(cleanRoomId);
        if (room) {
            if (state === 'started') {
                room.activeStreams.add(socket.id);
            } else {
                room.activeStreams.delete(socket.id);
            }
        }
        socket.to(cleanRoomId).emit('stream-state', {
            senderId: socket.id,
            state
        });
    });

    function leaveCurrentRoom(sock) {
        const rid = sock.roomId;
        if (rid && rooms.has(rid)) {
            const r = rooms.get(rid);
            r.members.delete(sock.id);
            r.activeStreams.delete(sock.id);

            if (r.members.size === 0) {
                rooms.delete(rid);
                console.log(`[x] Room "${rid}" deleted (empty)`);
            } else {
                io.to(rid).emit('user-left', {
                    socketId: sock.id,
                    memberCount: r.members.size
                });
                io.to(rid).emit('room-status', {
                    memberCount: r.members.size
                });
            }
            sock.leave(rid);
            sock.roomId = null;
        }
    }

    socket.on('disconnect', () => {
        console.log(`[-] Client disconnected: ${socket.id}`);
        leaveCurrentRoom(socket);
    });

});

// Utility to get local network IP
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    const localIp = getLocalIp();
    console.log(`\n==================================================`);
    console.log(`  🖥️ StreamGrid Multi-Screenshare rodando!`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Rede:    http://${localIp}:${PORT}`);
    console.log(`==================================================\n`);

    // Auto-start Windows Process Audio Isolator if running locally on Windows
    if (process.platform === 'win32') {
        const { spawn } = require('child_process');
        const fs = require('fs');
        const isolatorPath = path.join(__dirname, 'extensions', 'audio-isolator', 'ProcessAudioCapture.exe');
        if (fs.existsSync(isolatorPath)) {
            try {
                const p = spawn(isolatorPath, [], { detached: true, stdio: 'ignore' });
                p.unref();
                console.log(`  🎙️ Process Audio Isolator ativo em http://127.0.0.1:8989/`);
            } catch(e) {
                console.log(`  ⚠️ Audio Isolator log:`, e.message);
            }
        }
    }
});

