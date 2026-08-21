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

// Explicit route for presentation slides
app.get('/slides', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'slides.html'));
});

// Fallback route to ensure index.html is always served
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Store active rooms and members
const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`[+] Client connected: ${socket.id}`);

    socket.on('join-room', ({ roomId }) => {
        let room = rooms.get(roomId);

        if (!room) {
            room = new Set();
            rooms.set(roomId, room);
        }

        socket.join(roomId);
        socket.roomId = roomId;
        room.add(socket.id);

        const otherUsers = Array.from(room).filter(id => id !== socket.id);

        console.log(`[->] Socket ${socket.id} joined room "${roomId}" (Total: ${room.size})`);

        // Send existing room members to new user
        socket.emit('room-users', {
            users: otherUsers,
            socketId: socket.id
        });

        // Notify existing members about new user
        socket.to(roomId).emit('user-joined', {
            socketId: socket.id,
            memberCount: room.size
        });

        // Broadcast updated room member count
        io.to(roomId).emit('room-status', {
            memberCount: room.size
        });
    });

    // Targeted WebRTC Signal Relay (Peer-to-Peer Mesh)
    socket.on('signal', ({ targetId, signal }) => {
        io.to(targetId).emit('signal', {
            senderId: socket.id,
            signal
        });
    });

    // Broadcast stream state changes (started/stopped screen share)
    socket.on('stream-state', ({ roomId, state }) => {
        socket.to(roomId).emit('stream-state', {
            senderId: socket.id,
            state
        });
    });

    socket.on('disconnect', () => {
        console.log(`[-] Client disconnected: ${socket.id}`);
        const roomId = socket.roomId;
        if (roomId && rooms.has(roomId)) {
            const room = rooms.get(roomId);
            room.delete(socket.id);

            if (room.size === 0) {
                rooms.delete(roomId);
                console.log(`[x] Room "${roomId}" deleted (empty)`);
            } else {
                io.to(roomId).emit('user-left', {
                    socketId: socket.id,
                    memberCount: room.size
                });
                io.to(roomId).emit('room-status', {
                    memberCount: room.size
                });
            }
        }
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
});
