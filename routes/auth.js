const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { verifyToken } = require("../middleware/auth");

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
router.post("/logout", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            const token = authHeader.split(" ")[1];
            try {
                const decoded = jwt.verify(
                    token,
                    process.env.JWT_SECRET || "socketchat_jwt_secret_key_2026_super_secure"
                );
                if (decoded && decoded.id) {
                    await User.findByIdAndUpdate(decoded.id, {
                        isOnline: false,
                        socketId: null,
                        lastSeen: new Date()
                    });
                }
            } catch (err) {
                // If token is expired or invalid, still allow client logout to succeed
            }
        }

        return res.status(200).json({
            success: true,
            message: "Logged out successfully"
        });
    } catch (error) {
        console.error("Logout error:", error);
        return res.status(500).json({ success: false, message: "Server error during logout" });
    }
});

module.exports = router;

