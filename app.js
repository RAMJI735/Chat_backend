require("dotenv").config();
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// This map will store the socket ID of each user { username: socketId }
const OnlineUsers = new Map();

io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    // Join a room based on user ID or some identifier if needed
    socket.on("join", (username) => {
        OnlineUsers.set(socket.id, username);
        console.log("Online users: ", OnlineUsers);
        console.log(`User ${username} (${socket.id}) joined`);

        const users = Array.from(OnlineUsers, ([socketId, username]) => ({
            username,
            socketId
        }));

        // Sirf naye user ko bhejo (self)
        socket.emit("online_users", users);

        // Baaki sabko batao ki naya user online aaya (others)
        socket.broadcast.emit("user_online", {
            username,
            socketId: socket.id
        });
    });

    socket.on("send_message", (data) => {
        console.log("Message received:", data);
        // Broadcast the message to all clients
        // socket.broadcast.emit("receive_message", data);
        socket.to(data.receiverId).emit("receive_message", data);
    });

    socket.on("typing", (data) => {
        socket.to(data.receiverId).emit("typing", data);
    });

    socket.on("stop_typing", (data) => {
        socket.to(data.receiverId).emit("stop_typing", data);
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
        if (OnlineUsers.has(socket.id)) {
            const username = OnlineUsers.get(socket.id);
            OnlineUsers.delete(socket.id);
            socket.broadcast.emit("user_offline", { username, socketId: socket.id });
        }
        console.log("Online users: ", OnlineUsers);
    });
});



app.get("/", (req, res) => {
    res.send("hello")
})

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
