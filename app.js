require("dotenv").config();
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const mongoose = require("mongoose");
const User = require("./models/User");

const app = express();
const server = http.createServer(app);

mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/socketchat")
    .then(() => console.log("Connected to MongoDB"))
    .catch((err) => console.error("MongoDB connection error:", err));

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    // Join a room based on user ID or some identifier if needed
    socket.on("join", async (username) => {
        try {
            // Delete if somehow this socketId already exists to prevent duplicate key errors
            await User.deleteOne({ socketId: socket.id });

            const newUser = new User({
                username,
                socketId: socket.id
            });
            await newUser.save();
            console.log(`User ${username} (${socket.id}) saved to DB`);

            const allUsers = await User.find({}, 'username socketId -_id');
            const users = allUsers.map(u => ({ username: u.username, socketId: u.socketId }));

            // Sirf naye user ko bhejo (self)
            socket.emit("online_users", users);

            // Baaki sabko batao ki naya user online aaya (others)
            socket.broadcast.emit("user_online", {
                username,
                socketId: socket.id
            });
        } catch (error) {
            console.error("Error saving user:", error);
        }
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
    res.send("hello")
})

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
