require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const mongoose = require("mongoose");

const connectDB = require("./config/db");
const User = require("./models/User");
const authRoutes = require("./routes/auth");

const app = express();

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Authentication API Routes
app.use("/api/auth", authRoutes);

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "*",
        methods: ["GET", "POST"]
    },
    // ⚡ Faster disconnect detection in production
    pingInterval: 10000,
    pingTimeout: 5000
});

// ==========================================
// 🎲 RANDOM CHAT / MATCHMAKING STATE
// ==========================================
// Queue of sockets waiting to be matched: [{ socketId, username, avatar, country, bio }]
let waitingQueue = [];

// Active pairs: Map<socketId, { partnerSocketId, roomId, partner: { username, avatar, country, bio } }>
const activeMatches = new Map();

/** Helper to broadcast total online count without revealing user identities */
async function broadcastOnlineCount() {
    try {
        const count = await User.countDocuments({ isOnline: true });
        io.emit("online_count", { onlineCount: count });
    } catch (error) {
        console.error("Error broadcasting online count:", error);
    }
}

/** Helper to cleanly end an active match between two users */
function endMatch(socketId, reason = "left") {
    const match = activeMatches.get(socketId);
    if (!match) return;

    const partnerSocketId = match.partnerSocketId;
    const partnerSocket = io.sockets.sockets.get(partnerSocketId);

    if (partnerSocket) {
        if (reason === "skip") {
            partnerSocket.emit("partner_left", { message: "Stranger skipped the chat." });
        } else if (reason === "disconnect") {
            partnerSocket.emit("partner_disconnected", { message: "Stranger disconnected." });
        } else {
            partnerSocket.emit("partner_left", { message: "Stranger left the chat." });
        }
        partnerSocket.leave(match.roomId);
    }

    const currentSocket = io.sockets.sockets.get(socketId);
    if (currentSocket) {
        currentSocket.leave(match.roomId);
    }

    activeMatches.delete(partnerSocketId);
    activeMatches.delete(socketId);
}

/** Helper to match a socket with a random waiting partner */
async function matchRandomUser(socket) {
    // 1. If currently in a match, leave it
    endMatch(socket.id, "skip");

    // 2. Remove socket from waiting queue if already there
    waitingQueue = waitingQueue.filter((item) => item.socketId !== socket.id);

    // 3. Find valid candidate from waiting queue
    let partner = null;
    while (waitingQueue.length > 0) {
        const candidate = waitingQueue.shift();
        // Check if candidate socket is still alive and not self
        const candidateSocket = io.sockets.sockets.get(candidate.socketId);
        if (candidateSocket && candidate.socketId !== socket.id) {
            partner = candidate;
            break;
        }
    }

    // 4. If partner found, pair them!
    if (partner) {
        const partnerSocket = io.sockets.sockets.get(partner.socketId);
        const currentUser = await User.findOne({ socketId: socket.id });

        const currentUserInfo = {
            socketId: socket.id,
            username: currentUser?.username || "Stranger",
            avatar: currentUser?.avatar || "",
            country: currentUser?.country || "",
            bio: currentUser?.bio || ""
        };

        const partnerUserInfo = {
            socketId: partner.socketId,
            username: partner.username || "Stranger",
            avatar: partner.avatar || "",
            country: partner.country || "",
            bio: partner.bio || ""
        };

        const roomId = `room_${Date.now()}_${socket.id.slice(0, 5)}_${partner.socketId.slice(0, 5)}`;

        socket.join(roomId);
        partnerSocket.join(roomId);

        activeMatches.set(socket.id, {
            partnerSocketId: partner.socketId,
            roomId,
            partner: partnerUserInfo
        });

        activeMatches.set(partner.socketId, {
            partnerSocketId: socket.id,
            roomId,
            partner: currentUserInfo
        });

        console.log(`🎲 Match created: ${currentUserInfo.username} <--> ${partnerUserInfo.username} in ${roomId}`);

        // Emit match event to both users
        socket.emit("match_found", {
            roomId,
            partner: partnerUserInfo
        });

        partnerSocket.emit("match_found", {
            roomId,
            partner: currentUserInfo
        });
    } else {
        // 5. No partner available, put this user in waiting queue
        const currentUser = await User.findOne({ socketId: socket.id });

        waitingQueue.push({
            socketId: socket.id,
            username: currentUser?.username || "Stranger",
            avatar: currentUser?.avatar || "",
            country: currentUser?.country || "",
            bio: currentUser?.bio || ""
        });

        socket.emit("waiting_for_partner", {
            message: "Looking for a random stranger to connect..."
        });
        console.log(`⏳ User (${socket.id}) added to waiting queue. Queue size: ${waitingQueue.length}`);
    }
}

// ==========================================
// 🔌 SOCKET.IO CONNECTION & EVENTS
// ==========================================
io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    // Initial connection registration
    socket.on("join", async (username) => {
        try {
            // Remove any stale connection associated with this socketId
            await User.updateMany({ socketId: socket.id }, { socketId: null, isOnline: false });

            // Upsert user and mark online
            const user = await User.findOneAndUpdate(
                { username },
                {
                    socketId: socket.id,
                    isOnline: true,
                    lastSeen: new Date()
                },
                { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
            );

            console.log(`User ${username} connected with socket ${socket.id}`);

            // Acknowledge connection without exposing other users' identities
            socket.emit("joined", {
                success: true,
                message: "Connected to chat server",
                user: {
                    username: user.username,
                    avatar: user.avatar,
                    country: user.country
                }
            });

            // Broadcast updated anonymous online count
            await broadcastOnlineCount();
        } catch (error) {
            console.error("Error on join:", error);
            socket.emit("error_message", { message: "Failed to initialize user session" });
        }
    });

    // 🎯 Trigger random matchmaking
    socket.on("find_match", async () => {
        await matchRandomUser(socket);
    });

    // ⏭️ Skip current stranger and find the next random partner
    socket.on("next_partner", async () => {
        console.log(`User ${socket.id} requested next partner`);
        await matchRandomUser(socket);
    });

    // 🛑 Cancel waiting in queue
    socket.on("cancel_search", () => {
        waitingQueue = waitingQueue.filter((item) => item.socketId !== socket.id);
        socket.emit("search_cancelled", { message: "Stopped searching for a match" });
        console.log(`User ${socket.id} cancelled search. Queue size: ${waitingQueue.length}`);
    });

    // 🚪 Leave current random chat without queueing again
    socket.on("leave_chat", () => {
        endMatch(socket.id, "left");
        socket.emit("chat_left", { message: "You left the chat." });
    });

    // 💬 Send 1-on-1 message (auto-routes to matched partner or specific receiverId)
    socket.on("send_message", (data) => {
        const match = activeMatches.get(socket.id);
        const targetSocketId = data?.receiverId || (match ? match.partnerSocketId : null);

        if (targetSocketId) {
            socket.to(targetSocketId).emit("receive_message", {
                text: data.text,
                message: data.message || data.text,
                senderId: socket.id,
                timestamp: new Date().toISOString()
            });
        } else {
            socket.emit("error_message", { message: "No active chat partner. Click Find Match first." });
        }
    });

    // ✍️ Typing indicators routed to matched partner
    socket.on("typing", (data = {}) => {
        const match = activeMatches.get(socket.id);
        const targetSocketId = data?.receiverId || (match ? match.partnerSocketId : null);
        if (targetSocketId) {
            socket.to(targetSocketId).emit("typing", { senderId: socket.id });
        }
    });

    socket.on("stop_typing", (data = {}) => {
        const match = activeMatches.get(socket.id);
        const targetSocketId = data?.receiverId || (match ? match.partnerSocketId : null);
        if (targetSocketId) {
            socket.to(targetSocketId).emit("stop_typing", { senderId: socket.id });
        }
    });

    // 📴 Handle Disconnect
    socket.on("disconnect", async () => {
        console.log("User disconnected:", socket.id);

        // 1. Remove from waiting queue if waiting
        waitingQueue = waitingQueue.filter((item) => item.socketId !== socket.id);

        // 2. End active match and inform partner
        endMatch(socket.id, "disconnect");

        // 3. Mark offline in DB
        try {
            await User.findOneAndUpdate(
                { socketId: socket.id },
                { socketId: null, isOnline: false, lastSeen: new Date() }
            );
            await broadcastOnlineCount();
        } catch (error) {
            console.error("Error updating user on disconnect:", error);
        }
    });
});

// ==========================================
// 🌐 REST API ROUTES
// ==========================================

// Basic Root Route
app.get("/", (req, res) => {
    res.send("SocketChat Random Matching Server is running");
});

// Anonymous online user count
app.get("/api/users/online", async (req, res) => {
    try {
        const count = await User.countDocuments({ isOnline: true });
        res.json({ success: true, onlineCount: count });
    } catch (error) {
        console.error("Error fetching online count:", error);
        res.status(500).json({ success: false, error: "Server error" });
    }
});

// Fetch specific user profile basic info
app.get("/api/users/profile/:username", async (req, res) => {
    try {
        const user = await User.findOne(
            { username: req.params.username },
            "username fullName email avatar bio country isOnline lastSeen createdAt"
        );
        if (!user) {
            return res.status(404).json({ success: false, error: "User not found" });
        }
        res.json({ success: true, user });
    } catch (error) {
        console.error("Error fetching user profile:", error);
        res.status(500).json({ success: false, error: "Server error" });
    }
});

// ⚡ Health check endpoint
app.get("/api/health", (req, res) => {
    const mongoState = mongoose.connection.readyState;
    const states = { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" };
    res.json({
        status: mongoState === 1 ? "ok" : "degraded",
        mongo: states[mongoState] || "unknown",
        waitingQueueLength: waitingQueue.length,
        activeMatchesCount: activeMatches.size / 2,
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
