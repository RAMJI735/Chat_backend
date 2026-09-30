require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { Server } = require("socket.io");
const mongoose = require("mongoose");

const connectDB = require("./config/db");
const User = require("./models/User");
const Match = require("./models/matchUser");
const authRoutes = require("./routes/auth");

const app = express();

// Connect to MongoDB
connectDB();

// CORS origin configuration
const allowedOrigin = process.env.FRONTEND_URL && process.env.FRONTEND_URL !== "*"
    ? process.env.FRONTEND_URL
    : true;

// Middleware
app.use(cors({
    origin: allowedOrigin,
    credentials: true
}));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: allowedOrigin,
        credentials: true,
        methods: ["GET", "POST"]
    },
    // ⚡ Faster disconnect detection in production
    pingInterval: 10000,
    pingTimeout: 5000
});

// Provide io instance to Express app and req objects
app.set("io", io);
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Authentication API Routes
app.use("/api/auth", authRoutes);

// Helper to broadcast total online count
async function broadcastOnlineCount() {
    try {
        const count = await User.countDocuments({ isOnline: true });
        io.emit("online_count", { onlineCount: count });
    } catch (error) {
        console.error("Error broadcasting online count:", error);
    }
}

// ==========================================
// 🔌 SOCKET.IO CONNECTION & EVENTS
// ==========================================
io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    // Initial connection registration
    socket.on("join", async (data) => {
        try {
            let query = null;

            if (data && typeof data === "object") {
                if (data.userId || data._id) {
                    query = { _id: data.userId || data._id };
                } else if (data.username) {
                    query = { username: data.username };
                }
            } else if (typeof data === "string" && data.trim()) {
                const trimmed = data.trim();
                if (mongoose.Types.ObjectId.isValid(trimmed) && trimmed.length === 24) {
                    query = { $or: [{ _id: trimmed }, { username: trimmed }] };
                } else {
                    query = { username: trimmed };
                }
            }

            if (!query) {
                return socket.emit("error_message", { message: "Invalid join payload" });
            }

            // Remove any stale connection associated with this socketId
            await User.updateMany({ socketId: socket.id }, { socketId: null, isOnline: false });

            // Update user with current socketId and mark online
            let user;
            if (query._id) {
                user = await User.findByIdAndUpdate(
                    query._id,
                    { socketId: socket.id, isOnline: true, lastSeen: new Date() },
                    { returnDocument: "after" }
                );
            } else {
                user = await User.findOneAndUpdate(
                    query,
                    { socketId: socket.id, isOnline: true, lastSeen: new Date() },
                    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
                );
            }

            if (!user) {
                return socket.emit("error_message", { message: "User not found" });
            }

            socket.userId = user._id.toString();
            socket.username = user.username;

            console.log(`User ${user.username} (${user._id}) connected with socket ${socket.id}`);

            socket.emit("joined", {
                success: true,
                message: "Connected to chat server",
                user: {
                    id: user._id,
                    username: user.username,
                    avatar: user.avatar,
                    country: user.country
                }
            });

            await broadcastOnlineCount();
        } catch (error) {
            console.error("Error on join:", error);
            socket.emit("error_message", { message: "Failed to initialize user session" });
        }
    });

    // 🎯 Explicitly join a match room
    socket.on("join_match", ({ matchId }) => {
        if (matchId) {
            socket.join(String(matchId));
            console.log(`Socket ${socket.id} joined room ${matchId}`);
        }
    });

    // 🎲 Trigger random matchmaking via Socket (alternative/complement to REST /match)
    socket.on("find_match", async (data = {}) => {
        try {
            const currentUserId = socket.userId || data?.userId;
            const currentUser = currentUserId
                ? await User.findById(currentUserId)
                : await User.findOne({ socketId: socket.id });

            if (!currentUser) {
                return socket.emit("error_message", { message: "Please join with your user info first." });
            }

            // Find an online user other than self
            const availableUsers = await User.find({
                isOnline: true,
                _id: { $ne: currentUser._id },
                socketId: { $ne: null }
            }).select("username avatar socketId country");

            if (availableUsers.length === 0) {
                return socket.emit("waiting_for_partner", {
                    message: "Looking for online users to connect..."
                });
            }

            const randomIndex = Math.floor(Math.random() * availableUsers.length);
            const randomUser = availableUsers[randomIndex];

            const match = await Match.create({
                user1: currentUser._id,
                user2: randomUser._id,
                status: "connected"
            });

            const matchRoomId = match._id.toString();
            socket.join(matchRoomId);

            if (randomUser.socketId) {
                const partnerSocket = io.sockets.sockets.get(randomUser.socketId);
                if (partnerSocket) partnerSocket.join(matchRoomId);

                io.to(randomUser.socketId).emit("match_found", {
                    matchId: match._id,
                    user: {
                        _id: currentUser._id,
                        username: currentUser.username,
                        avatar: currentUser.avatar,
                        country: currentUser.country
                    }
                });
            }

            socket.emit("match_found", {
                matchId: match._id,
                user: {
                    _id: randomUser._id,
                    username: randomUser.username,
                    avatar: randomUser.avatar,
                    country: randomUser.country
                }
            });
        } catch (error) {
            console.error("Error in find_match socket:", error);
            socket.emit("error_message", { message: "Failed to find match" });
        }
    });

    // ⏭️ Skip current stranger / Next partner
    socket.on("next_partner", async (data = {}) => {
        const matchId = data?.matchId;
        if (matchId) {
            try {
                await Match.findByIdAndDelete(matchId);
                socket.to(String(matchId)).emit("partner_left", {
                    matchId,
                    message: "Stranger skipped the chat."
                });
                socket.leave(String(matchId));
            } catch (err) {
                console.error("Error deleting match on next_partner:", err);
            }
        }
    });

    // 🚪 Leave current chat / End match
    socket.on("leave_match", async (data = {}) => {
        const matchId = data?.matchId;
        if (matchId) {
            try {
                await Match.findByIdAndDelete(matchId);
                socket.to(String(matchId)).emit("partner_left", {
                    matchId,
                    message: "Stranger left the chat."
                });
                socket.leave(String(matchId));
            } catch (err) {
                console.error("Error deleting match on leave_match:", err);
            }
        }
        socket.emit("chat_left", { message: "You left the chat." });
    });

    socket.on("leave_chat", async (data = {}) => {
        const matchId = data?.matchId;
        if (matchId) {
            try {
                await Match.findByIdAndDelete(matchId);
                socket.to(String(matchId)).emit("partner_left", {
                    matchId,
                    message: "Stranger left the chat."
                });
                socket.leave(String(matchId));
            } catch (err) {
                console.error("Error deleting match on leave_chat:", err);
            }
        }
        socket.emit("chat_left", { message: "You left the chat." });
    });

    // 💬 Send 1-on-1 message (routes to match room or receiver socket)
    socket.on("send_message", (data) => {
        const messagePayload = {
            matchId: data?.matchId,
            text: data?.text || data?.message || "",
            message: data?.message || data?.text || "",
            senderId: socket.id,
            senderUserId: socket.userId,
            timestamp: new Date().toISOString()
        };

        if (data?.matchId) {
            socket.to(String(data.matchId)).emit("receive_message", messagePayload);
        } else if (data?.receiverSocketId) {
            socket.to(data.receiverSocketId).emit("receive_message", messagePayload);
        } else if (data?.receiverId) {
            socket.to(data.receiverId).emit("receive_message", messagePayload);
        } else {
            socket.emit("error_message", { message: "No active chat partner or matchId provided." });
        }
    });

    // ✍️ Typing indicators
    socket.on("typing", (data = {}) => {
        const payload = { senderId: socket.id, matchId: data?.matchId };
        if (data?.matchId) {
            socket.to(String(data.matchId)).emit("typing", payload);
        } else if (data?.receiverSocketId) {
            socket.to(data.receiverSocketId).emit("typing", payload);
        } else if (data?.receiverId) {
            socket.to(data.receiverId).emit("typing", payload);
        }
    });

    socket.on("stop_typing", (data = {}) => {
        const payload = { senderId: socket.id, matchId: data?.matchId };
        if (data?.matchId) {
            socket.to(String(data.matchId)).emit("stop_typing", payload);
        } else if (data?.receiverSocketId) {
            socket.to(data.receiverSocketId).emit("stop_typing", payload);
        } else if (data?.receiverId) {
            socket.to(data.receiverId).emit("stop_typing", payload);
        }
    });

    // 📴 Handle Disconnect
    socket.on("disconnect", async () => {
        console.log("User disconnected:", socket.id);

        try {
            const user = await User.findOneAndUpdate(
                { socketId: socket.id },
                { socketId: null, isOnline: false, lastSeen: new Date() },
                { returnDocument: "after" }
            );

            if (user) {
                // Find and delete any active match involving this user
                const activeMatch = await Match.findOneAndDelete({
                    $or: [{ user1: user._id }, { user2: user._id }]
                });

                if (activeMatch) {
                    io.to(String(activeMatch._id)).emit("partner_disconnected", {
                        matchId: activeMatch._id,
                        message: "Stranger disconnected."
                    });
                }
            }

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
app.get("/api/health", async (req, res) => {
    try {
        const mongoState = mongoose.connection.readyState;
        const states = { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" };
        const activeMatchesCount = await Match.countDocuments({ status: "connected" });
        const onlineCount = await User.countDocuments({ isOnline: true });
        res.json({
            status: mongoState === 1 ? "ok" : "degraded",
            mongo: states[mongoState] || "unknown",
            onlineUsers: onlineCount,
            activeMatchesCount,
            uptime: process.uptime()
        });
    } catch (err) {
        res.status(500).json({ status: "error", error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
