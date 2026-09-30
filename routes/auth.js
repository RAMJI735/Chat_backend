const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { verifyToken } = require("../middleware/auth");
const MatchUser = require("../models/matchUser");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "socketchat_jwt_secret_key_2026_super_secure";

// Helper to sign JWT
const generateToken = (user) => {
    return jwt.sign(
        { id: user._id, username: user.username },
        JWT_SECRET,
        { expiresIn: "7d" }
    );
};

// Cookie options for secure token storage
const COOKIE_OPTIONS = {
    httpOnly: true, // Prevents client-side scripts from accessing the token
    secure: process.env.NODE_ENV === "production", // Requires HTTPS in production
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
};

// 📝 Register / Sign Up
router.post("/register", async (req, res) => {
    try {
        const { username, email, password, fullName, bio, country } = req.body;

        // Validation
        if (!username || !username.trim()) {
            return res.status(400).json({ success: false, message: "Username is required" });
        }
        const trimmedUsername = username.trim();
        if (trimmedUsername.length < 3 || trimmedUsername.length > 30) {
            return res.status(400).json({ success: false, message: "Username must be between 3 and 30 characters" });
        }
        if (!/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
            return res.status(400).json({ success: false, message: "Username can only contain letters, numbers, and underscores" });
        }

        if (!password || password.length < 6) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters long" });
        }

        if (email && email.trim()) {
            const emailRegex = /^\S+@\S+\.\S+$/;
            if (!emailRegex.test(email.trim())) {
                return res.status(400).json({ success: false, message: "Please provide a valid email address" });
            }
        }

        // Check if username already exists (case-insensitive)
        const existingUsername = await User.findOne({
            username: { $regex: new RegExp(`^${trimmedUsername}$`, "i") }
        });
        if (existingUsername) {
            return res.status(409).json({ success: false, message: "Username is already taken" });
        }

        // Check if email already exists
        if (email && email.trim()) {
            const trimmedEmail = email.trim().toLowerCase();
            const existingEmail = await User.findOne({ email: trimmedEmail });
            if (existingEmail) {
                return res.status(409).json({ success: false, message: "Email is already registered" });
            }
        }

        // Create new user
        const newUser = new User({
            username: trimmedUsername,
            email: email && email.trim() ? email.trim().toLowerCase() : undefined,
            password,
            fullName: fullName ? fullName.trim() : "",
            bio: bio ? bio.trim() : "Hey there! I am using SocketChat.",
            country: country ? country.trim() : ""
        });

        await newUser.save();

        const token = generateToken(newUser);

        // Store token in HTTP-only cookie
        res.cookie("token", token, COOKIE_OPTIONS);

        return res.status(201).json({
            success: true,
            message: "User registered successfully",
            token,
            user: {
                id: newUser._id,
                username: newUser.username,
                email: newUser.email,
                fullName: newUser.fullName,
                avatar: newUser.avatar,
                bio: newUser.bio,
                country: newUser.country
            }
        });
    } catch (error) {
        console.error("Register error:", error);
        return res.status(500).json({ success: false, message: error.message || "Server error during registration" });
    }
});

// 🔑 Login / Sign In
router.post("/login", async (req, res) => {
    try {
        const { identifier, password } = req.body;

        if (!identifier || !password) {
            return res.status(400).json({ success: false, message: "Username/Email and password are required" });
        }

        const cleanIdentifier = identifier.trim();

        // Search by username or email
        const user = await User.findOne({
            $or: [
                { username: { $regex: new RegExp(`^${cleanIdentifier}$`, "i") } },
                { email: cleanIdentifier.toLowerCase() }
            ]
        }).select("+password");

        if (!user) {
            return res.status(401).json({ success: false, message: "Invalid credentials. User not found." });
        }

        // If user was created without password (legacy guest)
        if (!user.password) {
            return res.status(400).json({
                success: false,
                message: "This account does not have a password set. Please sign up to create your account credentials."
            });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: "Invalid username/email or password" });
        }

        const token = generateToken(user);

        // Store token in HTTP-only cookie
        res.cookie("token", token, COOKIE_OPTIONS);

        return res.status(200).json({
            success: true,
            message: "Login successful",
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                fullName: user.fullName,
                avatar: user.avatar,
                bio: user.bio,
                country: user.country
            }
        });
    } catch (error) {
        console.error("Login error:", error);
        return res.status(500).json({ success: false, message: "Server error during login" });
    }
});

// 👤 Current Authenticated User Profile
router.get("/me", verifyToken, async (req, res) => {
    try {
        const user = req.user;
        return res.status(200).json({
            success: true,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                fullName: user.fullName,
                avatar: user.avatar,
                bio: user.bio,
                country: user.country,
                isOnline: user.isOnline,
                lastSeen: user.lastSeen
            }
        });
    } catch (error) {
        console.error("Get /me error:", error);
        return res.status(500).json({ success: false, message: "Server error fetching user" });
    }
});

// 🚪 Logout
router.post("/logout", verifyToken, async (req, res) => {
    try {
        if (req.user && req.user._id) {
            await User.findByIdAndUpdate(req.user._id, {
                isOnline: false,
                socketId: null,
                lastSeen: new Date()
            });
        }

        // Clear the token cookie
        res.clearCookie("token", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "lax"
        });

        return res.status(200).json({
            success: true,
            message: "Logged out successfully"
        });
    } catch (error) {
        console.error("Logout error:", error);
        return res.status(500).json({ success: false, message: "Server error during logout" });
    }
});


router.post("/match", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const io = req.app.get("io") || req.io;

        const FindOnlineUser = await User.find({
            isOnline: true,
            _id: { $ne: userId }
        }).select("username avatar socketId country");

        if (FindOnlineUser.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No online users found"
            });
        }

        const randomIndex = Math.floor(
            Math.random() * FindOnlineUser.length
        );

        const randomUser = FindOnlineUser[randomIndex];

        // Create match
        const match = await MatchUser.create({
            user1: userId,
            user2: randomUser._id,
            status: "connected"
        });

        // Current user's socket
        const currentUser = await User.findById(userId)
            .select("username avatar country socketId");

        // Join both users into the match room if sockets are connected
        if (io) {
            const matchRoomId = match._id.toString();
            if (currentUser?.socketId) {
                const currentSocket = io.sockets.sockets.get(currentUser.socketId);
                if (currentSocket) currentSocket.join(matchRoomId);
            }

            
            if (randomUser?.socketId) {
                const randomSocket = io.sockets.sockets.get(randomUser.socketId);
                if (randomSocket) randomSocket.join(matchRoomId);

                // B ko batao ki uska match mil gaya
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
        }

        return res.status(200).json({
            success: true,
            matchId: match._id,
            user: randomUser
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});
module.exports = router;

