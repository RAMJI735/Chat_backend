require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const mongoose = require("mongoose");
const User = require("./models/User");

const app = express();
app.use(cors());
const server = http.createServer(app);

mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/socketchat")
    .then(() => console.log("Connected to MongoDB"))
    .catch((err) => console.error("MongoDB connection error:", err));

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    // ⚡ Faster disconnect detection in production
    pingInterval: 10000,
    pingTimeout: 5000
});

/** Helper to fetch all online users */
async function getAllOnlineUsers() {
    try {
        const allUsers = await User.find({}, 'username socketId -_id');
        return allUsers.map(u => ({ username: u.username, socketId: u.socketId }));
    } catch (error) {
        console.error("Error fetching online users:", error);
        return [];
    }
}

io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    socket.on("join", async (username) => {
        try {
            // 🔥 Clean up: remove ALL stale entries for this username (e.g., from old/reconnected sockets)
            await User.deleteMany({ username });
            // Also remove any leftover entry with this exact socketId
            await User.deleteOne({ socketId: socket.id });

            const newUser = new User({
                username,
                socketId: socket.id
            });
            await newUser.save();
            console.log(`User ${username} (${socket.id}) saved to DB`);

            // ✅ Fetch fresh users list and send to the newly joined user
            const users = await getAllOnlineUsers();
            socket.emit("online_users", users);

            // Notify others that a new user is online
            socket.broadcast.emit("user_online", {
                username,
                socketId: socket.id
            });
        } catch (error) {
            console.error("Error saving user:", error);
            // ⚠️ Even on error, send an empty list so the client doesn't hang forever
            socket.emit("online_users", []);
        }
    });

    socket.on("send_message", (data) => {
        socket.to(data.receiverId).emit("receive_message", data);
    });

    socket.on("typing", (data) => {
        socket.to(data.receiverId).emit("typing", data);
    });

    socket.on("stop_typing", (data) => {
        socket.to(data.receiverId).emit("stop_typing", data);
    });

    socket.on("disconnect", async () => {
        console.log("User disconnected:", socket.id);
        try {
            const user = await User.findOne({ socketId: socket.id });
            if (user) {
                await User.deleteOne({ socketId: socket.id });
                socket.broadcast.emit("user_offline", { username: user.username, socketId: socket.id });
                console.log(`User ${user.username} removed from DB`);
            }
        } catch (error) {
            console.error("Error deleting user on disconnect:", error);
        }
    });
});

app.get("/", (req, res) => {
    res.send("SocketChat server is running")
});

app.get("/api/users/online", async (req, res) => {
    try {
        const users = await getAllOnlineUsers();
        res.json(users);
    } catch (error) {
        console.error("Error fetching online users:", error);
        res.status(500).json({ error: "Server error" });
    }
});

// ⚡ Health check endpoint for production monitoring
app.get("/api/health", (req, res) => {
    const mongoState = mongoose.connection.readyState;
    const states = { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" };
    res.json({
        status: mongoState === 1 ? "ok" : "degraded",
        mongo: states[mongoState] || "unknown",
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
